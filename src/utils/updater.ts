/**
 * In-app updates.
 *
 * The desktop app checks a signed release manifest, downloads the new package
 * and replaces itself, so an update never means uninstall-download-reinstall.
 * Every artifact carries a minisign signature that is verified against the
 * public key baked into `tauri.conf.json` before anything is installed — a
 * tampered release is refused even if the download host is compromised.
 *
 * Not every installation can do this. A `.deb` or `.rpm` is owned by the system
 * package manager, so the app reports that rather than offering a button that
 * would fail; see `update_capability` in `src-tauri/src/lib.rs`.
 */
import { isTauri } from './tauriBridge';

export interface UpdateCapability {
  supported: boolean;
  /** nsis | appimage | macos | system-package | dev */
  installKind: string;
  /** Set when `supported` is false: what the operator should do instead. */
  reason: string | null;
  currentVersion: string;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string | null;
  publishedAt: string | null;
}

export interface DownloadProgress {
  /** Bytes received so far. */
  downloaded: number;
  /** Total bytes, when the server declared a length. */
  total: number | null;
  /** 0–100, or null while the total is unknown. */
  percent: number | null;
}

/** Matches the browser case: nothing to update, and nothing to apologise for. */
const UNSUPPORTED_IN_BROWSER: UpdateCapability = {
  supported: false,
  installKind: 'browser',
  reason:
    'This is the web client running in a browser. Install the desktop app to get updates in place.',
  currentVersion: '',
};

/**
 * Whether this copy can update itself, and what to say if it cannot.
 */
export async function getUpdateCapability(): Promise<UpdateCapability> {
  if (!isTauri()) return UNSUPPORTED_IN_BROWSER;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<UpdateCapability>('update_capability');
  } catch (err) {
    console.warn('[updater] could not read update capability:', err);
    return {
      supported: false,
      installKind: 'unknown',
      reason: 'The host process did not report whether it can update itself.',
      currentVersion: '',
    };
  }
}

/**
 * Handle to a pending update, kept between the check and the install so the
 * download does not have to re-resolve which release it is applying.
 */
let pending: { version: string; handle: unknown } | null = null;

/**
 * Asks the release endpoint whether a newer version exists.
 *
 * Returns `null` when up to date, which is the ordinary case and not an error.
 * A network failure throws, so the caller can tell "no update" apart from
 * "could not find out".
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const capability = await getUpdateCapability();
  if (!capability.supported) return null;

  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();

  if (!update) {
    pending = null;
    return null;
  }

  pending = { version: update.version, handle: update };
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? null,
    publishedAt: update.date ?? null,
  };
}

/**
 * Downloads and installs the update found by `checkForUpdate`, reporting
 * progress as it goes, then relaunches into the new version.
 *
 * The relaunch is what makes this feel like an update rather than a download:
 * the operator clicks once and comes back to the new build.
 */
export async function installUpdate(
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  if (!pending) {
    throw new Error('No update has been found yet — check for one first.');
  }

  const update = pending.handle as {
    downloadAndInstall: (cb: (event: DownloadEvent) => void) => Promise<void>;
  };

  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        downloaded = 0;
        total = event.data.contentLength ?? null;
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        break;
      case 'Finished':
        if (total !== null) downloaded = total;
        break;
    }
    onProgress?.({
      downloaded,
      total,
      percent: total && total > 0 ? Math.min(100, (downloaded / total) * 100) : null,
    });
  });

  // On Windows the installer takes over and closes the app itself; elsewhere we
  // restart into the version that was just written.
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

/** Shape of the progress events the updater plugin emits. */
type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished'; data?: unknown };

/**
 * Compares two `major.minor.patch` versions.
 *
 * Returns a positive number when `a` is newer. Used to present the update
 * honestly — a manifest that offers an older or identical build should not be
 * described as an upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** "12.4 MB of 81.5 MB (15%)", or bytes alone while the total is unknown. */
export function formatProgress(progress: DownloadProgress): string {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (progress.total === null) return `${mb(progress.downloaded)} downloaded`;
  const percent = progress.percent === null ? '' : ` (${Math.round(progress.percent)}%)`;
  return `${mb(progress.downloaded)} of ${mb(progress.total)}${percent}`;
}
