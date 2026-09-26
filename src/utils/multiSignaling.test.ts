import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MultiSignalingSocket } from './signaling';

/**
 * A host registers on its own server and on the public relay at once, and the
 * two mint peer ids independently. These tests pin down the one thing that
 * cannot go wrong: a frame for a peer reaches the server that peer is on, and
 * only that one.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  sent: Array<{ event: string; data: any }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(frame: string) {
    this.sent.push(JSON.parse(frame));
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(event: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ event, data }) });
  }
}

const HOME = 'http://127.0.0.1:4000';
const RELAY = 'https://relay.example';

function socketFor(url: string): FakeSocket {
  const host = new URL(url).host;
  const found = FakeSocket.instances.find((s) => s.url.includes(host));
  if (!found) throw new Error(`no socket for ${url}`);
  return found;
}

function makeHost(decorate?: (event: string, data: any) => any) {
  const multi = new MultiSignalingSocket([
    { label: 'home', url: HOME },
    { label: 'relay', url: RELAY, decorate },
  ]);
  const home = socketFor(HOME);
  const relay = socketFor(RELAY);
  home.open();
  relay.open();
  return { multi, home, relay };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MultiSignalingSocket', () => {
  it('registers the desk on every server', () => {
    const { multi, home, relay } = makeHost();
    multi.emit('host:create', { roomId: '123456' });
    expect(home.sent).toEqual([{ event: 'host:create', data: { roomId: '123456' } }]);
    expect(relay.sent).toEqual([{ event: 'host:create', data: { roomId: '123456' } }]);
  });

  it('adds the owner key on the relay only', () => {
    const { multi, home, relay } = makeHost((event, data) =>
      event === 'host:create' ? { ...data, ownerKey: 'k' } : data
    );
    multi.emit('host:create', { roomId: '123456' });
    expect(home.sent[0].data.ownerKey).toBeUndefined();
    expect(relay.sent[0].data.ownerKey).toBe('k');
  });

  it('skips a server when its decorator declines the frame', () => {
    const { multi, home, relay } = makeHost(() => null);
    multi.emit('host:create', { roomId: '123456' });
    expect(home.sent).toHaveLength(1);
    expect(relay.sent).toHaveLength(0);
  });

  it('keeps two servers\' identical peer ids apart', () => {
    const { multi, home, relay } = makeHost();
    const joined: string[] = [];
    multi.on('peer:joined', (d) => joined.push(d.peerId));

    // Both servers happen to mint "p2".
    home.receive('peer:joined', { peerId: 'p2' });
    relay.receive('peer:joined', { peerId: 'p2' });
    expect(joined).toEqual(['p2', 'relay~p2']);
  });

  it('answers a relay peer through the relay, with its own id', () => {
    const { multi, home, relay } = makeHost();
    multi.emit('signal', { targetId: 'relay~p2', kind: 'offer', data: { sdp: 'x' } });
    expect(home.sent).toHaveLength(0);
    expect(relay.sent).toEqual([{ event: 'signal', data: { targetId: 'p2', kind: 'offer', data: { sdp: 'x' } } }]);
  });

  it('answers a LAN peer through the home server only', () => {
    const { multi, home, relay } = makeHost();
    multi.emit('signal', { targetId: 'p2', kind: 'offer', data: {} });
    expect(home.sent).toHaveLength(1);
    expect(relay.sent).toHaveLength(0);
  });

  it('routes a join verdict back to the server that asked', () => {
    const { multi, home, relay } = makeHost();
    const requests: any[] = [];
    multi.on('peer:join-request', (r) => requests.push(r));
    relay.receive('peer:join-request', { requestId: 'req1', peerId: 'r9', name: 'Laptop', pin: '' });

    expect(requests[0]).toMatchObject({ requestId: 'relay~req1', peerId: 'relay~r9', via: 'relay' });
    multi.emit('host:auth-result', { requestId: requests[0].requestId, granted: true });
    expect(home.sent).toHaveLength(0);
    expect(relay.sent).toEqual([{ event: 'host:auth-result', data: { requestId: 'req1', granted: true } }]);
  });

  it('says which server a registration result came from', () => {
    const { multi, relay } = makeHost();
    const results: any[] = [];
    multi.on('host:create:result', (r) => results.push(r));
    relay.receive('host:create:result', { ok: false, reason: 'no' });
    expect(results).toEqual([{ ok: false, reason: 'no', via: 'relay' }]);
  });

  it('stays connected while either server is up, and says so when both go', () => {
    const { multi, home, relay } = makeHost();
    const downs: number[] = [];
    multi.on('disconnect', () => downs.push(1));

    relay.close();
    expect(multi.connected).toBe(true);
    expect(multi.isConnected('relay')).toBe(false);
    expect(downs).toHaveLength(0);

    home.close();
    expect(multi.connected).toBe(false);
    expect(downs).toHaveLength(1);
    multi.disconnect();
  });
});
