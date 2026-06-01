import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { app } from 'electron';
import { Logger } from '../core/logger';
import { AppSettingsService } from '../services/app-settings-service';
import { SENSEVOICE_MODELS, findSenseVoiceModel } from './sensevoice-models';

// SenseVoice is a single-file CTC model. Unlike a raw onnxruntime session, the
// sherpa-onnx OfflineRecognizer handles the full pipeline SenseVoice needs:
// 80-dim fbank feature extraction, CMVN, the SenseVoice-specific input tensors
// (features / lengths / language / text-norm) and CTC token-id → text decoding
// via tokens.txt. We reuse the exact native-module loading approach that the
// Parakeet path (sherpa-onnx-transcriber.ts) already ships with.
let sherpa: any = null;

function getSherpaOnnx(): any {
  if (sherpa) return sherpa;

  const isPackaged = app.isPackaged;
  const appPath = app.getAppPath();

  let baseNodeModules: string;
  if (isPackaged) {
    // Packaged: native modules live in app.asar.unpacked/node_modules
    baseNodeModules = path.join(appPath + '.unpacked', 'node_modules');
  } else {
    // Dev: dist/node_modules relative to the compiled file
    baseNodeModules = path.join(__dirname, 'node_modules');
  }

  const arch = process.arch; // arm64 | x64
  const sherpaLibPath = path.join(baseNodeModules, `sherpa-onnx-darwin-${arch}`);

  Logger.info(`🎤 [SenseVoice] Module resolution base: ${baseNodeModules}`);

  if (fs.existsSync(sherpaLibPath)) {
    const existingPath = process.env.DYLD_LIBRARY_PATH || '';
    process.env.DYLD_LIBRARY_PATH = sherpaLibPath + (existingPath ? ':' + existingPath : '');
  } else {
    Logger.warning(`⚠️ [SenseVoice] Native library path not found: ${sherpaLibPath}`);
  }

  // @ts-ignore - accessing internal Node.js module API to prepend the
  // native-module search path, matching sherpa-onnx-transcriber.
  const Module = require('module');
  const originalPaths = Module._nodeModulePaths;
  Module._nodeModulePaths = function (from: string) {
    return [baseNodeModules].concat(originalPaths.call(this, from));
  };

  try {
    const nodeRequire = typeof __non_webpack_require__ !== 'undefined'
      ? __non_webpack_require__
      : require;
    sherpa = nodeRequire('sherpa-onnx-node');
    Logger.info('🎤 [SenseVoice] Loaded sherpa-onnx-node');
  } catch (error) {
    Logger.error('🎤 [SenseVoice] Failed to load sherpa-onnx-node:', error);
    throw error;
  } finally {
    Module._nodeModulePaths = originalPaths;
  }

  return sherpa;
}

declare const __non_webpack_require__: NodeRequire | undefined;

// Idle socket timeout — abort if the CDN stops sending chunks so a stalled
// connection can't hang the download forever (mirrors SherpaModelDownloader).
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

// Strip SenseVoice meta tokens (<|en|>, <|EMO_UNKNOWN|>, <|Speech|>, <|woitn|>
// …) in case a build surfaces them in the decoded text. Sherpa normally
// removes them, but be defensive so users never see raw tags.
function stripSenseVoiceTags(text: string): string {
  return text.replace(/<\|[^|]*\|>/g, '').replace(/\s+/g, ' ').trim();
}

export class SenseVoiceTranscriber {
  private static instance: SenseVoiceTranscriber;
  private recognizer: any = null;
  private currentModelId: string | null = null;

  public static getInstance(): SenseVoiceTranscriber {
    if (!SenseVoiceTranscriber.instance) {
      SenseVoiceTranscriber.instance = new SenseVoiceTranscriber();
    }
    return SenseVoiceTranscriber.instance;
  }

  private constructor() {}

  // ── Model files on disk ───────────────────────────────────────────────
  private getModelDir(modelId: string): string {
    return path.join(app.getPath('userData'), 'sensevoice-models', modelId);
  }

  private getModelPaths(modelId: string): { modelPath: string; tokensPath: string } | null {
    const dir = this.getModelDir(modelId);
    const modelPath = path.join(dir, 'model.int8.onnx');
    const tokensPath = path.join(dir, 'tokens.txt');
    if (fs.existsSync(modelPath) && fs.existsSync(tokensPath)) {
      return { modelPath, tokensPath };
    }
    return null;
  }

