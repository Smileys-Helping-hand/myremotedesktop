/**
 * Describing the desktop installers a server is offering.
 *
 * Both servers expose the same `/api/downloads` shape — the Node relay
 * (`server/index.ts`) and the app's embedded server (`src-tauri/src/signaling.rs`)
 * — so the UI does not care which one served the page. The classification below
 * is the single place that decides what a filename means, and it is shared by
 * the UI and the tests.
 */

export type InstallerPlatform = 'windows' | 'linux' | 'macos';

export type InstallerKind = 'exe' | 'msi' | 'deb' | 'rpm' | 'appimage' | 'dmg' | 'unknown';

export interface InstallerAsset {
  /** Bare filename, as offered by the server. */
  file: string;
  platform: InstallerPlatform;
  kind: InstallerKind;
  sizeBytes: number;
  /** Path or absolute URL to fetch it from. */
  url: string;
}

export interface DownloadsResponse {
  /** Version the offered files belong to, when it could be read from a name. */
  version: string | null;
  assets: InstallerAsset[];
  /** Canonical release page, always present as a fallback. */
  releasesUrl: string;
}

export const RELEASES_URL =
  'https://github.com/Smileys-Helping-hand/myremotedesktop/releases';

/** File extensions a server is allowed to offer as an installer. */
export const INSTALLER_EXTENSIONS = [
  '.exe',
  '.msi',
  '.deb',
  '.rpm',
  '.AppImage',
  '.dmg',
] as const;

/**
 * Classifies an installer filename.
 *
 * Extension-driven rather than name-driven: the product name and version
 * formatting have already changed once, and the extension is the part that
 * actually determines which OS can run the file.
 */
export function classifyInstaller(file: string): {
  platform: InstallerPlatform;
  kind: InstallerKind;
} {
  const lower = file.toLowerCase();
  if (lower.endsWith('.exe')) return { platform: 'windows', kind: 'exe' };
  if (lower.endsWith('.msi')) return { platform: 'windows', kind: 'msi' };
  if (lower.endsWith('.deb')) return { platform: 'linux', kind: 'deb' };
  if (lower.endsWith('.rpm')) return { platform: 'linux', kind: 'rpm' };
  if (lower.endsWith('.appimage')) return { platform: 'linux', kind: 'appimage' };
  if (lower.endsWith('.dmg')) return { platform: 'macos', kind: 'dmg' };
  return { platform: 'linux', kind: 'unknown' };
}

/** Human label for a package kind, including who it suits. */
export function describeInstaller(kind: InstallerKind): {
  title: string;
  detail: string;
} {
  switch (kind) {
    case 'exe':
      return {
        title: 'Windows installer',
        detail: 'Windows 10 or 11, 64-bit. Updates itself from inside the app.',
      };
    case 'msi':
      return {
        title: 'Windows (MSI)',
        detail: 'For deployment through group policy.',
      };
    case 'appimage':
      return {
        title: 'Linux AppImage',
        detail:
          'Any distribution. Nothing to install — mark it executable and run it. Updates itself from inside the app.',
      };
    case 'deb':
      return {
        title: 'Debian / Ubuntu',
        detail: 'Installs with apt. Updates come from your package manager, not from inside the app.',
      };
    case 'rpm':
      return {
        title: 'Fedora / RHEL',
        detail: 'Installs with dnf. Updates come from your package manager, not from inside the app.',
      };
    case 'dmg':
      return { title: 'macOS', detail: 'Apple silicon and Intel.' };
    default:
      return { title: 'Installer', detail: '' };
  }
}

/**
 * Reads a semantic version out of an installer filename.
 *
 * Names differ per bundler — `RemoteDesk_1.1.0_x64-setup.exe`,
 * `RemoteDesk-1.1.0-1.x86_64.rpm` — so this looks for the version pattern
 * rather than a fixed position.
 */
export function versionFromFilename(file: string): string | null {
  const match = file.match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

/** Compact size for a download button: "81.5 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Guesses which download this visitor most likely wants, so it can be shown
 * first. Only ever reorders — every asset stays available, because a visitor
 * may well be fetching an installer for a different machine.
 */
export function guessVisitorPlatform(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): InstallerPlatform | null {
  const ua = userAgent.toLowerCase();
  // Android reports "linux" too, and wants neither desktop build.
  if (ua.includes('android')) return null;
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('linux') || ua.includes('x11')) return 'linux';
  return null;
}

/** Preferred download first, then a stable order so the list never jitters. */
export function sortAssets(
  assets: InstallerAsset[],
  preferred: InstallerPlatform | null
): InstallerAsset[] {
  const kindRank: Record<InstallerKind, number> = {
    exe: 0,
    msi: 1,
    appimage: 0,
    deb: 1,
    rpm: 2,
    dmg: 0,
    unknown: 9,
  };
  return [...assets].sort((a, b) => {
    if (preferred) {
      const aPref = a.platform === preferred ? 0 : 1;
      const bPref = b.platform === preferred ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
    }
    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
    if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
    return a.file.localeCompare(b.file);
  });
}

/**
 * Fetches what this server offers.
 *
 * A server with no installers on disk is normal, not an error — the UI then
 * points at the release page instead.
 */
export async function fetchDownloads(origin?: string): Promise<DownloadsResponse> {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  try {
    const res = await fetch(`${base}/api/downloads`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Partial<DownloadsResponse>;
    return {
      version: body.version ?? null,
      assets: Array.isArray(body.assets) ? body.assets : [],
      releasesUrl: body.releasesUrl || RELEASES_URL,
    };
  } catch {
    return { version: null, assets: [], releasesUrl: RELEASES_URL };
  }
}
