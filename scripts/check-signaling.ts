/**
 * Signaling protocol conformance check.
 *
 * RemoteDesk has two interchangeable signaling servers — the one embedded in the
 * desktop app (`src-tauri/src/signaling.rs`) and the standalone Node relay
 * (`server/index.ts`). A peer must get identical behaviour from either, or a
 * Windows host and a Linux client can end up unable to meet. This drives a real
 * host/client pair through the full handshake against whichever server URL it is
 * pointed at, and exits non-zero on the first disagreement.
 *
 *   npx tsx scripts/check-signaling.ts [http://host:4000]
 */
import { WebSocket } from 'ws';

const serverUrl = process.argv[2] ?? 'http://localhost:4000';
const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/rtc';

/** Fails the run rather than hanging if a server never answers. */
const STEP_TIMEOUT_MS = 8_000;

let failures = 0;

function pass(name: string, detail = '') {
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string) {
  failures += 1;
  console.error(`  ✗ ${name} — ${detail}`);
}

/** One peer's connection, with an await-able event queue. */
class TestPeer {
  public id: string | null = null;
  private socket: WebSocket;
  /** Frames that arrived before anything was waiting for them. */
  private inbox: Array<{ event: string; data: any }> = [];
  private waiters: Array<{ event: string; resolve: (data: any) => void }> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      let frame: { event?: string; data?: any };
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof frame.event !== 'string') return;
      if (frame.event === 'welcome') this.id = frame.data?.peerId ?? null;

      const index = this.waiters.findIndex((w) => w.event === frame.event);
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter.resolve(frame.data);
      } else {
        this.inbox.push({ event: frame.event!, data: frame.data });
      }
    });
  }

  static async connect(label: string): Promise<TestPeer> {
    const socket = new WebSocket(wsUrl);
    const peer = new TestPeer(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} could not reach ${wsUrl} within ${STEP_TIMEOUT_MS}ms`)),
        STEP_TIMEOUT_MS
      );
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    // The server assigns an id in its first frame.
    await peer.waitFor('welcome');
    return peer;
  }

  emit(event: string, data: unknown = null) {
    this.socket.send(JSON.stringify({ event, data }));
  }

  waitFor(event: string, timeoutMs = STEP_TIMEOUT_MS): Promise<any> {
    const buffered = this.inbox.findIndex((m) => m.event === event);
    if (buffered >= 0) {
      const [message] = this.inbox.splice(buffered, 1);
      return Promise.resolve(message.data);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for "${event}"`)),
        timeoutMs
      );
      this.waiters.push({
        event,
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
      });
    });
  }

  /** Asserts nothing arrives on `event` within the window. */
  async expectSilence(event: string, windowMs = 600): Promise<boolean> {
    try {
      await this.waitFor(event, windowMs);
      return false;
    } catch {
      return true;
    }
  }

  close() {
    this.socket.close();
  }
}

