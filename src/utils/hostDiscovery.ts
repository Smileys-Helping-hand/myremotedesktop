/**
 * Finds RemoteDesk hosts on the local network.
 *
 * The client needs two things before it can join: the host's server address and
 * the Desk ID being shared there. Typing an IP address read off someone else's
 * screen is the step people get wrong, so this sweeps the networks this machine
 * is actually on and asks every responder what it is sharing.
 *
 * Two rules make the answer trustworthy rather than merely reassuring:
 * this machine's own addresses are never probed — its embedded signaling server
 * always answers, and reporting that as "a host was found" is worse than
 * finding nothing — and a responder counts as a host only if it says a desk is
 * being shared.
 */

/** One desk a discovered server reports sharing, from its `/hosts` endpoint. */
export interface DiscoveredDesk {
  /**
   * The Desk ID, or `null` when the server declined to publish it.
   *
   * A server withholds the ID of an unattended room that has no PIN, because
   * there the ID is the only thing standing between the LAN and control of the
   * machine. The desk still shows up; its ID has to be read off the host.
   */
  deskId: string | null;
  requiresPin: boolean;
  unattended: boolean;
  clients: number;
}

/** A RemoteDesk server that answered a probe. */
export interface DiscoveredHost {
  /** Origin to put in the client's Server Address field. */
  origin: string;
  /**
   * What the machine calls itself.
   *
   * `null` from a build too old to say, and from a plain in-page sweep of a
   * server that does not publish one — the address is then all there is to
   * show, which is exactly the puzzle this field exists to avoid.
   */
  name: string | null;
  /** Desks it is sharing. Empty when it is running but not hosting. */
  desks: DiscoveredDesk[];
  /** Rooms it reports, which is what makes it a host rather than a bystander. */
  rooms: number;
  connections: number;
}

export interface ScanOptions {
  /** Origin of this machine's own server, used to learn which networks to sweep. */
  selfOrigin?: string;
  /** Per-probe timeout. Unreachable addresses cost exactly this much. */
  timeoutMs?: number;
  /** Probes in flight at once. */
  concurrency?: number;
  /** Called as each address is retired, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
  /** Called the moment a host is found, so the UI can fill in as it goes. */
  onHost?: (host: DiscoveredHost) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_CONCURRENCY = 64;
/** Budget for the app's own sweep, which covers every address in one request. */
const NATIVE_SCAN_TIMEOUT_MS = 45_000;
/** Last usable host in a /24, and the count of addresses swept per network. */
const SUBNET_HOSTS = 254;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Splits `http://192.168.1.5:4000` into its address and port. */
export function parseLanAddress(url: string): { ip: string; port: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!IPV4.test(parsed.hostname)) return null;
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { ip: parsed.hostname, port };
}

/**
 * Every address worth probing, given the addresses this machine holds.
 *
 * Each address contributes its whole /24: a host on the same network is
 * reachable at some address in it, and nothing narrower would have found the
 * machine we are looking for. Our own addresses are dropped — see the note at
 * the top of this file for why finding ourselves is a bug, not a result.
 */
export function candidateOrigins(lanAddresses: string[]): string[] {
  const own = new Set<string>();
  const networks: Array<{ prefix: string; port: number }> = [];

  for (const address of lanAddresses) {
    const parsed = parseLanAddress(address);
    if (!parsed) continue;
    own.add(`${parsed.ip}:${parsed.port}`);
    const prefix = parsed.ip.slice(0, parsed.ip.lastIndexOf('.') + 1);
    if (!networks.some((n) => n.prefix === prefix && n.port === parsed.port)) {
      networks.push({ prefix, port: parsed.port });
    }
  }

  const origins: string[] = [];
  for (const { prefix, port } of networks) {
    for (let last = 1; last <= SUBNET_HOSTS; last++) {
      const ip = `${prefix}${last}`;
      if (own.has(`${ip}:${port}`)) continue;
      origins.push(`http://${ip}:${port}`);
    }
  }
  return origins;
}

