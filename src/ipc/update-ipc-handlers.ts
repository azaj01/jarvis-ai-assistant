/**
 * UpdateIPCHandlers - Handles app update-related IPC communication
 */
import { app, ipcMain } from 'electron';
import * as https from 'https';
import { Logger } from '../core/logger';
import { UpdateService } from '../services/update-service';
import { getRealMachineArch } from '../core/machine-arch';

/** Stable beta channel manifest · serves the current 2.0 beta DMGs per arch.
 *  We fetch this (not a pinned URL) so the offer always installs the latest
 *  beta without shipping a new 1.x build. */
const JARVIS2_MANIFEST_URL = 'https://jarvis.ceo/beta/manifest.json';

function fetchJson(url: string, timeoutMs = 12000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Jarvis-AI-Assistant-Updater', 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) { reject(new Error(`manifest ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('manifest request timeout')));
  });
}

export class UpdateIPCHandlers {
  private static instance: UpdateIPCHandlers;
  private handlersRegistered = false;
  
  private updateService: UpdateService | null = null;
  
  private constructor() {}
  
  static getInstance(): UpdateIPCHandlers {
    if (!UpdateIPCHandlers.instance) {
      UpdateIPCHandlers.instance = new UpdateIPCHandlers();
    }
    return UpdateIPCHandlers.instance;
  }
  
  setUpdateService(service: UpdateService): void {
    this.updateService = service;
  }
  
  registerHandlers(): void {
    if (this.handlersRegistered) {
      Logger.warning('Update IPC handlers already registered, skipping');
      return;
    }

    ipcMain.handle('check-for-updates', () => {
      Logger.info('🔍 Manual update check requested');
      if (this.updateService) {
        this.updateService.forceCheckForUpdates();
      }
    });
    
    ipcMain.handle('download-update', async (_, { downloadUrl, version }) => {
      Logger.info('📥 Download update requested:', version);
      if (!this.updateService) {
        return { ok: false, reason: 'no-update-service' };
      }
      try {
        await this.updateService.downloadUpdate(downloadUrl, version);
        return { ok: true };
      } catch (err: any) {
        Logger.error('[IPC] download-update failed:', err);
        return { ok: false, error: err?.message || 'unknown' };
      }
    });
    
    // Jarvis 2.0 beta upgrade · fetch the beta manifest, pick the DMG matching
    // the user's REAL machine arch, and run it through the normal updater
    // (download → hdiutil install → relaunch). Reuses the same update-progress /
    // update-downloaded / update-download-error events the renderer listens to.
    ipcMain.handle('jarvis2-upgrade', async () => {
      Logger.info('🚀 [jarvis2] upgrade requested');
      if (!this.updateService) return { ok: false, error: 'no-update-service' };
      try {
        const manifest = await fetchJson(JARVIS2_MANIFEST_URL);
        const arch = getRealMachineArch();                 // 'arm64' | 'x64'
        const key = `darwin-${arch}`;
        const platform = manifest?.platforms?.[key];
        const downloadUrl = platform?.downloadUrl;
        const version = manifest?.latestVersion;
        if (!downloadUrl || !version) {
          Logger.warning(`[jarvis2] manifest missing ${key} downloadUrl/version`);
          return { ok: false, error: 'no-build-for-arch' };
        }
        Logger.info(`🚀 [jarvis2] installing ${version} (${key})`);
        // Fire-and-forget the download/install · progress + completion flow
        // back over update-progress / update-downloaded events. Returning early
        // lets the renderer switch to its progress UI immediately.
        void this.updateService.downloadUpdate(downloadUrl, version).catch((err: any) =>
          Logger.error('[jarvis2] downloadUpdate failed:', err));
        return { ok: true, version, arch };
      } catch (err: any) {
        Logger.error('[jarvis2] upgrade failed:', err);
        return { ok: false, error: err?.message || 'unknown' };
      }
    });

    ipcMain.handle('get-app-version', () => {
      return app.getVersion();
    });
    
    ipcMain.handle('restart-app', () => {
      Logger.info('🔄 Restarting app via IPC request...');
      app.relaunch();
      app.exit(0);
    });
    
    this.handlersRegistered = true;
    Logger.info('Update IPC handlers registered');
  }
}