  public isModelDownloaded(modelId: string): boolean {
    return this.getModelPaths(modelId) !== null;
  }

  // ── Download (model.int8.onnx + tokens.txt) ───────────────────────────
  public async downloadModel(
    modelId: string,
    onProgress?: (percent: number, downloadedMB: number, totalMB: number) => void
  ): Promise<boolean> {
    const model = findSenseVoiceModel(modelId);
    if (!model) {
      Logger.error(`🎤 [SenseVoice] Unknown model: ${modelId}`);
      return false;
    }

    const dir = this.getModelDir(modelId);
    fs.mkdirSync(dir, { recursive: true });

    const targets = [
      { url: model.modelUrl, name: 'model.int8.onnx', major: true },
      { url: model.tokensUrl, name: 'tokens.txt', major: false }
    ];

    for (const t of targets) {
      const dest = path.join(dir, t.name);
      if (fs.existsSync(dest)) continue;
      Logger.info(`🎤 [SenseVoice] Downloading ${t.name}...`);
      // Only the large model file drives the progress bar; tokens.txt is tiny.
      const ok = await this.downloadFile(t.url, dest, t.major ? onProgress : undefined);
      if (!ok) {
        Logger.error(`🎤 [SenseVoice] Failed to download ${t.name}`);
        return false;
      }
    }

    Logger.success(`🎤 [SenseVoice] Model ${modelId} ready`);
    return true;
  }

