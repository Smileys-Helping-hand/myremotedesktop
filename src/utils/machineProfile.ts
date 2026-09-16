/**
 * This machine's identity as the UI sees it: Desk ID, name, and access rule.
 *
 * The Desk ID used to be drawn at random when the Host tab mounted, which made
 * it useless as an identity — it changed on every launch and every reload, so
 * nothing could be saved against it and every link shared went stale. It is now
 * issued once and kept: by the app in its config directory, or, for a page with
 * no app behind it, by that browser's own storage.
 */

/** How a host decides whether to admit a client. */
export type AccessMode = 'open' | 'password' | 'rotating' | 'ask';

export interface MachineProfile {
  deskId: string;
  name: string;
  accessMode: AccessMode;
  /** The fixed password, when the mode is `password`. */
  accessPassword?: string | null;
}

const LOCAL_KEY = 'remotedesk_profile';

let profileOrigin: string | null = null;

/** Tells the profile which local server owns it. Called once at boot. */
export function setProfileOrigin(origin: string | null): void {
  profileOrigin = origin;
}

function randomDeskId(): string {
  const random = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(random);
  } else {
    random[0] = Math.floor(Math.random() * 0xffffffff);
  }
  return String((random[0] % 900000) + 100000);
}

function defaultName(): string {
  if (typeof window === 'undefined') return 'RemoteDesk host';
  return window.location.hostname || 'RemoteDesk host';
}

function readLocal(): MachineProfile {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MachineProfile>;
      if (parsed.deskId) {
        return {
          deskId: parsed.deskId,
          name: parsed.name || defaultName(),
          // Asking is the default everywhere: it is the only rule that cannot
          // surprise the owner of the machine.
          accessMode: parsed.accessMode ?? 'ask',
          accessPassword: parsed.accessPassword ?? null,
        };
      }
    }
  } catch {
    /* fall through to a fresh identity */
  }
  const fresh: MachineProfile = {
    deskId: randomDeskId(),
    name: defaultName(),
    accessMode: 'ask',
    accessPassword: null,
  };
  writeLocal(fresh);
  return fresh;
}

function writeLocal(profile: MachineProfile): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(profile));
  } catch {
    /* a page with storage disabled gets a per-session identity */
  }
}

/** The app declining a change, as opposed to there being no app at all. */
class ProfileRefused extends Error {}

const defaultFetch = (): typeof fetch =>
  typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (undefined as unknown as typeof fetch);

/** Reads this machine's profile, from the app when there is one. */
export async function loadProfile(
  fetchImpl: typeof fetch = defaultFetch()
): Promise<MachineProfile> {
  if (profileOrigin) {
    try {
      const response = await fetchImpl(`${profileOrigin}/profile`, { cache: 'no-store' });
      if (response.ok) {
        const profile = (await response.json()) as MachineProfile;
        if (profile?.deskId) return profile;
      }
    } catch {
      /* no app behind this page */
    }
  }
  return readLocal();
}

/** Applies a change. Returns the profile as it now stands. */
export async function updateProfile(
  change: Partial<Pick<MachineProfile, 'name' | 'accessMode' | 'accessPassword'>>,
  fetchImpl: typeof fetch = defaultFetch()
): Promise<MachineProfile> {
  if (profileOrigin) {
    try {
      const response = await fetchImpl(`${profileOrigin}/profile`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (response.ok) return (await response.json()) as MachineProfile;
      // Only the app answers 400, and only to say why it will not do this —
      // "set a password before choosing password access" is a correction the
      // operator must see. Every other status means there is no app behind
      // this page (a relay serving the UI answers 404 here), and the page then
      // keeps its own identity rather than reporting a failure that is not one.
      if (response.status === 400) {
        throw new ProfileRefused((await response.text()) || 'the app refused that change');
      }
    } catch (err) {
      if (err instanceof ProfileRefused) throw err;
      /* otherwise there is no app here; fall through to local storage */
    }
  }

  const updated = { ...readLocal(), ...change };
  if (updated.accessMode === 'password' && !updated.accessPassword?.trim()) {
    throw new Error('set a password before choosing password access');
  }
  writeLocal(updated);
  return updated;
}

/**
 * The PIN a host registers with, for a given access rule.
 *
 * `open` and `ask` register no PIN — for opposite reasons. Open means the Desk
 * ID is enough; ask means no PIN could decide it anyway, and the room carries
 * `requireApproval` instead, because a room with no PIN admits everyone.
 */
export function registrationSecret(
  profile: MachineProfile,
  rotatingPin: string
): { pin?: string; unattended: boolean; requireApproval: boolean } {
  switch (profile.accessMode) {
    case 'open':
      return { pin: undefined, unattended: true, requireApproval: false };
    case 'password':
      return {
        pin: profile.accessPassword?.trim() || undefined,
        unattended: false,
        requireApproval: false,
      };
    case 'rotating':
      return { pin: rotatingPin, unattended: false, requireApproval: false };
    case 'ask':
    default:
      return { pin: undefined, unattended: false, requireApproval: true };
  }
}