/** Fetches JSON with a deadline, resolving to `null` on any failure. */
async function fetchJson<T>(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  outerSignal?: AbortSignal
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortOuter = () => controller.abort();
  outerSignal?.addEventListener('abort', abortOuter);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', abortOuter);
  }
}

/**
 * Asks one address what it is, and what it is sharing.
 *
 * Three server generations have to be understood here, because the host we are
 * looking for is usually the one we cannot upgrade:
 *
 * - `/hosts` is the full answer, with a Desk ID per room.
 * - Before it existed, `/network-info` carried `activeRooms`, a plain list of
 *   Desk IDs. A host running that build is still fully usable.
 * - Older still, only the room *count*. The address is then all we can offer,
 *   and the operator reads the Desk ID off the host's screen.
 *
 * A missing `/hosts` is therefore not a failure. Note that it may 404 *or*
 * answer 200 with the frontend's index.html, since the server serving the UI
 * falls back to it for unknown paths — which is why the JSON shape is checked
 * rather than the status code.
 */
export async function probeOrigin(
  origin: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<DiscoveredHost | null> {
  const info = await fetchJson<{
    rooms?: number;
    connections?: number;
    activeRooms?: unknown;
    name?: unknown;
  }>(`${origin}/network-info`, timeoutMs, fetchImpl, signal);
  if (!info || typeof info.rooms !== 'number') return null;

  const listing = await fetchJson<{ hosts?: DiscoveredDesk[]; name?: unknown }>(
    `${origin}/hosts`,
    timeoutMs,
    fetchImpl,
    signal
  );

  const desks = desksFrom(listing?.hosts, info.activeRooms);

  return {
    origin,
    name: readName(listing?.name) ?? readName(info.name),
    rooms: info.rooms,
    connections: typeof info.connections === 'number' ? info.connections : 0,
    desks,
  };
}

/** A machine name worth showing, or nothing. */
function readName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Reads the desks a server reported, from whichever field it has.
 *
 * `activeRooms` says nothing about PINs, so nothing is claimed about them: the
 * client finds out when it tries to join, which is the same thing that happens
 * when an ID is typed by hand. This is the one place that rule lives — the
 * native scanner forwards both fields untouched so it does not have to repeat
 * it.
 */
export function desksFrom(hosts: unknown, activeRooms: unknown): DiscoveredDesk[] {
  if (Array.isArray(hosts)) return hosts as DiscoveredDesk[];
  if (!Array.isArray(activeRooms)) return [];
  return activeRooms
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((deskId) => ({ deskId, requiresPin: false, unattended: false, clients: 0 }));
}

/** Runs `worker` over `items`, `limit` at a time, in order of completion. */
async function pool<T>(
  items: string[],
  limit: number,
  worker: (item: string) => Promise<T>
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Addresses this machine holds on the networks it is attached to.
 *
 * The embedded server enumerates the real interfaces, which a browser cannot
 * do. When it is not reachable — a plain browser pointed at someone else's
 * server — the page's own hostname is the one local address available, and its
 * network is the right one to sweep.
 */
async function localAddresses(
  selfOrigin: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<string[]> {
  if (selfOrigin) {
    const info = await fetchJson<{ lanAddresses?: string[] }>(
      `${selfOrigin}/network-info`,
      timeoutMs,
      fetchImpl,
      signal
    );
    if (info && Array.isArray(info.lanAddresses) && info.lanAddresses.length > 0) {
      return info.lanAddresses;
    }
  }
  if (typeof window !== 'undefined' && IPV4.test(window.location.hostname)) {
    const port = window.location.port || '4000';
    return [`http://${window.location.hostname}:${port}`];
  }
  return [];
}

export interface ScanResult {
  hosts: DiscoveredHost[];
  /** Addresses probed, so "found nothing" can say what it looked at. */
  scanned: number;
  /** Networks swept, as `192.168.1.x` strings, for the same reason. */
  networks: string[];
}

/**
 * Asks the local app to sweep the network, which it does far better than a page can.
 *
 * A browser holds one small socket pool, and an address with nothing at it ties
 * up a connect attempt until the OS gives up — aborting the `fetch` does not
 * hand the socket back. Sweeping a /24 therefore starves the live addresses:
 * measured on a real network, every host timed out behind 500 dead ones while
 * answering curl perfectly well. The app has no such limit, so it is asked
 * first and the in-page sweep is kept only for a browser with no app behind it.
 *
 * The whole sweep is one request, so it gets a deadline of its own rather than
 * the per-probe one.
 */
async function nativeScan(
  selfOrigin: string | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<ScanResult | null> {
  if (!selfOrigin) return null;

  const report = await fetchJson<{
    hosts?: Array<{
      origin?: string;
      name?: unknown;
      rooms?: number;
      connections?: number;
      hosts?: unknown;
      activeRooms?: unknown;
    }>;
    scanned?: number;
    networks?: string[];
  }>(`${selfOrigin}/discover`, NATIVE_SCAN_TIMEOUT_MS, fetchImpl, signal);

  if (!report || !Array.isArray(report.hosts)) return null;

  return {
    hosts: report.hosts
      .filter((host) => typeof host.origin === 'string' && typeof host.rooms === 'number')
      .map((host) => ({
        origin: host.origin as string,
        name: readName(host.name),
        rooms: host.rooms as number,
        connections: typeof host.connections === 'number' ? host.connections : 0,
        desks: desksFrom(host.hosts, host.activeRooms),
      })),
    scanned: typeof report.scanned === 'number' ? report.scanned : 0,
    networks: Array.isArray(report.networks) ? report.networks : [],
  };
}

/**
 * Sweeps the local networks and returns every RemoteDesk server found.
 *
 * Hosts that are actually sharing sort first: that is what the operator is
 * looking for, and a machine merely running the app is noise beside it.
 */
export async function scanForHosts(options: ScanOptions = {}): Promise<ScanResult> {
  const {
    selfOrigin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress,
    onHost,
    fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined,
    signal,
  } = options;

  if (!fetchImpl) return { hosts: [], scanned: 0, networks: [] };

  const native = await nativeScan(selfOrigin, fetchImpl, signal);
  if (native) {
    native.hosts.forEach((host) => onHost?.(host));
    onProgress?.(native.scanned, native.scanned);
    return native;
  }

  const addresses = await localAddresses(selfOrigin, timeoutMs, fetchImpl, signal);
  const candidates = candidateOrigins(addresses);
  const networks = Array.from(
    new Set(
      addresses
        .map((a) => parseLanAddress(a))
        .filter((a): a is { ip: string; port: number } => a !== null)
        .map((a) => `${a.ip.slice(0, a.ip.lastIndexOf('.') + 1)}x`)
    )
  );

  const hosts: DiscoveredHost[] = [];
  let done = 0;

  await pool(candidates, concurrency, async (origin) => {
    if (signal?.aborted) return;
    const host = await probeOrigin(origin, timeoutMs, fetchImpl, signal);
    done++;
    onProgress?.(done, candidates.length);
    if (host) {
      hosts.push(host);
      onHost?.(host);
    }
  });

  hosts.sort((a, b) => b.rooms - a.rooms || a.origin.localeCompare(b.origin));
  return { hosts, scanned: candidates.length, networks };
}

/** What to call a discovered machine in a list a person reads. */
export function hostLabel(host: DiscoveredHost): string {
  return host.name ?? host.origin.replace(/^https?:\/\//, '');
}

/** Whether a discovered server has a desk a client could join right now. */
export function isSharing(host: DiscoveredHost): boolean {
  return host.rooms > 0 || host.desks.length > 0;
}

/** The Desk ID to prefill from a discovered host, when it published exactly one. */
export function autofillDeskId(host: DiscoveredHost): string | null {
  const ids = host.desks.map((d) => d.deskId).filter((id): id is string => Boolean(id));
  return ids.length === 1 ? ids[0] : null;
}
