/**
 * Public relay conformance check.
 *
 * The relay in `relay/` speaks the same protocol as the other two signaling
 * servers, plus the rules being on the open internet demands: a Desk ID
 * belongs to the machine that first claimed it, rooms that admit anyone are
 * refused, and nothing is listed. This drives real sockets through each of
 * those against a running relay and exits non-zero on the first surprise.
 *
 *   npx tsx scripts/check-relay.ts [http://127.0.0.1:8787]
 */
import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';

const relayUrl = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const wsUrl = relayUrl.replace(/^http/, 'ws') + '/rtc';
const STEP_TIMEOUT_MS = 8_000;

let failures = 0;
const pass = (name: string, detail = '') => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name: string, detail: string) => {
  failures += 1;
  console.error(`  ✗ ${name} — ${detail}`);
};
const check = (ok: unknown, name: string, detail: unknown) =>
  ok ? pass(name) : fail(name, typeof detail === 'string' ? detail : JSON.stringify(detail));

class Peer {
  id: string | null = null;
  private inbox: Array<{ event: string; data: any }> = [];
  private waiters: Array<{ event: string; resolve: (d: any) => void }> = [];
  private constructor(private socket: WebSocket) {
    socket.on('message', (raw) => {
      let frame: { event?: string; data?: any };
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof frame.event !== 'string') return;
      if (frame.event === 'welcome') this.id = frame.data?.peerId ?? null;
      const i = this.waiters.findIndex((w) => w.event === frame.event);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(frame.data);
      else this.inbox.push({ event: frame.event, data: frame.data });
    });
  }
  static async connect(): Promise<Peer> {
    const socket = new WebSocket(wsUrl);
    const peer = new Peer(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await peer.waitFor('welcome');
    return peer;
  }
  emit(event: string, data: unknown) {
    this.socket.send(JSON.stringify({ event, data }));
  }
  sendRaw(text: string) {
    this.socket.send(text);
  }
  waitFor(event: string, ms = STEP_TIMEOUT_MS): Promise<any> {
    const i = this.inbox.findIndex((f) => f.event === event);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0].data);
    return new Promise((resolve) => {
      const waiter = { event, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) {
          this.waiters.splice(at, 1);
          resolve(undefined);
        }
      }, ms);
    });
  }
  close() {
    this.socket.close();
  }
}

const key = () => randomBytes(32).toString('hex');

