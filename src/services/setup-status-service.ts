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
import { BrowserWindow, systemPreferences } from 'electron';
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

    // Local model: useLocalModel only counts as ready when the user explicitly
    // turned it on. We don't probe disk here — the model files might exist
    // but the user disabled the toggle, or vice versa. The fast-assistant
    // routing already falls back to cloud when a local model isn't
    // available, so the only true "no engine" state is useLocalModel=false
    // AND no cloud key.
    if (!settings.useLocalModel && !hasKey) {
      return {
        ready: false,
        reason: 'no_engine',
        title: 'Add an API key to start dictating',
        body: 'Jarvis needs a Deepgram, OpenAI, or Gemini API key to transcribe in the cloud — or enable a local model in Settings.',
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
      posthog.capture('setup_blocked', { reason: status.reason });
    } catch { /* never let analytics break the user-facing flow */ }
  }
}
