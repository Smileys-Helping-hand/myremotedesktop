import { describe, expect, it, vi } from 'vitest';
import {
  autofillDeskId,
  candidateOrigins,
  hostLabel,
  isSharing,
  parseLanAddress,
  probeOrigin,
  scanForHosts,
  DiscoveredHost,
} from './hostDiscovery';

describe('parseLanAddress', () => {
  it('splits an address into host and port', () => {
    expect(parseLanAddress('http://192.168.1.5:4000')).toEqual({ ip: '192.168.1.5', port: 4000 });
  });

  it('rejects anything that is not a literal IPv4 address', () => {
    // A hostname gives no network to sweep, and a tunnel URL is not on the LAN.
    expect(parseLanAddress('http://laptop.local:4000')).toBeNull();
    expect(parseLanAddress('https://busy-fox.trycloudflare.com')).toBeNull();
    expect(parseLanAddress('not a url')).toBeNull();
  });
});

describe('candidateOrigins', () => {
  it('sweeps the whole /24 of each address this machine holds', () => {
    const origins = candidateOrigins(['http://192.168.1.23:4000']);
    expect(origins).toContain('http://192.168.1.1:4000');
    expect(origins).toContain('http://192.168.1.254:4000');
    // .1 to .254 on the default port and the one above it, minus ourselves.
    expect(origins).toHaveLength(253 + 254);
  });

  it('looks on the default port even when this machine had to move off it', () => {
    // The failure this prevents: something unrelated holds 4000 here, so we
    // settled for 4001 — and then searched the network for peers on 4001 while
    // every one of them sat on 4000.
    const origins = candidateOrigins(['http://192.168.1.23:4001']);
    expect(origins).toContain('http://192.168.1.206:4000');
    expect(origins).toContain('http://192.168.1.206:4001');
  });

  it('never probes this machine', () => {
    // The embedded server always answers here, so probing it would report a
    // host on every scan while the real host stayed undiscovered.
    const origins = candidateOrigins(['http://192.168.1.23:4000']);
    expect(origins).not.toContain('http://192.168.1.23:4000');
  });

  it('covers every network the machine is attached to, without duplicates', () => {
    const origins = candidateOrigins([
      'http://192.168.1.23:4000',
      'http://10.0.0.7:4000',
      'http://192.168.1.23:4000',
    ]);
    expect(origins).toContain('http://10.0.0.200:4000');
    expect(origins).toContain('http://192.168.1.200:4000');
    expect(new Set(origins).size).toBe(origins.length);
  });

  it('ignores addresses it cannot read', () => {
    expect(candidateOrigins(['https://example.trycloudflare.com', 'nonsense'])).toEqual([]);
  });
});

/** A fetch that answers only for the origins named, and fails everywhere else. */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!(url in routes)) throw new Error('ECONNREFUSED');
    return {
      ok: true,
      json: async () => routes[url],
    } as Response;
  }) as unknown as typeof fetch;
}

describe('probeOrigin', () => {
  it('reports a host and the desks it is sharing', async () => {
    const fetchImpl = fakeFetch({
      'http://192.168.1.50:4000/network-info': { rooms: 1, connections: 2 },
      'http://192.168.1.50:4000/hosts': {
        hosts: [{ deskId: '684128', requiresPin: true, unattended: false, clients: 0 }],
      },
    });
    const host = await probeOrigin('http://192.168.1.50:4000', 50, fetchImpl);
    expect(host?.rooms).toBe(1);
    expect(host?.desks[0].deskId).toBe('684128');
  });

  it('reads Desk IDs from activeRooms when the host predates /hosts', async () => {
    // This is the shape the release in the field answers with, and it carries
    // everything needed to join — so discovery must not throw it away.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/network-info')) {
        return {
          ok: true,
          json: async () => ({ rooms: 1, connections: 1, activeRooms: ['957473'] }),
        } as Response;
      }
      // An unknown path falls through to the frontend, not a 404.
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError('not JSON');
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const host = await probeOrigin('http://192.168.31.166:4000', 50, fetchImpl);
    expect(host?.desks).toEqual([
      { deskId: '957473', requiresPin: false, unattended: false, clients: 0 },
    ]);
    expect(autofillDeskId(host!)).toBe('957473');
  });

  it('still reports a host whose build predates /hosts', async () => {
    // The Linux release in the field answers 404 there. Its address is still
    // exactly what the operator needs; only the Desk ID must be typed.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/network-info')) {
        return { ok: true, json: async () => ({ rooms: 1, connections: 1 }) } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const host = await probeOrigin('http://192.168.1.50:4000', 50, fetchImpl);
    expect(host?.rooms).toBe(1);
    expect(host?.desks).toEqual([]);
  });

  it('returns nothing for an address that is not RemoteDesk', async () => {
    const fetchImpl = fakeFetch({ 'http://192.168.1.51:4000/network-info': { status: 'ok' } });
    expect(await probeOrigin('http://192.168.1.51:4000', 50, fetchImpl)).toBeNull();
    expect(await probeOrigin('http://192.168.1.99:4000', 50, fetchImpl)).toBeNull();
  });
});

