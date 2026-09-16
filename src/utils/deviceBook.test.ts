import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDevice,
  deviceKey,
  loadDevices,
  makeConnectLink,
  parseConnectLink,
  saveDevice,
  setBookOrigin,
  sortDevices,
  touchDevice,
  SavedDevice,
} from './deviceBook';

const laptop: SavedDevice = {
  id: 'laptop',
  name: 'Linux laptop',
  deskId: '903117',
  addresses: ['http://192.168.31.206:4000'],
  pin: 'TEST12',
};

beforeEach(() => {
  localStorage.clear();
  setBookOrigin(null);
});

describe('the browser-storage fallback', () => {
  it('saves and reads back a device when there is no app behind the page', async () => {
    await saveDevice(laptop);
    const devices = await loadDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].deskId).toBe('903117');
    expect(devices[0].pin).toBe('TEST12');
  });

  it('keeps the saved PIN when a later save omits it', async () => {
    // Renaming a device must not quietly throw away the secret that is the
    // whole reason connecting is one click.
    await saveDevice(laptop);
    await saveDevice({ ...laptop, name: 'Renamed', pin: undefined });
    const [device] = await loadDevices();
    expect(device.name).toBe('Renamed');
    expect(device.pin).toBe('TEST12');
  });

  it('forgets a device', async () => {
    await saveDevice(laptop);
    await deleteDevice('laptop');
    expect(await loadDevices()).toEqual([]);
  });

  it('stamps a connection so the device rises to the top', async () => {
    await saveDevice(laptop);
    await saveDevice({ ...laptop, id: 'other', name: 'Other', lastConnected: 5 });
    await touchDevice('laptop');
    const devices = await loadDevices();
    expect(devices[0].id).toBe('laptop');
  });

  it('survives storage that is unavailable or holds junk', async () => {
    localStorage.setItem('remotedesk_devices', 'not json');
    expect(await loadDevices()).toEqual([]);
  });
});

describe('the app-backed book', () => {
  it('reads and writes through the app when one is there', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/devices') && (!init || init.method === 'GET')) {
        return { ok: true, json: async () => ({ devices: [laptop] }) } as Response;
      }
      if (url.endsWith('/devices') && init?.method === 'POST') {
        return { ok: true, json: async () => ({ device: laptop }) } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    setBookOrigin('http://127.0.0.1:4000');
    expect(await loadDevices(fetchImpl)).toEqual([laptop]);
    expect(await saveDevice(laptop, fetchImpl)).toEqual(laptop);
    // Nothing leaked into browser storage: the app owns the book.
    expect(localStorage.getItem('remotedesk_devices')).toBeNull();
  });

  it('falls back to browser storage when the app does not answer', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    setBookOrigin('http://127.0.0.1:4000');
    await saveDevice(laptop, fetchImpl);
    expect(await loadDevices(fetchImpl)).toHaveLength(1);
  });
});

describe('sortDevices', () => {
  it('puts the most recently connected first, then sorts by name', () => {
    const order = sortDevices([
      { ...laptop, id: 'c', name: 'Zed' },
      { ...laptop, id: 'a', name: 'Alpha' },
      { ...laptop, id: 'b', name: 'Beta', lastConnected: 99 },
    ]).map((d) => d.id);
    expect(order).toEqual(['b', 'a', 'c']);
  });
});

describe('connect links', () => {
  it('round-trips everything a connection needs', () => {
    const link = makeConnectLink({
      name: 'Windows PC',
      deskId: '784920',
      addresses: ['http://192.168.31.217:4000', 'https://busy-fox.trycloudflare.com'],
      pin: 'AB12',
    });
    const parsed = parseConnectLink(link);
    expect(parsed).toEqual({
      name: 'Windows PC',
      deskId: '784920',
      addresses: ['http://192.168.31.217:4000', 'https://busy-fox.trycloudflare.com'],
      pin: 'AB12',
    });
  });

  it('keeps the LAN address ahead of the tunnel', () => {
    // Reversed, every local connection would be routed over the internet.
    const parsed = parseConnectLink(
      makeConnectLink({
        deskId: '784920',
        addresses: ['http://192.168.31.217:4000', 'https://busy-fox.trycloudflare.com'],
      })
    );
    expect(parsed?.addresses[0]).toBe('http://192.168.31.217:4000');
  });

  it('accepts the shorter things people paste', () => {
    expect(parseConnectLink('903117@192.168.31.206:4000')).toEqual({
      name: '192.168.31.206:4000',
      deskId: '903117',
      addresses: ['http://192.168.31.206:4000'],
      pin: null,
    });
    expect(parseConnectLink('  903 117 ')).toEqual({
      name: 'Desk 903117',
      deskId: '903117',
      addresses: [],
      pin: null,
    });
  });

  it('refuses anything without a Desk ID rather than guessing', () => {
    // A guessed ID becomes a saved device that never connects, and the operator
    // has no way to see why.
    expect(parseConnectLink('http://192.168.31.206:4000/')).toBeNull();
    expect(parseConnectLink('not a link')).toBeNull();
    expect(parseConnectLink('')).toBeNull();
    expect(parseConnectLink('@192.168.1.5')).toBeNull();
  });
});

describe('deviceKey', () => {
  it('gives the same machine the same key twice', () => {
    expect(deviceKey('903117', ['http://192.168.31.206:4000'])).toBe(
      deviceKey('903117', ['http://192.168.31.206:4000'])
    );
  });

  it('separates two desks on one address', () => {
    expect(deviceKey('903117', ['http://x:4000'])).not.toBe(deviceKey('111111', ['http://x:4000']));
  });
});
