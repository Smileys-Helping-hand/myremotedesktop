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
 *
 * Updates come from two kinds of place: the release endpoint compiled into the
 * app, and any RemoteDesk machine on the network, which publishes a manifest
 * for the installers it holds. The second is what makes a pair of machines with
 * no internet able to keep each other current — and it is safe for the same
 * reason the first is, because the package is verified against the signing key
 * in this binary before it is applied. Offering an update is not the same as
 * being trusted to supply one.
 */
import { isTauri } from './tauriBridge';

export interface UpdateCapability {
  supported: boolean;
  /** nsis | appimage | macos | system-package | dev */
  installKind: string;
  /** Set when `supported` is false: what the operator should do instead. */
  reason: string | null;
  currentVersion: string;
  /** Folder this machine offers packages from, so the UI can name it. */
  libraryDir?: string | null;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string | null;
  publishedAt: string | null;
  /** Where it came from: an origin on the network, or "the internet". */
  source: string;
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
 * Asks one place whether it has a newer build.
 *
 * `source` is the origin of another RemoteDesk machine; without one, the
 * release endpoint compiled into the app is asked. Returns `null` when there is
 * nothing newer, which is the ordinary case and not an error — a failure to
 * find out throws, so the caller can tell the two apart.
 *
 * The check runs in the host process rather than through the updater's own JS
 * API, because that API can only ask the endpoints fixed at build time, and the
 * whole point here is asking a machine whose address was not known then.
 */
export async function checkForUpdate(source?: string | null): Promise<AvailableUpdate | null> {
  const capability = await getUpdateCapability();
  if (!capability.supported) return null;

  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<AvailableUpdate | null>('check_for_update', { source: source ?? null });
}

/**
 * Asks each place in turn and stops at the first that has something newer.
 *
 * Machines on the network come before the internet deliberately: they are
 * faster, they work with the connection down, and on a pair of machines that
 * update each other they are the only source there is.
 */
export async function findUpdate(
  origins: string[],
  includeInternet = true,
  /** Injected in tests; the real one talks to the host process. */
  check: (source: string | null) => Promise<AvailableUpdate | null> = checkForUpdate
): Promise<{ update: AvailableUpdate | null; checked: string[]; failures: string[] }> {
  const checked: string[] = [];
  const failures: string[] = [];

  const sources: Array<string | null> = [...origins];
  if (includeInternet) sources.push(null);

  for (const source of sources) {
    const label = source ?? 'the internet';
    try {
      const found = await check(source);
      checked.push(label);
      if (found) return { update: found, checked, failures };
    } catch (err) {
      // One unreachable machine must not end the search; note it and move on.
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { update: null, checked, failures };
}

/**
 * Downloads and installs the update the last check found, reporting progress.
 *
 * The relaunch is what makes this an update rather than a download: the
 * operator clicks once and comes back to the new build.
 */
export async function installUpdate(
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');

  const stop = await listen<{ downloaded?: number; total?: number | null; finished?: boolean }>(
    'update://progress',
    (event) => {
      if (event.payload.finished) return;
      const downloaded = event.payload.downloaded ?? 0;
      const total = event.payload.total ?? null;
      onProgress?.({
        downloaded,
        total,
        percent: total && total > 0 ? Math.min(100, (downloaded / total) * 100) : null,
      });
    }
  );

  try {
    await invoke('install_found_update');
  } finally {
    stop();
  }

  // On Windows the installer takes over and closes the app itself; elsewhere we
  // restart into the version that was just written.
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

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
