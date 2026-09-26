/**
 * RemoteDesk public relay — a Cloudflare Worker.
 *
 * Two machines on different networks cannot dial each other's private
 * addresses, so they need somewhere both can reach to exchange the few
 * kilobytes of WebRTC offer, answer and ICE candidates. This is that place.
 * Once they have met, the video and input travel peer-to-peer; nothing but
 * signaling passes through here.
 *
 * It speaks exactly the protocol in `src/utils/signaling.ts` — JSON frames of
 * `{"event": string, "data": value}` over a WebSocket at `/rtc` — so the app
 * treats it like any other signaling server. Keep it in step with
 * `server/index.ts` and `src-tauri/src/signaling.rs`.
 *
 * It differs from those two in what being on the open internet demands:
 *
 * - **A Desk ID belongs to one machine.** On a LAN the host's own server holds
 *   the room, so nobody else can register it. Here anyone can connect, so a
 *   host proves itself with a per-installation key; the first key to claim an
 *   ID owns it. Without this, a stranger who learned your Desk ID could sit in
 *   your room and receive your saved password when you connected.
 * - **Nothing is listed.** There is no `/hosts`: publishing Desk IDs here would
 *   publish them to the world.
 * - **Rooms that admit anyone are refused.** An "Anyone with ID" desk is fine on
 *   a trusted LAN and a six-digit ID is a million guesses from open on the
 *   internet. The app does not register those here, and the relay does not
 *   accept them if it tries.
 * - **Limits per address**, so one source cannot hold thousands of sockets or
 *   hammer join attempts across many IDs.
 */
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  HUB: DurableObjectNamespace<RelayHub>;
  /** Optional Cloudflare TURN key. Both must be set to hand out TURN. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  RELAY_NAME?: string;
}

const RELAY_NAME = 'RemoteDesk public relay';

/** Failed joins from one address before its sockets are cut off. */
const MAX_FAILED_JOINS = 10;
const FAILED_JOIN_WINDOW_MS = 60_000;
/** How long the host has to answer an authorization request. */
const AUTH_TIMEOUT_MS = 30_000;
/** Open sockets allowed from one address at a time. */
const MAX_SOCKETS_PER_ADDRESS = 24;
/** Frames one socket may send per window before it is dropped. */
const MAX_FRAMES_PER_WINDOW = 400;
const FRAME_WINDOW_MS = 10_000;
/** Offers with many candidates run to a few KB; nothing legitimate is near this. */
const MAX_FRAME_BYTES = 64 * 1024;
/**
 * An ID whose owner has not been seen for this long can be claimed again, so a
 * reinstall that lost its key is not locked out of its own Desk ID forever.
 */
const OWNERSHIP_LAPSE_MS = 30 * 24 * 60 * 60 * 1000;
/** Ownership is re-stamped at most this often, to keep storage writes rare. */
const OWNERSHIP_TOUCH_MS = 24 * 60 * 60 * 1000;
/** Lifetime of TURN credentials handed to a peer. */
const TURN_TTL_SECONDS = 12 * 60 * 60;

const DESK_ID_PATTERN = /^[A-Za-z0-9-]{3,32}$/;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (url.pathname === '/rtc') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected a WebSocket upgrade', { status: 426 });
      }
      return env.HUB.get(env.HUB.idFromName('global')).fetch(request);
    }

    if (url.pathname === '/healthz' || url.pathname === '/') {
      return json({ status: 'ok', relay: true, name: env.RELAY_NAME || RELAY_NAME, turn: turnConfigured(env) });
    }

    // Answers the same probe the app sends any signaling server, but lists
    // nothing: see "Nothing is listed" above.
    if (url.pathname === '/network-info') {
      return json({
        name: env.RELAY_NAME || RELAY_NAME,
        relay: true,
        port: 443,
        lanAddresses: [],
        tunnelUrl: null,
        rooms: 0,
        activeRooms: [],
        connections: 0,
      });
    }

    if (url.pathname === '/hosts') return json({ name: env.RELAY_NAME || RELAY_NAME, hosts: [] });

    return json({ error: 'not found' }, 404);
  },
};

