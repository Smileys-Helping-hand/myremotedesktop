/**
 * Proves a client can find a host by Desk ID.
 *
 * This is the failure users actually hit: the host had its Desk ID on screen,
 * the client typed it in, and the server answered "no host is currently sharing
 * that Desk ID" — in both directions. The cause was that the host only
 * registered its room once screen capture had started, so for the whole period
 * the ID was displayed but not yet shared, it pointed at nothing.
 *
 * Two peers are driven over the real wire protocol. Screen capture is not
 * involved at all, which is the point: registration must not depend on it.
 *
 * Usage: npx tsx scripts/check-host-discovery.ts [http://host:4000]
 */
import { WebSocket } from 'ws';

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:4000';
const WS_URL = ORIGIN.replace(/^http/, 'ws') + '/rtc';

let failures = 0;
const pass = (name: string, detail = '') =>
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
const fail = (name: string, detail: string) => {
  failures++;
  console.error(`  ✗ ${name} — ${detail}`);
};

interface Frame {
  event: string;
  data: any;
}

/** One peer, with the frames it received queued for assertion. */
class Peer {
  private socket: WebSocket;
  private received: Frame[] = [];
  private waiters: Array<{ event: string; resolve: (f: Frame) => void }> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const waiterIndex = this.waiters.findIndex((w) => w.event === frame.event);
      if (waiterIndex >= 0) {
        this.waiters.splice(waiterIndex, 1)[0].resolve(frame);
      } else {
        this.received.push(frame);
      }
    });
  }

  static async connect(label: string): Promise<Peer> {
    const socket = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (err) => reject(new Error(`${label}: ${err.message}`)));
      setTimeout(() => reject(new Error(`${label}: timed out connecting to ${WS_URL}`)), 8000);
    });
    return new Peer(socket);
  }

  send(event: string, data: unknown) {
    this.socket.send(JSON.stringify({ event, data }));
  }

  /** Resolves with the next frame of `event`, including any already buffered. */
  await(event: string, timeoutMs = 8000): Promise<Frame> {
    const buffered = this.received.findIndex((f) => f.event === event);
    if (buffered >= 0) return Promise.resolve(this.received.splice(buffered, 1)[0]);

    return new Promise((resolve, reject) => {
      this.waiters.push({ event, resolve });
      setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closing */
    }
  }
}

const deskId = String(Math.floor(100000 + Math.random() * 900000));

console.log(`\nHost discovery check against ${ORIGIN} (Desk ID ${deskId})\n`);

const host = await Peer.connect('host');
const client = await Peer.connect('client');

try {
  await host.await('welcome');
  await client.await('welcome');
  pass('both peers reached the signaling server');

  // --- an unknown ID must be refused, or the test below proves nothing ------
  client.send('client:join', { roomId: '000000', pin: '' });
  const unknown = await client.await('join:result');
  if (unknown.data?.granted === false) {
    pass('an unregistered Desk ID is refused', unknown.data?.reason ?? '');
  } else {
    fail('an unregistered Desk ID is refused', JSON.stringify(unknown.data));
  }

  // --- the regression: register WITHOUT sharing a screen --------------------
  host.send('host:create', { roomId: deskId, unattended: true });
  const created = await host.await('host:create:result');
  if (created.data?.ok) {
    pass('host publishes its Desk ID without starting a screen share');
  } else {
    fail('host publishes its Desk ID without starting a screen share', JSON.stringify(created.data));
  }

  // --- the thing that was broken -------------------------------------------
  client.send('client:join', { roomId: deskId, pin: '' });
  const joined = await client.await('join:result');
  if (joined.data?.granted === true) {
    pass('client finds the host by Desk ID', `room ${joined.data?.roomId}`);
  } else {
    fail('client finds the host by Desk ID', joined.data?.reason ?? JSON.stringify(joined.data));
  }

  // --- and the host must learn the client arrived, so it can offer ----------
  const peerJoined = await host.await('peer:joined');
  if (peerJoined.data?.peerId) {
    pass('host is told which peer joined', `peer ${peerJoined.data.peerId}`);
  } else {
    fail('host is told which peer joined', JSON.stringify(peerJoined.data));
  }
} catch (err) {
  fail('discovery sequence', err instanceof Error ? err.message : String(err));
} finally {
  host.close();
  client.close();
}

console.log(
  failures === 0
    ? '\nHost discovery works.\n'
    : `\n${failures} host-discovery check(s) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
