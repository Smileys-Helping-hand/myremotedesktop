import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowUpCircle, CheckCircle2, Download, Loader2, X } from 'lucide-react';
import {
  checkForUpdate,
  formatProgress,
  getUpdateCapability,
  installUpdate,
  type AvailableUpdate,
  type DownloadProgress,
  type UpdateCapability,
} from '../utils/updater';

type Phase = 'idle' | 'available' | 'downloading' | 'installed' | 'failed';

/** Only shown once per run after a dismissal, so it never nags mid-session. */
const DISMISS_KEY = 'remotedesk_update_dismissed_version';

/**
 * Offers an in-place update when one is published.
 *
 * Deliberately quiet: it renders nothing at all when the app is current, when
 * the check fails, or when this installation is managed by a package manager.
 * A remote session is the worst possible moment for a modal, so it never
 * blocks — the operator chooses when to apply it.
 */
export const UpdateBanner: React.FC = () => {
  const [capability, setCapability] = useState<UpdateCapability | null>(null);
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const cap = await getUpdateCapability();
      if (cancelled) return;
      setCapability(cap);
      if (!cap.supported) return;

      try {
        const found = await checkForUpdate();
        if (cancelled || !found) return;

        // Respect a dismissal, but only for the version that was dismissed —
        // a newer release should surface again.
        if (sessionStorage.getItem(DISMISS_KEY) === found.version) return;

        setUpdate(found);
        setPhase('available');
      } catch (err) {
        // Being unable to reach the release endpoint is not worth interrupting
        // anyone over; it is logged and the banner stays hidden.
        console.info('[updater] update check did not complete:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstall = useCallback(async () => {
    setPhase('downloading');
    setError(null);
    try {
      await installUpdate(setProgress);
      setPhase('installed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  }, []);

  const handleDismiss = useCallback(() => {
    if (update) sessionStorage.setItem(DISMISS_KEY, update.version);
    setDismissed(true);
  }, [update]);

  if (!capability?.supported || !update || dismissed) return null;

  return (
    <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-4">
      <div className="rounded-xl border border-cyan-500/30 bg-[#0a1018]/95 shadow-[0_0_24px_rgba(6,182,212,0.12)] px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {phase === 'installed' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          ) : phase === 'failed' ? (
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          ) : (
            <ArrowUpCircle className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
          )}

          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">
              {phase === 'installed'
                ? 'Update installed — restarting'
                : phase === 'failed'
                  ? 'Update failed'
                  : `RemoteDesk ${update.version} is available`}
            </p>
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              {phase === 'downloading' && progress
                ? formatProgress(progress)
                : phase === 'failed'
                  ? error
                  : phase === 'installed'
                    ? 'The app will reopen on the new version.'
                    : `You are on ${update.currentVersion}. It installs in place — no reinstall.`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {(phase === 'available' || phase === 'failed') && (
            <button
              onClick={handleInstall}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold text-xs flex items-center gap-2 transition-all font-mono"
            >
              <Download className="w-3.5 h-3.5" />
              {phase === 'failed' ? 'Try again' : 'Update now'}
            </button>
          )}

          {phase === 'downloading' && (
            <span className="px-4 py-2 rounded-lg bg-cyan-950/50 border border-cyan-500/25 text-cyan-200 text-xs font-mono flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {progress?.percent === null || progress === null
                ? 'Downloading'
                : `${Math.round(progress.percent)}%`}
            </span>
          )}

          {phase !== 'downloading' && phase !== 'installed' && (
            <button
              onClick={handleDismiss}
              aria-label="Dismiss update notice"
              className="p-2 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {phase === 'downloading' && progress?.percent !== null && progress && (
        <div className="h-1 bg-cyan-950/60 rounded-full overflow-hidden mt-1.5">
          <div
            className="h-full bg-gradient-to-r from-cyan-400 to-blue-500 transition-[width] duration-200"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}
    </div>
  );
};
