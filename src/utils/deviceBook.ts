/**
 * The saved device book, as the UI sees it.
 *
 * Two backends, one shape. The app keeps the book in a file it owns, served
 * over its loopback endpoints, so the app window and the browser page the Linux
 * build hands the session to see the same devices. A page with no app behind it
 * — someone's phone opening a host's address — falls back to that browser's own
 * storage, which is private to it and good enough for the one machine it
 * connects to.
 */

export interface SavedDevice {
  /** Stable key; saving the same machine twice updates one entry. */
  id: string;
  name: string;
  /** Desk ID to join. Empty when the machine has not published one yet. */
  deskId: string;
  /** Where to look for it, in the order to try: LAN first, public last. */
  addresses: string[];
  /** The PIN that admits us, when the operator chose to save it. */
  pin?: string | null;
  lastConnected?: number | null;
  created?: number | null;
  note?: string | null;
}

const LOCAL_KEY = 'remotedesk_devices';

/** Where the app's endpoints live, when there is an app. */
let bookOrigin: string | null = null;

/** Tells the book which local server owns it. Called once at boot. */
export function setBookOrigin(origin: string | null): void {
  bookOrigin = origin;
}

function readLocal(): SavedDevice[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedDevice[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(devices: SavedDevice[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(devices));
  } catch {
    /* a private window with storage disabled still works, just forgetfully */
  }
}

/** Most recently connected first, then by name — the order a person expects. */
export function sortDevices(devices: SavedDevice[]): SavedDevice[] {
  return [...devices].sort(
    (a, b) =>
      (b.lastConnected ?? 0) - (a.lastConnected ?? 0) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
}

async function appRequest(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<unknown | null> {
  if (!bookOrigin) return null;
  try {
    const response = await fetchImpl(`${bookOrigin}${path}`, {
      ...init,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const defaultFetch = (): typeof fetch =>
  typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (undefined as unknown as typeof fetch);

export async function loadDevices(fetchImpl: typeof fetch = defaultFetch()): Promise<SavedDevice[]> {
  const answer = (await appRequest('/devices', { method: 'GET' }, fetchImpl)) as {
    devices?: SavedDevice[];
  } | null;
  if (answer && Array.isArray(answer.devices)) return sortDevices(answer.devices);
  return sortDevices(readLocal());
}

export async function saveDevice(
  device: SavedDevice,
  fetchImpl: typeof fetch = defaultFetch()
): Promise<SavedDevice> {
  const answer = (await appRequest(
    '/devices',
    { method: 'POST', body: JSON.stringify(device) },
    fetchImpl
  )) as { device?: SavedDevice } | null;
  if (answer?.device) return answer.device;

  const devices = readLocal();
  const index = devices.findIndex((d) => d.id === device.id);
  // A save that omits the PIN keeps the one already stored, so renaming a
  // device does not quietly throw away the secret that lets it connect.
  const merged =
    index >= 0 ? { ...devices[index], ...device, pin: device.pin ?? devices[index].pin } : device;
  if (index >= 0) devices[index] = merged;
  else devices.push(merged);
  writeLocal(devices);
  return merged;
}

export async function deleteDevice(
  id: string,
  fetchImpl: typeof fetch = defaultFetch()
): Promise<void> {
  const answer = await appRequest(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl);
  if (answer) return;
  writeLocal(readLocal().filter((d) => d.id !== id));
}

/** Records a successful connection, which is what orders the list. */
export async function touchDevice(
  id: string,
  fetchImpl: typeof fetch = defaultFetch()
): Promise<void> {
  const answer = await appRequest(
    `/devices/${encodeURIComponent(id)}/touch`,
    { method: 'POST' },
    fetchImpl
  );
  if (answer) return;
  const devices = readLocal();
  const device = devices.find((d) => d.id === id);
  if (device) {
    device.lastConnected = Math.floor(Date.now() / 1000);
    writeLocal(devices);
  }
}

/** A key for a machine, stable across saves of the same one. */
export function deviceKey(deskId: string, addresses: string[]): string {
  const host = addresses.length > 0 ? addresses[0] : '';
  const seed = `${deskId}|${host}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return seed || `device-${Date.now()}`;
}

/**
 * A single link that carries everything needed to connect back.
 *
 * Built on the host's own address so that pasting it into a browser opens the
 * client UI this host is already serving — the link is both an invitation and
 * a working page. Every other address it knows rides along, so the same link
 * keeps working from another network once a tunnel is running.
 */
export function makeConnectLink(device: {
  name?: string;
  deskId: string;
  addresses: string[];
  pin?: string | null;
}): string {
  const [primary, ...rest] = device.addresses;
  const base = primary ?? 'http://localhost:4000';
  const params = new URLSearchParams();
  params.set('desk', device.deskId);
  if (device.name) params.set('name', device.name);
  if (device.pin) params.set('pin', device.pin);
  for (const address of rest) params.append('at', address);
  return `${base.replace(/\/$/, '')}/#connect?${params.toString()}`;
}

/**
 * Reads a connect link, or any of the shorter things people paste instead.
 *
 * Accepted: a full connect link, a bare `903117@192.168.1.5:4000`, and a plain
 * Desk ID. Anything that yields no Desk ID is rejected rather than guessed at,
 * because a wrong guess here becomes a saved device that never connects.
 */
export function parseConnectLink(text: string): Omit<SavedDevice, 'id'> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const origin = `${url.protocol}//${url.host}`;
    // The parameters live after `#connect?`, which `URL` leaves in the hash.
    const query = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : url.search;
    const params = new URLSearchParams(query);
    const deskId = (params.get('desk') ?? url.hash.replace(/^#/, '')).trim();
    if (!/^\d{3,}$/.test(deskId)) return null;

    return {
      name: params.get('name')?.trim() || url.hostname,
      deskId,
      addresses: [origin, ...params.getAll('at').map((a) => a.trim()).filter(Boolean)],
      pin: params.get('pin')?.trim() || null,
    };
  }

  if (trimmed.includes('@')) {
    const [id, host] = trimmed.split('@');
    const deskId = id.replace(/\s+/g, '');
    if (!/^\d{3,}$/.test(deskId) || !host.trim()) return null;
    const address = /^https?:\/\//i.test(host.trim()) ? host.trim() : `http://${host.trim()}`;
    return { name: host.trim(), deskId, addresses: [address], pin: null };
  }

  const deskId = trimmed.replace(/\s+/g, '');
  if (!/^\d{3,}$/.test(deskId)) return null;
  return { name: `Desk ${deskId}`, deskId, addresses: [], pin: null };
}