async function main() {
  console.log(`Checking the public relay at ${relayUrl}`);
  const desk = `9${Math.floor(Math.random() * 1e8)}`;
  const owner = key();

  const info = await (await fetch(`${relayUrl}/network-info`)).json();
  check(info.relay === true && info.activeRooms.length === 0, 'network-info names a relay and lists no desks', info);

  // An open desk is a million guesses from anyone on the internet.
  const open = await Peer.connect();
  open.emit('host:create', { roomId: `${desk}0`, unattended: true, ownerKey: key() });
  const openResult = await open.waitFor('host:create:result');
  check(openResult?.ok === false, 'a desk that admits anyone is refused', openResult);
  open.close();

  // An older app with no owner key cannot claim anything.
  const keyless = await Peer.connect();
  keyless.emit('host:create', { roomId: `${desk}1`, unattended: false, pin: 'PW' });
  const keylessResult = await keyless.waitFor('host:create:result');
  check(keylessResult?.ok === false, 'a host without an owner key is refused', keylessResult);
  keyless.close();

  // The real host claims its desk with a password.
  const host = await Peer.connect();
  host.emit('host:create', { roomId: desk, unattended: false, pin: 'secret', ownerKey: owner });
  const created = await host.waitFor('host:create:result');
  check(created?.ok === true, 'a password-protected host registers', created);

  // Someone else with the same Desk ID cannot sit in the room.
  const squatter = await Peer.connect();
  squatter.emit('host:create', { roomId: desk, unattended: false, pin: 'x', ownerKey: key() });
  const squatted = await squatter.waitFor('host:create:result');
  check(squatted?.ok === false, 'another key cannot take an owned Desk ID', squatted);
  squatter.close();

  // A client with the right password goes straight in, and signals flow both ways.
  const client = await Peer.connect();
  client.emit('client:join', { roomId: desk, pin: 'SECRET', name: 'Laptop' });
  const joined = await client.waitFor('join:result');
  check(joined?.granted === true && joined.hostId === host.id, 'the right password admits the client', joined);
  const hostSawJoin = await host.waitFor('peer:joined');
  check(hostSawJoin?.peerId === client.id, 'the host is told who joined', hostSawJoin);

  host.emit('signal', { targetId: client.id, kind: 'offer', data: { type: 'offer', sdp: 'v=0' } });
  const offer = await client.waitFor('signal');
  check(offer?.kind === 'offer' && offer.fromId === host.id, 'an offer reaches the client', offer);
  client.emit('signal', { targetId: host.id, kind: 'answer', data: { type: 'answer', sdp: 'v=0' } });
  const answer = await host.waitFor('signal');
  check(answer?.kind === 'answer' && answer.fromId === client.id, 'the answer reaches the host', answer);

  // A wrong password asks the person at the host rather than failing silently.
  const guesser = await Peer.connect();
  guesser.emit('client:join', { roomId: desk, pin: 'wrong', name: 'Stranger' });
  const request = await host.waitFor('peer:join-request');
  check(request?.name === 'Stranger', 'a wrong password asks the host', request);
  host.emit('host:auth-result', { requestId: request?.requestId, granted: false, reason: 'No' });
  const refused = await guesser.waitFor('join:result');
  check(refused?.granted === false, 'the host refusing keeps them out', refused);

  // A stranger cannot inject frames into a room they are not in.
  guesser.emit('signal', { targetId: host.id, kind: 'offer', data: { sdp: 'evil' } });
  const leaked = await host.waitFor('signal', 1500);
  check(leaked === undefined, 'a peer outside the room cannot signal into it', leaked);
  guesser.close();

  // Keep-alive is answered.
  client.sendRaw('{"event":"ping","data":null}');
  const pong = await client.waitFor('pong');
  check(pong === null, 'keep-alive pings are answered', pong);

  // The owner restarting takes its room back from its stale socket.
  const restarted = await Peer.connect();
  restarted.emit('host:create', { roomId: desk, unattended: false, pin: 'secret', ownerKey: owner });
  const retaken = await restarted.waitFor('host:create:result');
  check(retaken?.ok === true, 'the owner reconnecting takes its desk back', retaken);

  const later = await Peer.connect();
  later.emit('client:join', { roomId: desk, pin: 'secret' });
  const laterJoined = await later.waitFor('join:result');
  check(laterJoined?.hostId === restarted.id, 'new clients reach the restarted host', laterJoined);

  // The host leaving ends the session for everyone in it.
  restarted.close();
  const ended = await later.waitFor('session:ended');
  check(ended?.roomId === desk, 'clients hear when the host goes away', ended);
  later.close();

  const nobody = await Peer.connect();
  nobody.emit('client:join', { roomId: `${desk}9`, pin: '' });
  const none = await nobody.waitFor('join:result');
  check(none?.granted === false && /No host/.test(none.reason), 'an unknown Desk ID says so', none);
  nobody.close();

  // Guessing is throttled per address — but only the guessing. A host on the
  // same address (the same household) stays on the relay. Last, because the
  // throttle then holds this address for a minute.
  const neighbour = await Peer.connect();
  const neighbourDesk = `${desk}7`;
  neighbour.emit('host:create', { roomId: neighbourDesk, unattended: false, pin: 'pw', ownerKey: key() });
  await neighbour.waitFor('host:create:result');
  const brute = await Peer.connect();
  let last: any;
  for (let i = 0; i < 11; i += 1) {
    brute.emit('client:join', { roomId: `${desk}${i}x`, pin: '' });
    last = await brute.waitFor('join:result');
  }
  check(/Too many failed attempts/.test(last?.reason ?? ''), 'repeated guessing is throttled', last);
  neighbour.emit('host:create', { roomId: neighbourDesk, unattended: false, pin: 'pw2', ownerKey: 'x'.repeat(40) });
  const stillThere = await neighbour.waitFor('host:create:result');
  check(stillThere !== undefined, 'a host on the same address is not disconnected', 'the host socket was closed');
  brute.close();
  neighbour.close();

  host.close();
  client.close();

  console.log(failures === 0 ? '\nAll relay checks passed.\n' : `\n${failures} relay check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
