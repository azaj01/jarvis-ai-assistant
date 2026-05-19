/**
 * Single source of truth for "can dictation actually run right now?"
 *
 * Previous approach (1.3.2/1.3.3): each error path independently fired a
 * native notification + transient banner, both guarded by a once-per-session
 * flag. PostHog showed users firing the same blocking error 50+ times in
 * one session because the banner could be dismissed and never came back.
 *
 * This service centralizes the readiness check and broadcasts a reactive
 * status to the renderer. The banner UI is now derived from that status,
 * so it stays visible until the underlying issue is actually fixed.
 *
 * Statuses (ordered by priority):
 *   `mic_denied`   — macOS mic permission revoked or never granted
 *   `accessibility_denied` — accessibility permission missing
 *   `no_engine`    — useLocalModel=true with model not downloaded AND
 *                    no cloud key configured. Dictation literally cannot run.
 *   `ok`           — pipeline ready
 *
 * Recompute on: app boot, settings save, permission grant/deny, Fn-press.
 */
import { BrowserWindow, systemPreferences, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../core/logger';
import { AppSettingsService } from './app-settings-service';

export type SetupReason = 'mic_denied' | 'accessibility_denied' | 'no_engine' | 'ok';

export interface SetupStatus {
  ready: boolean;
  reason: SetupReason;
  title: string;
  body: string;
  ctaLabel: string;
  // For renderer to act on. Either internal route OR system pref URL.
  ctaRoute?: { tab: string; subTab?: string };
  ctaSystem?: string;
}

export class SetupStatusService {
  private static instance: SetupStatusService;
  private lastBroadcast: SetupStatus | null = null;

  static getInstance(): SetupStatusService {
    if (!SetupStatusService.instance) {
      SetupStatusService.instance = new SetupStatusService();
    }
    return SetupStatusService.instance;
  }

  /**
   * Compute current readiness. Synchronous — cheap enough to call on every
   * Fn-press without IPC overhead.
   */
  evaluate(): SetupStatus {
    let micStatus: string = 'granted';
    try { micStatus = systemPreferences.getMediaAccessStatus('microphone'); } catch { /* keep default */ }
    if (micStatus === 'denied' || micStatus === 'restricted') {
      return {
        ready: false,
        reason: 'mic_denied',
        title: 'Microphone access blocked',
        body: 'Jarvis can\'t hear you. Enable microphone access in System Settings → Privacy & Security → Microphone, then come back.',
        ctaLabel: 'Open System Settings',
        ctaSystem: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      };
    }

    // Accessibility (needed for keystroke paste). We don't synchronously
    // query this on every evaluate() to avoid the macOS prompt side-effect
    // — checked in the dedicated accessibility flow.
    try {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        return {
          ready: false,
          reason: 'accessibility_denied',
          title: 'Accessibility access needed',
          body: 'Jarvis needs accessibility access to paste transcribed text. Enable it in System Settings → Privacy & Security → Accessibility.',
          ctaLabel: 'Open System Settings',
          ctaSystem: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
        };
      }
    } catch { /* never block on a permission probe failure */ }

    const settings = AppSettingsService.getInstance().getSettings();
    const hasKey = !!(settings.deepgramApiKey?.trim() || settings.openaiApiKey?.trim() || settings.geminiApiKey?.trim());
    const localActive = settings.useLocalModel === true;
    const localReady = localActive && this.isLocalModelDownloaded(settings.localModelId);

    // True "no engine" state — neither path can produce a transcript:
    //   1. useLocalModel=false AND no cloud key, OR
    //   2. useLocalModel=true but model files not on disk AND no cloud key
    //      (1.3.4 missed this case → PostHog showed 1 user firing 24
    //      'Local model not ready' errors in 40 min)
    if (!hasKey && !localReady) {
      const body = localActive
        ? 'The local model you picked isn\'t downloaded yet. Finish the download in Settings → Transcription, or add a Deepgram / OpenAI / Gemini API key instead.'
        : 'Jarvis needs a Deepgram, OpenAI, or Gemini API key to transcribe in the cloud — or enable a local model in Settings.';
      return {
        ready: false,
        reason: 'no_engine',
        title: 'Add an API key or finish your local model download',
        body,
        ctaLabel: 'Open Settings',
        ctaRoute: { tab: 'settings', subTab: 'api-keys' }
      };
    }

    return {
      ready: true,
      reason: 'ok',
      title: '',
      body: '',
      ctaLabel: ''
    };
  }

  private isLocalModelDownloaded(modelId: string | undefined): boolean {
    if (!modelId) return false;
    try {
      // Parakeet / Sherpa model layout: userData/sherpa-models/<id>/<file>
      const sherpaDir = path.join(app.getPath('userData'), 'sherpa-models', modelId);
      if (fs.existsSync(sherpaDir)) {
        const entries = fs.readdirSync(sherpaDir);
        // Need at least the encoder + decoder + joiner + tokens (~4 files)
        if (entries.length >= 4) return true;
      }
      // Whisper ggml-<modelId>.bin layout
      const whisperFile = path.join(app.getPath('userData'), 'models', 'whisper', `ggml-${modelId}.bin`);
      if (fs.existsSync(whisperFile)) {
        const stat = fs.statSync(whisperFile);
        // Smallest tiny.en is ~75MB. Reject obvious truncations.
        if (stat.size > 30 * 1024 * 1024) return true;
      }
    } catch (err) {
      Logger.debug('[SetupStatus] Local-model probe failed:', err);
    }
    return false;
  }

  /**
   * Evaluate + broadcast to all renderer windows. Call this whenever the
   * underlying state could have changed (settings save, permission change,
   * app boot). De-duplicates: only broadcasts when the reason actually
   * changes, so we don't spam PostHog with redundant events.
   */
  broadcast(): SetupStatus {
    const status = this.evaluate();
    const changed = !this.lastBroadcast || this.lastBroadcast.reason !== status.reason;
    this.lastBroadcast = status;
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('app:setup-status', status);
        }
      }
    } catch (err) {
      Logger.debug('[SetupStatus] Broadcast failed:', err);
    }
    if (changed && !status.ready) {
      void this.reportToAnalytics(status);
    }
    return status;
  }

  private async reportToAnalytics(status: SetupStatus): Promise<void> {
    try {
      const { posthog } = await import('../analytics/posthog');
      // Coarse config booleans help us tell which combination of state
      // produced the block — useful when the same `reason` value could
      // hide several user paths (e.g. cloud-only vs local-only intent).
      const settings = AppSettingsService.getInstance().getSettings();
      posthog.capture('setup_blocked', {
        reason: status.reason,
        has_deepgram_key: !!settings.deepgramApiKey?.trim(),
        has_openai_key: !!settings.openaiApiKey?.trim(),
        has_gemini_key: !!settings.geminiApiKey?.trim(),
        use_local_model: settings.useLocalModel === true,
        local_model_id: settings.localModelId || ''
      });
    } catch { /* never let analytics break the user-facing flow */ }
  }
}