function turnConfigured(env: Env): boolean {
  return Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);
}

/** What each socket carries through hibernation. Rebuilt into maps on wake. */
interface Attachment {
  peerId: string;
  ip: string;
  role: 'host' | 'client' | null;
  roomId: string | null;
  /** Present on a host's socket: the room it registered. */
  room?: RoomSettings;
}

interface RoomSettings {
  unattended: boolean;
  pin?: string;
  requireApproval: boolean;
}

interface Room extends RoomSettings {
  roomId: string;
  hostId: string;
  clientIds: Set<string>;
}

interface PendingAuth {
  clientId: string;
  roomId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface Ownership {
  keyHash: string;
  lastSeen: number;
}

/** Normalizes a PIN the way both peers must agree on before comparison. */
function normalizePin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Constant-time comparison; a PIN is exactly the secret worth protecting from timing. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Mirrors pinGrantsEntry in server/index.ts. */
function pinGrantsEntry(roomPin: string | undefined, provided: string | undefined): boolean {
  if (!roomPin) return true;
  if (!provided) return false;
  return sameSecret(roomPin, provided);
}

/** Mirrors admitsWithoutAsking in server/index.ts. */
function admitsWithoutAsking(room: Room, provided: string | undefined): boolean {
  if (room.requireApproval) return false;
  return room.unattended || pinGrantsEntry(room.pin, provided);
}

/**
 * Whether a room keeps strangers out on its own. One that admits anyone with
 * the ID does not, and has no business on a public server.
 */
function isGated(settings: RoomSettings): boolean {
  return settings.requireApproval || Boolean(settings.pin) || !settings.unattended;
}

function roomIdOf(data: any): string {
  if (typeof data === 'string') return data.trim();
  return String(data?.roomId ?? '').trim();
}

function clientName(data: any): string {
  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  return name && name.length <= 64 ? name : 'An unnamed machine';
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function mintId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export class RelayHub extends DurableObject<Env> {
  private sockets = new Map<string, WebSocket>();
  private rooms = new Map<string, Room>();
  private pendingAuth = new Map<string, PendingAuth>();
  /** Address -> timestamps of failed joins. Lost on hibernation, which is fine. */
  private failedJoins = new Map<string, number[]>();
  /** Socket -> frame count in the current window. */
  private frameCounts = new WeakMap<WebSocket, { windowStart: number; count: number }>();
  private turnCache: { iceServers: unknown[]; expires: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"event":"ping","data":null}', '{"event":"pong","data":null}')
    );
    this.rebuild();
  }

