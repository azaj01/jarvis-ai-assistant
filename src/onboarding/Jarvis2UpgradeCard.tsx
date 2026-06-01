/**
 * Jarvis 2.0 beta upgrade overlay · shown once during 1.x onboarding.
 *
 * Why this exists: 1.x bleeds users at the macOS Accessibility wall (the #1
 * churn cause — most stuck users never recover). Jarvis 2.0 works without
 * Accessibility, retains better, and self-updates thereafter. This overlay
 * offers a celebratory, one-tap upgrade: it fetches the beta manifest, picks
 * the DMG for the user's real chip (Apple Silicon / Intel), and runs it through
 * the existing updater (download → install → relaunch) with live progress.
 *
 * Dismissable — declining just continues the normal 1.x onboarding.
 */

import React, { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';

type Phase = 'offer' | 'installing' | 'done' | 'error';

const api = () => (window as any).electronAPI;

function fireConfetti() {
  try {
    const burst = (particleRatio: number, opts: confetti.Options) =>
      confetti({ origin: { y: 0.6 }, particleCount: Math.floor(200 * particleRatio), ...opts });
    burst(0.25, { spread: 26, startVelocity: 55 });
    burst(0.2, { spread: 60 });
    burst(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
    burst(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
    burst(0.1, { spread: 120, startVelocity: 45 });
  } catch { /* confetti is decorative · never block the upgrade on it */ }
}

export const Jarvis2UpgradeCard: React.FC<{ onDismiss: () => void }> = ({ onDismiss }) => {
  const [phase, setPhase] = useState<Phase>('offer');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');
  const cleanupRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    api()?.posthogCapture?.('beta2_offer_shown', { from: 'onboarding' });
    return () => { cleanupRef.current.forEach(fn => { try { fn(); } catch { /* */ } }); };
  }, []);

  const startUpgrade = async () => {
    api()?.posthogCapture?.('beta2_install_clicked', { from: 'onboarding' });
    fireConfetti();
    setPhase('installing');
    setPercent(0);

    // Subscribe BEFORE kicking off so we never miss an early progress tick.
    const offProgress = api()?.onJarvis2Progress?.((p: number) => setPercent(Math.max(0, Math.min(100, Math.round(p)))));
    const offDone = api()?.onJarvis2Done?.(() => {
      api()?.posthogCapture?.('beta2_installed', {});
      setPercent(100);
      setPhase('done');
      // The updater relaunches into 2.0 on its own; give the user a beat to read.
    });
    const offError = api()?.onJarvis2Error?.((e: string) => {
      api()?.posthogCapture?.('beta2_install_error', { error: e, stage: 'download' });
      setError(e || 'Something went wrong.');
      setPhase('error');
    });
    if (offProgress) cleanupRef.current.push(offProgress);
    if (offDone) cleanupRef.current.push(offDone);
    if (offError) cleanupRef.current.push(offError);

    const r = await api()?.jarvis2Upgrade?.();
    if (!r?.ok) {
      api()?.posthogCapture?.('beta2_install_error', { error: r?.error ?? 'invoke-failed', stage: 'kickoff' });
      setError(r?.error === 'no-build-for-arch'
        ? "Couldn't find a build for your Mac. Try again shortly."
        : 'Could not start the upgrade. Check your connection and try again.');
      setPhase('error');
    }
  };

  const dismiss = (reason: string) => {
    api()?.posthogCapture?.('beta2_dismissed', { reason });
    onDismiss();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-xl"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <div className="relative w-[min(92vw,520px)] rounded-2xl border border-white/12 bg-gradient-to-b from-white/[0.08] to-white/[0.02] p-8 shadow-2xl text-center">

        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10">
          <span className="material-icons-outlined text-3xl text-white">auto_awesome</span>
        </div>

        {phase === 'offer' && (
          <>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50">You've been upgraded</div>
            <h2 className="text-2xl font-semibold text-white">Meet Jarvis 2.0 <span className="text-white/50">(beta)</span></h2>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-white/70">
              The future of Jarvis — faster, ambient, and it works <span className="text-white">without Accessibility permissions</span>.
              You've been added to the beta. Install it now and Jarvis picks the right build for your Mac automatically.
            </p>
            <div className="mt-7 flex flex-col items-center gap-3">
              <button
                onClick={startUpgrade}
                className="w-full rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition-all hover:bg-white/90 hover:scale-[1.02] active:scale-95 shadow-lg">
                Install Jarvis 2.0
              </button>
              <button
                onClick={() => dismiss('maybe_later')}
                className="text-xs text-white/55 underline underline-offset-2 transition-colors hover:text-white/80">
                Maybe later
              </button>
            </div>
          </>
        )}

        {phase === 'installing' && (
          <>
            <h2 className="text-xl font-semibold text-white">Upgrading to Jarvis 2.0…</h2>
            <p className="mt-2 text-sm text-white/60">
              {percent < 98 ? 'Downloading the right build for your Mac.' : 'Installing — Jarvis will relaunch in a moment.'}
            </p>
            <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-2 rounded-full bg-white transition-all duration-300" style={{ width: `${Math.max(4, percent)}%` }} />
            </div>
            <div className="mt-2 text-xs tabular-nums text-white/50">{percent < 98 ? `${percent}%` : 'Almost there…'}</div>
          </>
        )}

        {phase === 'done' && (
          <>
            <h2 className="text-xl font-semibold text-white">You're on Jarvis 2.0 ✓</h2>
            <p className="mt-2 text-sm text-white/60">Relaunching into the new app…</p>
          </>
        )}

        {phase === 'error' && (
          <>
            <h2 className="text-xl font-semibold text-white">Upgrade didn't go through</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-white/65">{error}</p>
            <div className="mt-6 flex flex-col items-center gap-3">
              <button
                onClick={startUpgrade}
                className="w-full rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition-all hover:bg-white/90 active:scale-95">
                Try again
              </button>
              <button
                onClick={() => dismiss('error_dismissed')}
                className="text-xs text-white/55 underline underline-offset-2 hover:text-white/80">
                Continue with the current version
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Jarvis2UpgradeCard;
