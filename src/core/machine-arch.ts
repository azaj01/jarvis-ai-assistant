/**
 * Detect the real CPU architecture of the user's Mac, independent of which
 * Electron binary they happen to be running.
 *
 * Why this exists:
 *   When a user accidentally installs the Intel DMG on an Apple Silicon Mac
 *   (or vice versa), `process.arch` reports whatever the *binary* was
 *   compiled for — not the machine. The native modules (sherpa-onnx,
 *   audio_capture) ship matching dylibs per Electron arch, so an arch
 *   mismatch crashes with 'Native audio recording not available'.
 *
 *   Worse, the old updater picked DMGs by `process.arch`, so a stuck user
 *   would re-download the same wrong build every auto-update and never
 *   self-heal. This helper plus the updater + boot-banner changes break
 *   that loop.
 *
 *   sysctl `hw.optional.arm64` returns "1" on any arm64 hardware — even
 *   when Electron is running under Rosetta. That's the ground truth we
 *   need. Anything else is the fallback path (Intel hardware, or sysctl
 *   missing).
 */
import { execSync } from 'child_process';
import { Logger } from './logger';

let cached: 'arm64' | 'x64' | null = null;

export function getRealMachineArch(): 'arm64' | 'x64' {
  if (cached) return cached;
  if (process.platform !== 'darwin') {
    cached = (process.arch === 'arm64' ? 'arm64' : 'x64');
    return cached;
  }
  try {
    const out = execSync('sysctl -in hw.optional.arm64', {
      encoding: 'utf8',
      timeout: 1000
    }).trim();
    cached = out === '1' ? 'arm64' : 'x64';
    return cached;
  } catch (err) {
    // sysctl missing or unreadable — degrade safely to whatever Electron says.
    Logger.debug('[MachineArch] sysctl probe failed, falling back to process.arch:', err);
    cached = (process.arch === 'arm64' ? 'arm64' : 'x64');
    return cached;
  }
}

/**
 * True when the running Electron binary's arch differs from the actual
 * machine arch. This is the "Intel DMG installed on Apple Silicon" case
 * that's been blowing up native audio for users in PostHog.
 */
export function isArchMismatched(): boolean {
  const real = getRealMachineArch();
  const proc = process.arch === 'arm64' ? 'arm64' : 'x64';
  return real !== proc;
}
