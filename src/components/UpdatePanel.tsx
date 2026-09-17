import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw, RotateCw } from 'lucide-react';
import {
  AvailableUpdate,
  DownloadProgress,
  UpdateCapability,
  findUpdate,
  formatProgress,
  getUpdateCapability,
  installUpdate,
} from '../utils/updater';
import { loadDevices } from '../utils/deviceBook';
import { scanForHosts } from '../utils/hostDiscovery';
import { getHostSignalUrl } from '../hooks/useWebRTC';

type Phase = 'idle' | 'checking' | 'found' | 'current' | 'downloading' | 'done' | 'failed';

/**
 * Checking, downloading and installing an update, with buttons for all three.
 *
 * Sources are asked nearest first: machines already saved in the device book,
 * then anything else answering on this network, then the release endpoint. On a
 * pair of machines that only ever see each other, the first two are the only
 * sources there are — and they are the fast ones everywhere else.
 */
export const UpdatePanel: React.FC = () => {
  const [capability, setCapability] = useState<UpdateCapability | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getUpdateCapability().then((cap) => {
      if (!cancelled) setCapability(cap);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Every place worth asking, nearest first. */
  const updateSources = useCallback(async (): Promise<string[]> => {
    const devices = await loadDevices();
    const saved = devices.flatMap((device) => device.addresses);

    // A machine that is on this network but not saved still has the package.
    let discovered: string[] = [];
    try {
      const { hosts } = await scanForHosts({ selfOrigin: getHostSignalUrl() });
      discovered = hosts.map((host) => host.origin);
    } catch {
      /* a failed sweep is not a failed update check */
    }

    return Array.from(new Set([...saved, ...discovered]));
  }, []);

  const handleCheck = async () => {
    setPhase('checking');
    setError(null);
    setUpdate(null);
    try {
      const origins = await updateSources();
      const { update: found, checked: asked, failures } = await findUpdate(origins);
      setChecked(asked);
      if (found) {
        setUpdate(found);
        setPhase('found');
      } else {
        setPhase('current');
        // Only worth reporting when nothing was found *and* something failed:
        // otherwise an unreachable saved machine is noise.
        if (failures.length > 0 && asked.length === 0) setError(failures.join('; '));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  };

  const handleInstall = async () => {
    setPhase('downloading');
    setError(null);
    try {
      await installUpdate(setProgress);
      // Windows hands over to the installer, which closes this process; on
      // other platforms the relaunch has already happened by now.
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  };

  if (!capability) return null;

  return (
    <div className="bg-[#0c0e18]/95 border border-cyan-500/25 rounded-2xl p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <RotateCw className="w-4 h-4 text-cyan-400" />
            Updates
          </h3>
          <p className="text-xs text-slate-400 font-mono mt-0.5">
            {capability.currentVersion
              ? `This machine is running ${capability.currentVersion}`
              : 'Version unknown'}
          </p>
        </div>

        {capability.supported && (
          <button
            type="button"
            onClick={() => void handleCheck()}
            disabled={phase === 'checking' || phase === 'downloading'}
            className="px-3.5 py-2 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-bold font-mono flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            {phase === 'checking' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {phase === 'checking' ? 'Looking…' : 'Check for updates'}
          </button>
        )}
      </div>

      {/* A copy that cannot replace itself says so once, plainly. */}
      {!capability.supported && capability.reason && (
        <p className="text-xs text-slate-400 leading-relaxed bg-[#07080f] border border-slate-700 rounded-xl p-3">
          {capability.reason}
        </p>
      )}

      {phase === 'current' && (
        <p className="text-xs text-emerald-300 font-mono flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Up to date{checked.length > 0 && ` — asked ${checked.join(', ')}`}
        </p>
      )}

      {phase === 'found' && update && (
        <div className="bg-[#07080f] border border-cyan-400/40 rounded-xl p-3.5 space-y-2.5">
          <div>
            <p className="text-sm font-bold text-cyan-200">
              Version {update.version} is available
            </p>
            <p className="text-[11px] text-slate-400 font-mono">
              You have {update.currentVersion} · from {update.source}
            </p>
            {update.notes && (
              <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">{update.notes}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleInstall()}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-slate-950 text-xs font-extrabold font-mono flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Download and install
          </button>
        </div>
      )}

      {phase === 'downloading' && (
        <div className="space-y-1.5">
          <div className="h-2 rounded-full bg-[#07080f] border border-cyan-500/20 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-cyan-400 to-blue-500 transition-all"
              style={{ width: `${progress?.percent ?? 5}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-400 font-mono">
            {progress ? formatProgress(progress) : 'Starting download…'} — the app restarts itself
            when this finishes.
          </p>
        </div>
      )}

      {phase === 'done' && (
        <p className="text-xs text-emerald-300 font-mono flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Installed. The app is restarting.
        </p>
      )}

      {/* Naming the folder is what turns "this machine can share updates" from
          a claim into something the operator can act on. */}
      {capability.libraryDir && (
        <p className="text-[10px] text-slate-500 font-mono leading-relaxed border-t border-cyan-500/10 pt-2">
          This machine offers packages to others from{' '}
          <span className="text-slate-400">{capability.libraryDir}</span> — drop the Windows and
          Linux installers there and the other machine can update from here with no internet.
        </p>
      )}

      {error && (
        <p className="text-xs text-rose-300 font-mono flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
};
