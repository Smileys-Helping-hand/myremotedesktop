/**
 * The public relay: where two machines on different networks meet.
 *
 * On one network the host's own embedded server is all anybody needs. Across
 * the internet neither machine can dial the other's private address, so both
 * also talk to a relay they can each reach (`relay/` in this repository, a
 * Cloudflare Worker). A host registers its Desk ID there as well as at home; a
 * client that cannot find the desk nearby asks the relay next. Only the
 * WebRTC handshake passes through it — the screen and the input still travel
 * directly between the two machines.
 *
 * `remotedesk_relay_url` in localStorage points the app at a different relay,
 * or turns it off with the value `off`.
 */

/** The relay this build was published with. */
export const DEFAULT_PUBLIC_RELAY_URL = 'https://relay.savestate.co.za';

const STORAGE_KEY = 'remotedesk_relay_url';

/** Keep-alive interval for a relay socket; see `SignalingOptions.keepAliveMs`. */
export const RELAY_KEEPALIVE_MS = 30_000;

function normalize(url: string): string {
  let raw = url.trim();
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/** The relay to use, or `null` when it has been switched off. */
export function getPublicRelayUrl(): string | null {
  let configured: string | null = null;
  try {
    configured = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    /* storage blocked: use the default */
  }
  if (configured !== null) {
    const value = configured.trim();
    if (value === '' || value.toLowerCase() === 'off') return null;
    return normalize(value);
  }
  return DEFAULT_PUBLIC_RELAY_URL ? normalize(DEFAULT_PUBLIC_RELAY_URL) : null;
}

/** Points the app at another relay; `null` restores the default, `'off'` disables it. */
export function setPublicRelayUrl(url: string | null): void {
  try {
    if (url === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, url);
  } catch {
    /* storage blocked */
  }
}

/** Whether `url` is the public relay rather than some machine's own server. */
export function isPublicRelay(url: string | null | undefined): boolean {
  const relay = getPublicRelayUrl();
  if (!relay || !url) return false;
  return normalize(url) === relay;
}

/**
 * Whether a join failure means "not here — try the relay".
 *
 * Only failures about *where* the desk is qualify. A desk that was found and
 * refused us (wrong password, the host said no) must not be retried somewhere
 * else, or a refusal would read as a second, confusing error.
 */
export function shouldTryRelay(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /No host is currently sharing|Cannot reach signaling server/i.test(reason);
}

/** Where a host stands on the relay, for the Host tab to show. */
export type RelayStatus =
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'refused'; reason: string };