describe('scanForHosts', () => {
  it('finds the host on the network and leaves this machine out of the results', async () => {
    const fetchImpl = fakeFetch({
      // This machine, which is also running a server.
      'http://127.0.0.1:4000/network-info': {
        rooms: 0,
        connections: 0,
        lanAddresses: ['http://192.168.1.23:4000'],
      },
      'http://192.168.1.23:4000/network-info': { rooms: 0, connections: 0 },
      // The laptop actually sharing a screen.
      'http://192.168.1.77:4000/network-info': { rooms: 1, connections: 1 },
      'http://192.168.1.77:4000/hosts': {
        hosts: [{ deskId: '481902', requiresPin: false, unattended: false, clients: 0 }],
      },
    });

    const result = await scanForHosts({
      selfOrigin: 'http://127.0.0.1:4000',
      timeoutMs: 50,
      fetchImpl,
    });

    expect(result.hosts.map((h) => h.origin)).toEqual(['http://192.168.1.77:4000']);
    expect(result.networks).toEqual(['192.168.1.x']);
    expect(result.scanned).toBe(253 + 254);
  });

  it('puts servers that are actually sharing first', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:4000/network-info': {
        rooms: 0,
        connections: 0,
        lanAddresses: ['http://192.168.1.23:4000'],
      },
      'http://192.168.1.10:4000/network-info': { rooms: 0, connections: 0 },
      'http://192.168.1.77:4000/network-info': { rooms: 1, connections: 1 },
    });

    const { hosts } = await scanForHosts({
      selfOrigin: 'http://127.0.0.1:4000',
      timeoutMs: 50,
      fetchImpl,
    });

    expect(hosts.map((h) => h.origin)).toEqual([
      'http://192.168.1.77:4000',
      'http://192.168.1.10:4000',
    ]);
  });

  it('uses the local app to sweep when it can, instead of probing from the page', async () => {
    // The page cannot sweep a subnet reliably — see the note in nativeScan —
    // so when the local app offers /discover, that answer is the whole result.
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:4000/discover': {
        scanned: 506,
        networks: ['192.168.31.x'],
        hosts: [
          {
            origin: 'http://192.168.31.166:4000',
            rooms: 1,
            connections: 1,
            activeRooms: ['957473'],
          },
        ],
      },
    });

    const found: string[] = [];
    const result = await scanForHosts({
      selfOrigin: 'http://127.0.0.1:4000',
      fetchImpl,
      onHost: (host) => found.push(host.origin),
    });

    expect(result.scanned).toBe(506);
    expect(result.hosts).toHaveLength(1);
    expect(autofillDeskId(result.hosts[0])).toBe('957473');
    expect(found).toEqual(['http://192.168.31.166:4000']);
    // No per-address probing happened: the page never touched the subnet.
    const probed = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => String(call[0])
    );
    expect(probed.some((url: string) => url.includes('192.168.31.1:4000'))).toBe(false);
  });

  it('scans nothing when it cannot learn a local address', async () => {
    const fetchImpl = fakeFetch({});
    const result = await scanForHosts({ selfOrigin: 'http://127.0.0.1:4000', fetchImpl });
    expect(result).toEqual({ hosts: [], scanned: 0, networks: [] });
  });
});

describe('naming a discovered host', () => {
  it('prefers the name the machine gave over its address', async () => {
    const fetchImpl = fakeFetch({
      'http://192.168.1.50:4000/network-info': { rooms: 1, connections: 0, name: 'Linux laptop' },
      'http://192.168.1.50:4000/hosts': { name: 'Linux laptop', hosts: [] },
    });
    const host = await probeOrigin('http://192.168.1.50:4000', 50, fetchImpl);
    expect(host?.name).toBe('Linux laptop');
    expect(hostLabel(host!)).toBe('Linux laptop');
  });

  it('falls back to the address when the machine is too old to say', async () => {
    // An address is a poor label, but it is honest — inventing a name would
    // put something in the list that matches nothing on the other screen.
    const fetchImpl = fakeFetch({
      'http://192.168.1.50:4000/network-info': { rooms: 1, connections: 0 },
    });
    const host = await probeOrigin('http://192.168.1.50:4000', 50, fetchImpl);
    expect(host?.name).toBeNull();
    expect(hostLabel(host!)).toBe('192.168.1.50:4000');
  });

  it('ignores a blank name rather than showing an empty row', async () => {
    const fetchImpl = fakeFetch({
      'http://192.168.1.50:4000/network-info': { rooms: 1, connections: 0, name: '   ' },
    });
    const host = await probeOrigin('http://192.168.1.50:4000', 50, fetchImpl);
    expect(hostLabel(host!)).toBe('192.168.1.50:4000');
  });
});

describe('reading a discovered host', () => {
  const host = (desks: DiscoveredHost['desks'], rooms = desks.length): DiscoveredHost => ({
    origin: 'http://192.168.1.77:4000',
    name: null,
    desks,
    rooms,
    connections: 0,
  });

  it('counts a server with a room as sharing even when it published no ID', () => {
    expect(isSharing(host([], 1))).toBe(true);
    expect(isSharing(host([], 0))).toBe(false);
  });

  it('prefills the Desk ID only when exactly one was published', () => {
    const one = { deskId: '684128', requiresPin: false, unattended: false, clients: 0 };
    const two = { deskId: '111111', requiresPin: false, unattended: false, clients: 0 };
    const withheld = { deskId: null, requiresPin: false, unattended: true, clients: 0 };

    expect(autofillDeskId(host([one]))).toBe('684128');
    expect(autofillDeskId(host([one, two]))).toBeNull();
    expect(autofillDeskId(host([withheld]))).toBeNull();
    expect(autofillDeskId(host([one, withheld]))).toBe('684128');
  });
});