  // Streaming download to a temp file, following HF's 302 → CDN redirects.
  // Streams straight to disk so a 250MB model never sits fully in memory.
  private downloadFile(
    url: string,
    destPath: string,
    onProgress?: (percent: number, downloadedMB: number, totalMB: number) => void
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const tempPath = destPath + '.download';
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* best-effort */ }
      const file = fs.createWriteStream(tempPath);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try { file.end(); } catch { /* */ }
        if (!ok) {
          try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* */ }
        }
        resolve(ok);
      };

      const go = (currentUrl: string, redirects = 0) => {
        if (redirects > 5) {
          Logger.error(`🎤 [SenseVoice] Too many redirects for ${url}`);
          finish(false);
          return;
        }

        const lib = currentUrl.startsWith('https') ? https : http;
        const request = lib.get(currentUrl, (response) => {
          if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
            const loc = response.headers.location;
            if (loc) {
              const next = loc.startsWith('http') ? loc : new URL(loc, currentUrl).toString();
              response.resume(); // drain the redirect body
              go(next, redirects + 1);
              return;
            }
          }

          if (response.statusCode !== 200) {
            Logger.error(`🎤 [SenseVoice] Download failed, status ${response.statusCode}`);
            finish(false);
            return;
          }

          const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
          let downloaded = 0;

          response.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            file.write(chunk);
            if (onProgress && totalBytes > 0) {
              const percent = Math.round((downloaded / totalBytes) * 100);
              onProgress(percent, +(downloaded / 1048576).toFixed(1), +(totalBytes / 1048576).toFixed(1));
            }
          });

          response.on('end', () => {
            if (totalBytes > 0 && downloaded < totalBytes) {
              Logger.error(`🎤 [SenseVoice] Short read: ${downloaded}/${totalBytes} bytes`);
              finish(false);
              return;
            }
            file.end();
            setTimeout(() => {
              try {
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                fs.renameSync(tempPath, destPath);
                resolve(true);
              } catch (err) {
                Logger.error(`🎤 [SenseVoice] Failed to save ${destPath}:`, err);
                finish(false);
              }
            }, 200);
          });

          response.on('error', (err) => {
            Logger.error('🎤 [SenseVoice] Stream error:', err);
            finish(false);
          });
        });

        request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
          Logger.error(`🎤 [SenseVoice] Download stalled for ${currentUrl}`);
          request.destroy(new Error('download idle timeout'));
        });

        request.on('error', (err) => {
          Logger.error('🎤 [SenseVoice] Request error:', err);
          finish(false);
        });
      };

      go(url);
    });
  }

  // ── Recognizer lifecycle ──────────────────────────────────────────────
  private initRecognizer(modelId: string): boolean {
    if (this.recognizer && this.currentModelId === modelId) {
      return true;
    }
    // Switching models — drop the old recognizer.
    if (this.recognizer && this.currentModelId !== modelId) {
      this.dispose();
    }

    const paths = this.getModelPaths(modelId);
    if (!paths) {
      Logger.error(`🎤 [SenseVoice] Model files not found for ${modelId}`);
      return false;
    }

    const cores = require('os').cpus().length || 4;
    const threadCount = Math.max(2, Math.min(6, Math.floor(cores / 2)));

    const platform = process.platform;
    const platformPreferred =
      platform === 'darwin' ? 'coreml' :
      platform === 'linux' || platform === 'win32' ? 'xnnpack' :
      'cpu';

    const buildConfig = (provider: string) => ({
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig: {
        senseVoice: {
          model: paths.modelPath,
          // 'auto' lets SenseVoice detect language; it also emits emotion/event
          // tags which we strip from the final text.
          language: 'auto',
          // Inverse text normalization → "twenty twenty four" → "2024" etc.
          useInverseTextNormalization: 1,
        },
        tokens: paths.tokensPath,
        numThreads: threadCount,
        provider,
        debug: false,
      },
    });

    const sherpaModule = getSherpaOnnx();

    // CoreML first on Apple Silicon for ANE speed, fall back to CPU.
    for (const provider of [platformPreferred, 'cpu']) {
      try {
        Logger.info(`🎤 [SenseVoice] Initializing recognizer (${provider}, ${threadCount} threads) for ${modelId}`);
        this.recognizer = new sherpaModule.OfflineRecognizer(buildConfig(provider));
        this.currentModelId = modelId;
        Logger.success(`🎤 [SenseVoice] Recognizer ready via ${provider}`);
        return true;
      } catch (error) {
        Logger.warning(`🎤 [SenseVoice] Init via ${provider} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (provider === 'cpu') {
          Logger.error('🎤 [SenseVoice] All providers exhausted');
          this.recognizer = null;
          this.currentModelId = null;
          return false;
        }
      }
    }
    return false;
  }

  // ── Audio conversion ──────────────────────────────────────────────────
  // PCM 16-bit mono → Float32 in [-1, 1]. SenseVoice expects 16kHz; the
  // capture pipeline already delivers 16k mono PCM (same as the Parakeet path).
  private pcm16ToFloat32(audioBuffer: Buffer): Float32Array | null {
    if (!audioBuffer || audioBuffer.length < 2) return null;
    const alignedLength = audioBuffer.length - (audioBuffer.length % 2);
    if (alignedLength < 2) return null;

    const sampleCount = alignedLength / 2;
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = audioBuffer.readInt16LE(i * 2) / 32768.0;
    }
    return samples;
  }

  // ── Transcription ─────────────────────────────────────────────────────
  async transcribeFromBuffer(audioBuffer: Buffer): Promise<{ text: string; isAssistant: boolean; model: string } | null> {
    const settings = AppSettingsService.getInstance().getSettings();
    const modelId = settings.localModelId;

    if (!SENSEVOICE_MODELS.some(m => m.id === modelId)) {
      return null;
    }

    if (!this.initRecognizer(modelId)) {
      return null;
    }

    let stream: any = null;
    try {
      const samples = this.pcm16ToFloat32(audioBuffer);
      if (!samples) {
        Logger.error('🎤 [SenseVoice] Failed to convert audio');
        return null;
      }

      Logger.info(`🎤 [SenseVoice] Transcribing ${(samples.length / 16000).toFixed(1)}s of audio...`);
      const startTime = Date.now();

      stream = this.recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples });

      // decodeAsync avoids blocking the main process on longer utterances.
      if (typeof this.recognizer.decodeAsync === 'function') {
        await this.recognizer.decodeAsync(stream);
      } else {
        this.recognizer.decode(stream);
      }

      const result = this.recognizer.getResult(stream);
      const text = stripSenseVoiceTags(result?.text || '');

      Logger.info(`🎤 [SenseVoice] Result in ${Date.now() - startTime}ms: "${text}"`);

      if (!text) return null;
      return { text, isAssistant: false, model: modelId };
    } catch (error) {
      // Native error can leave the recognizer in a bad state — drop it so the
      // next call rebuilds rather than looping on a dead handle.
      Logger.error('🎤 [SenseVoice] Transcription error, dropping recognizer:', error);
      this.dispose();
      return null;
    } finally {
      if (stream) {
        try {
          if (typeof stream.free === 'function') stream.free();
          else if (typeof stream.close === 'function') stream.close();
        } catch { /* handle may already be released */ }
      }
    }
  }

  dispose(): void {
    if (this.recognizer && typeof this.recognizer.close === 'function') {
      try { this.recognizer.close(); } catch { /* ignore */ }
    }
    this.recognizer = null;
    this.currentModelId = null;
  }
}
