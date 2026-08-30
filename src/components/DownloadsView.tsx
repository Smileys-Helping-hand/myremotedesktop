import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Apple,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Monitor,
  Terminal,
} from 'lucide-react';
import {
  describeInstaller,
  fetchDownloads,
  formatBytes,
  guessVisitorPlatform,
  sortAssets,
  versionFromFilename,
  type DownloadsResponse,
  type InstallerAsset,
  type InstallerPlatform,
} from '../utils/downloads';
import { getUpdateCapability, type UpdateCapability } from '../utils/updater';

function PlatformIcon({ platform }: { platform: InstallerPlatform }) {
  const className = 'w-5 h-5 text-cyan-400';
  if (platform === 'windows') return <Monitor className={className} />;
  if (platform === 'macos') return <Apple className={className} />;
  return <Terminal className={className} />;
}

/**
 * Where a browser visitor gets the desktop app.
 *
 * The list is whatever the server actually has on disk — nothing is listed
 * unless it can really be downloaded. A server with no installers says so and
 * sends people to the release page rather than showing dead buttons.
 */
export const DownloadsView: React.FC = () => {
  const [data, setData] = useState<DownloadsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [capability, setCapability] = useState<UpdateCapability | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [downloads, cap] = await Promise.all([fetchDownloads(), getUpdateCapability()]);
      if (cancelled) return;
      setData(downloads);
      setCapability(cap);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const preferred = useMemo(() => guessVisitorPlatform(), []);
  const assets = useMemo(
    () => (data ? sortAssets(data.assets, preferred) : []),
    [data, preferred]
  );

  const version =
    data?.version ?? (assets.length > 0 ? versionFromFilename(assets[0].file) : null);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="bg-[#0c0e18]/95 border border-cyan-500/25 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 space-y-2">
          <h2 className="text-2xl font-bold text-white tracking-tight">Get the desktop app</h2>
          <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
            The browser client can connect to a host and control it. To <em>share</em> your own
            screen you need the desktop app, which also injects mouse and keyboard input at the
            OS level.
            {version && (
              <span className="text-cyan-300 font-mono"> Current version {version}.</span>
            )}
          </p>
        </div>
      </div>

      {capability?.supported && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-950/20 px-4 py-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <p className="text-sm text-emerald-100">
            You are running the desktop app
            {capability.currentVersion && (
              <span className="font-mono"> ({capability.currentVersion})</span>
            )}
            . It updates itself — you will be offered new versions in place, with no reinstall.
          </p>
        </div>
      )}

      {capability && !capability.supported && capability.installKind === 'system-package' && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-950/20 px-4 py-3">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-100">{capability.reason}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2.5 text-cyan-400" />
          <span className="text-sm">Looking for installers…</span>
        </div>
      ) : assets.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {assets.map((asset) => (
            <DownloadCard key={asset.file} asset={asset} highlighted={asset.platform === preferred} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-cyan-500/20 bg-[#090b16] px-5 py-6 text-center space-y-3">
          <p className="text-sm text-slate-300">
            This server is not hosting any installer files.
          </p>
          <a
            href={data?.releasesUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-slate-950 font-bold text-xs font-mono"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Download from GitHub Releases
          </a>
        </div>
      )}

      {assets.length > 0 && data?.releasesUrl && (
        <p className="text-xs text-slate-500 text-center">
          Older versions and checksums live on the{' '}
          <a
            href={data.releasesUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
          >
            releases page
          </a>
          .
        </p>
      )}
    </div>
  );
};

function DownloadCard({ asset, highlighted }: { asset: InstallerAsset; highlighted: boolean }) {
  const { title, detail } = describeInstaller(asset.kind);
  const size = formatBytes(asset.sizeBytes);

  return (
    <div
      className={`rounded-xl border px-4 py-4 flex flex-col gap-3 transition-colors ${
        highlighted
          ? 'border-cyan-500/40 bg-cyan-950/20'
          : 'border-cyan-500/15 bg-[#090b16] hover:border-cyan-500/30'
      }`}
    >
      <div className="flex items-start gap-3">
        <PlatformIcon platform={asset.platform} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white flex items-center gap-2">
            {title}
            {highlighted && (
              <span className="text-[10px] font-mono uppercase tracking-wide text-cyan-300 bg-cyan-500/15 border border-cyan-500/30 rounded-full px-2 py-0.5">
                your system
              </span>
            )}
          </p>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{detail}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 mt-auto pt-1">
        <span className="text-[11px] font-mono text-slate-500 truncate" title={asset.file}>
          {asset.file}
        </span>
        {/* A plain link, so the browser's own download manager handles it and
            the file can be resumed like any other download. */}
        <a
          href={asset.url}
          download={asset.file}
          className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold text-xs font-mono transition-all"
        >
          <Download className="w-3.5 h-3.5" />
          {size || 'Download'}
        </a>
      </div>
    </div>
  );
}