async function main() {
  console.log(`\nRemoteDesk signaling conformance — ${wsUrl}\n`);

  const health = await fetch(`${serverUrl.replace(/\/+$/, '')}/network-info`).then((r) => r.json());
  pass('serves /network-info', `port ${health.port}, ${health.lanAddresses?.length ?? 0} LAN address(es)`);

  // --- Unattended access: a client joins with no prompt -------------------
  const host = await TestPeer.connect('host');
  const client = await TestPeer.connect('client');
  const roomId = '784920';

  host.emit('host:create', { roomId, unattended: true });
  const created = await host.waitFor('host:create:result');
  created?.ok ? pass('host claims a Desk ID') : fail('host claims a Desk ID', JSON.stringify(created));

  client.emit('client:join', { roomId });
  const joined = await client.waitFor('join:result');
  if (joined?.granted && joined.hostId === host.id) {
    pass('unattended client is admitted', `hostId ${joined.hostId}`);
  } else {
    fail('unattended client is admitted', JSON.stringify(joined));
  }

  const hostSawPeer = await host.waitFor('peer:joined');
  hostSawPeer?.peerId === client.id
    ? pass('host is told which peer joined')
    : fail('host is told which peer joined', JSON.stringify(hostSawPeer));

  // --- SDP + ICE relay, both frame shapes --------------------------------
  host.emit('signal', { targetId: client.id, kind: 'offer', data: { sdp: 'v=0-test' } });
  const offer = await client.waitFor('offer');
  offer?.data?.sdp === 'v=0-test'
    ? pass('offer reaches the client')
    : fail('offer reaches the client', JSON.stringify(offer));

  client.emit('answer', { targetId: host.id, data: { sdp: 'a=answer-test' } });
  const answer = await host.waitFor('answer');
  answer?.data?.sdp === 'a=answer-test'
    ? pass('answer reaches the host')
    : fail('answer reaches the host', JSON.stringify(answer));

  // Untargeted frames must still find the opposite role in the room.
  client.emit('ice-candidate', { data: { candidate: 'candidate:test' } });
  const ice = await host.waitFor('ice-candidate');
  ice?.data?.candidate === 'candidate:test'
    ? pass('untargeted ICE routes to the opposite role')
    : fail('untargeted ICE routes to the opposite role', JSON.stringify(ice));

  // --- A peer outside the room must not be addressable -------------------
  const outsider = await TestPeer.connect('outsider');
  host.emit('signal', { targetId: outsider.id, kind: 'offer', data: { sdp: 'leak' } });
  (await outsider.expectSilence('offer'))
    ? pass('signals cannot be addressed outside the room')
    : fail('signals cannot be addressed outside the room', 'outsider received a relayed offer');

  // A peer in no room at all has nowhere to send.
  outsider.emit('signal', { kind: 'offer', data: { sdp: 'orphan' } });
  (await host.expectSilence('offer'))
    ? pass('roomless peers cannot broadcast')
    : fail('roomless peers cannot broadcast', 'host received an orphan offer');
  outsider.close();

  // --- Wrong Desk ID is rejected -----------------------------------------
  const stranger = await TestPeer.connect('stranger');
  stranger.emit('client:join', { roomId: 'not-a-real-desk' });
  const rejected = await stranger.waitFor('join:result');
  rejected?.granted === false
    ? pass('unknown Desk ID is refused', rejected.reason)
    : fail('unknown Desk ID is refused', JSON.stringify(rejected));
  stranger.close();

  // --- PIN-gated room: the host adjudicates ------------------------------
  const pinHost = await TestPeer.connect('pin-host');
  const pinClient = await TestPeer.connect('pin-client');
  pinHost.emit('host:create', { roomId: 'pin-desk', unattended: false, pin: 'ab12' });
  await pinHost.waitFor('host:create:result');

  // Matching PIN (case-insensitive) is admitted without prompting the operator.
  pinClient.emit('client:join', { roomId: 'pin-desk', pin: 'AB12' });
  const pinJoined = await pinClient.waitFor('join:result');
  pinJoined?.granted
    ? pass('matching PIN is admitted, case-insensitively')
    : fail('matching PIN is admitted, case-insensitively', JSON.stringify(pinJoined));

  // A wrong PIN escalates to the host, whose refusal is relayed back.
  const badClient = await TestPeer.connect('bad-pin-client');
  badClient.emit('client:join', { roomId: 'pin-desk', pin: 'ZZZZ' });
  const request = await pinHost.waitFor('peer:join-request');
  if (request?.requestId) {
    pass('wrong PIN escalates to the host operator');
    pinHost.emit('host:auth-result', { requestId: request.requestId, granted: false, reason: 'Invalid PIN' });
    const verdict = await badClient.waitFor('join:result');
    verdict?.granted === false
      ? pass('host refusal reaches the client', verdict.reason)
      : fail('host refusal reaches the client', JSON.stringify(verdict));
  } else {
    fail('wrong PIN escalates to the host operator', JSON.stringify(request));
  }
  badClient.close();
  pinClient.close();
  pinHost.close();

  // --- Host departure ends the session for its clients --------------------
  host.close();
  const ended = await client.waitFor('session:ended');
  ended?.reason
    ? pass('losing the host ends the session', ended.reason)
    : fail('losing the host ends the session', JSON.stringify(ended));
  client.close();

  console.log(
    failures === 0
      ? '\nAll signaling checks passed.\n'
      : `\n${failures} signaling check(s) FAILED.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nSignaling check aborted: ${err.message}\n`);
  process.exit(1);
});