  /**
   * Restores the in-memory maps from the sockets that survived hibernation.
   * Every fact needed to route a frame lives in a socket's attachment, so
   * nothing is lost when the object sleeps between sessions.
   */
  private rebuild(): void {
    const clients: Attachment[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.peerId) continue;
      this.sockets.set(att.peerId, ws);
      if (att.role === 'host' && att.roomId && att.room) {
        this.rooms.set(att.roomId, { roomId: att.roomId, hostId: att.peerId, clientIds: new Set(), ...att.room });
      } else if (att.role === 'client' && att.roomId) {
        clients.push(att);
      }
    }
    for (const att of clients) this.rooms.get(att.roomId!)?.clientIds.add(att.peerId);
  }

  async fetch(request: Request): Promise<Response> {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

    let open = 0;
    for (const ws of this.sockets.values()) {
      if ((ws.deserializeAttachment() as Attachment | null)?.ip === ip) open += 1;
    }
    if (open >= MAX_SOCKETS_PER_ADDRESS) {
      return new Response('too many connections from this address', { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peerId = mintId('r');
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { peerId, ip, role: null, roomId: null };
    server.serializeAttachment(attachment);
    this.sockets.set(peerId, server);
    this.send(peerId, 'welcome', { peerId });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (raw.length > MAX_FRAME_BYTES || !this.withinRate(ws)) {
      ws.close(1008, 'too much traffic');
      return;
    }

    let frame: { event?: string; data?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame.event !== 'string') return;
    await this.handleEvent(ws, att, frame.event, (frame.data ?? null) as any);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.dropSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.dropSocket(ws);
  }

  private dropSocket(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.leaveRooms(att.peerId);
    this.sockets.delete(att.peerId);
    try {
      ws.close(1000, 'closed');
    } catch {
      /* already closed */
    }
  }

  private withinRate(ws: WebSocket): boolean {
    const now = Date.now();
    const entry = this.frameCounts.get(ws);
    if (!entry || now - entry.windowStart > FRAME_WINDOW_MS) {
      this.frameCounts.set(ws, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= MAX_FRAMES_PER_WINDOW;
  }

  private send(peerId: string, event: string, data: unknown): void {
    const ws = this.sockets.get(peerId);
    if (!ws) return;
    try {
      ws.send(JSON.stringify({ event, data }));
    } catch {
      /* the close handler tidies up */
    }
  }

  private setAttachment(peerId: string, change: Partial<Attachment>): void {
    const ws = this.sockets.get(peerId);
    if (!ws) return;
    const att = ws.deserializeAttachment() as Attachment;
    ws.serializeAttachment({ ...att, ...change });
  }

  /** Records a failed join from an address. */
  private recordFailedJoin(ip: string): void {
    const now = Date.now();
    const history = (this.failedJoins.get(ip) ?? []).filter((t) => now - t < FAILED_JOIN_WINDOW_MS);
    history.push(now);
    this.failedJoins.set(ip, history);
  }

  /**
   * Whether an address has guessed wrong too often to be heard for a while.
   *
   * Only its joins are refused. Its sockets stay open: a household shares one
   * public address, and a host behind it must not fall off the relay because
   * somebody else in the house mistyped a Desk ID.
   */
  private isThrottled(ip: string): boolean {
    const now = Date.now();
    const history = (this.failedJoins.get(ip) ?? []).filter((t) => now - t < FAILED_JOIN_WINDOW_MS);
    return history.length >= MAX_FAILED_JOINS;
  }

  private ipOf(peerId: string): string {
    const ws = this.sockets.get(peerId);
    return (ws?.deserializeAttachment() as Attachment | null)?.ip ?? 'unknown';
  }

  /** Drops the peer from every room and tears down any room it was hosting. */
  private leaveRooms(peerId: string): void {
    for (const room of this.rooms.values()) {
      if (room.clientIds.delete(peerId)) {
        this.send(room.hostId, 'peer:left', { peerId });
        this.send(room.hostId, 'peer-left', { peerId, senderId: peerId, roomId: room.roomId });
      }
    }
    for (const [roomId, room] of [...this.rooms.entries()]) {
      if (room.hostId !== peerId) continue;
      for (const clientId of room.clientIds) {
        this.send(clientId, 'session:ended', { roomId, reason: 'Host disconnected' });
        this.send(clientId, 'peer-left', { peerId, senderId: peerId, roomId });
        this.setAttachment(clientId, { role: null, roomId: null });
      }
      this.rooms.delete(roomId);
    }
    for (const [requestId, pending] of this.pendingAuth.entries()) {
      if (pending.clientId === peerId) {
        clearTimeout(pending.timer);
        this.pendingAuth.delete(requestId);
      }
    }
    this.setAttachment(peerId, { role: null, roomId: null, room: undefined });
  }

  private roomOf(peerId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.hostId === peerId || room.clientIds.has(peerId)) return room;
    }
    return undefined;
  }

  private async handleEvent(ws: WebSocket, att: Attachment, event: string, data: any): Promise<void> {
    switch (event) {
      case 'host:create':
        await this.hostCreate(att.peerId, data);
        break;
      case 'client:join':
        await this.clientJoin(att.peerId, att.ip, data);
        break;
      case 'host:auth-result':
        await this.hostAuthResult(att.peerId, data);
        break;
      case 'signal':
        if (typeof data?.kind === 'string') this.relay(att.peerId, data.kind, data?.data ?? null, data?.targetId);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        this.relay(att.peerId, event, data?.data ?? data, data?.targetId);
        break;
      case 'leave':
        this.leaveRooms(att.peerId);
        break;
      default:
        void ws;
        break;
    }
  }

  /**
   * Checks, and if free records, that `ownerKey` owns `roomId`.
   *
   * The first key to claim an ID owns it until it goes unused for
   * OWNERSHIP_LAPSE_MS. The key itself is never stored — only its hash.
   */
  private async claim(roomId: string, ownerKey: string): Promise<boolean> {
    const keyHash = await sha256Hex(`remotedesk-owner:${ownerKey}`);
    const storageKey = `owner:${roomId}`;
    const now = Date.now();
    const existing = await this.ctx.storage.get<Ownership>(storageKey);

    if (existing && existing.keyHash !== keyHash && now - existing.lastSeen < OWNERSHIP_LAPSE_MS) {
      return false;
    }
    if (!existing || existing.keyHash !== keyHash || now - existing.lastSeen > OWNERSHIP_TOUCH_MS) {
      await this.ctx.storage.put(storageKey, { keyHash, lastSeen: now } satisfies Ownership);
    }
    return true;
  }

  private async hostCreate(peerId: string, data: any): Promise<void> {
    const roomId = roomIdOf(data);
    if (!DESK_ID_PATTERN.test(roomId)) {
      this.send(peerId, 'host:create:result', { ok: false, reason: 'Invalid Desk ID format' });
      return;
    }

    const settings: RoomSettings = {
      unattended: typeof data === 'object' ? data?.unattended !== false : true,
      pin: normalizePin(data?.pin),
      requireApproval: data?.requireApproval === true,
    };
    if (!isGated(settings)) {
      this.send(peerId, 'host:create:result', {
        ok: false,
        reason:
          'This desk admits anyone who knows its ID, which is not safe on a public relay. Choose a password, a PIN or "Ask me first" to be reachable from other networks.',
      });
      return;
    }

    const ownerKey = typeof data?.ownerKey === 'string' ? data.ownerKey : '';
    if (ownerKey.length < 32) {
      this.send(peerId, 'host:create:result', { ok: false, reason: 'This relay needs a newer RemoteDesk' });
      return;
    }
    if (!(await this.claim(roomId, ownerKey))) {
      this.send(peerId, 'host:create:result', {
        ok: false,
        reason: 'Another machine already owns this Desk ID on the public relay',
      });
      return;
    }

    // The owner proved itself, so it may take the room over from an older
    // socket of its own — a restart whose previous connection has not closed yet.
    const existing = this.rooms.get(roomId);
    if (existing && existing.hostId !== peerId) {
      this.setAttachment(existing.hostId, { role: null, roomId: null, room: undefined });
    }

    this.rooms.set(roomId, {
      roomId,
      hostId: peerId,
      clientIds: existing?.clientIds ?? new Set(),
      ...settings,
    });
    this.setAttachment(peerId, { role: 'host', roomId, room: settings });

    this.send(peerId, 'host:create:result', {
      ok: true,
      roomId,
      peerId,
      iceServers: await this.turnServers(),
    });
  }

  private async clientJoin(peerId: string, ip: string, data: any): Promise<void> {
    if (this.isThrottled(ip)) {
      this.send(peerId, 'join:result', {
        granted: false,
        reason: 'Too many failed attempts from this network. Wait a minute and try again.',
      });
      return;
    }

    const roomId = roomIdOf(data);
    const pin = normalizePin(data?.pin);
    const room = this.rooms.get(roomId);

    if (!room) {
      this.send(peerId, 'join:result', {
        granted: false,
        reason: 'No host is currently sharing that Desk ID',
      });
      this.recordFailedJoin(ip);
      return;
    }

    if (admitsWithoutAsking(room, pin)) {
      await this.admit(peerId, room);
      return;
    }

    const requestId = mintId('req');
    const timer = setTimeout(() => {
      this.pendingAuth.delete(requestId);
      this.send(peerId, 'join:result', { granted: false, reason: 'Host did not respond in time' });
    }, AUTH_TIMEOUT_MS);

    this.pendingAuth.set(requestId, { clientId: peerId, roomId, timer });
    this.send(room.hostId, 'peer:join-request', {
      requestId,
      peerId,
      name: clientName(data),
      pin: pin ?? '',
    });
  }

  private async admit(clientId: string, room: Room): Promise<void> {
    room.clientIds.add(clientId);
    this.setAttachment(clientId, { role: 'client', roomId: room.roomId });

    this.send(clientId, 'join:result', {
      granted: true,
      roomId: room.roomId,
      hostId: room.hostId,
      peerId: clientId,
      iceServers: await this.turnServers(),
    });
    this.send(room.hostId, 'peer:joined', { peerId: clientId });
    this.send(room.hostId, 'peer-joined', { peerId: clientId, senderId: clientId, roomId: room.roomId });
  }

  private async hostAuthResult(peerId: string, data: any): Promise<void> {
    const requestId = String(data?.requestId ?? '');
    const pending = this.pendingAuth.get(requestId);
    if (!pending) return;

    const room = this.rooms.get(pending.roomId);
    if (!room || room.hostId !== peerId) return;

    clearTimeout(pending.timer);
    this.pendingAuth.delete(requestId);

    const clientId = pending.clientId;
    if (!this.sockets.has(clientId)) return;

    if (!data?.granted) {
      this.send(clientId, 'join:result', { granted: false, reason: data?.reason ?? 'Rejected by host' });
      this.recordFailedJoin(this.ipOf(clientId));
      return;
    }
    await this.admit(clientId, room);
  }

  private relay(peerId: string, kind: string, payload: unknown, targetId?: string): void {
    const room = this.roomOf(peerId);
    if (!room) return;

    let targets: string[];
    if (targetId) {
      const isPeer = room.hostId === targetId || room.clientIds.has(targetId);
      targets = isPeer ? [targetId] : [];
    } else {
      targets = room.hostId === peerId ? [...room.clientIds] : [room.hostId];
    }

    for (const target of targets) {
      this.send(target, 'signal', { fromId: peerId, kind, data: payload });
      this.send(target, kind, { senderId: peerId, roomId: room.roomId, data: payload });
    }
  }

  /**
   * TURN credentials, when a key is configured.
   *
   * Handed out only inside the handshake — to a host that proved ownership of
   * its ID, or a client its host admitted — so they are not free for anyone who
   * asks. Cached, since one set serves every session until it nears expiry.
   */
  private async turnServers(): Promise<unknown[] | undefined> {
    if (!turnConfigured(this.env)) return undefined;
    const now = Date.now();
    if (this.turnCache && this.turnCache.expires > now) return this.turnCache.iceServers;

    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        }
      );
      if (!response.ok) return undefined;
      const body = (await response.json()) as { iceServers?: Array<{ urls: string | string[] }> };
      // Port 53 is blocked by browsers and only makes gathering wait for a timeout.
      const iceServers = (body.iceServers ?? []).map((server) => ({
        ...server,
        urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => !/:53(\?|$)/.test(u)),
      }));
      // Refreshed well before the credentials themselves expire.
      this.turnCache = { iceServers, expires: now + (TURN_TTL_SECONDS * 1000) / 2 };
      return iceServers;
    } catch {
      return undefined;
    }
  }
}
