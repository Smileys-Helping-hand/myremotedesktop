/**
 * RemoteDesk signaling transport.
 *
 * A minimal, dependency-free WebSocket client that exposes the small subset of
 * the socket.io surface `useWebRTC` actually uses (`on`/`emit`/`connected`/
 * `disconnect`).
 *
 * Why not socket.io: the packaged desktop app embeds its own signaling server
 * inside the Rust host process so an installed RemoteDesk works with nothing
 * else running. Implementing the socket.io/engine.io handshake in Rust is a far
 * larger surface than the plain JSON-over-WebSocket protocol below, which both
 * the Rust server (`src-tauri/src/signaling.rs`) and the optional standalone
 * Node relay (`server/index.ts`) speak.
 *
 * Wire format, both directions: `{"event": string, "data": unknown}`.
 */

/** Path the signaling server upgrades to a WebSocket on. */
export const SIGNALING_PATH = '/rtc';

export interface SignalingOptions {
  /** Attempts before giving up. `Infinity` keeps retrying. */
  reconnectionAttempts?: number;
  /** Base delay between attempts; backs off up to 10s. */
  reconnectionDelay?: number;
  /**
   * How long a single connection attempt may sit in CONNECTING.
   *
   * An unreachable address otherwise hangs for the OS TCP timeout — tens of
   * seconds during which the UI can only show "connecting". Giving up sooner
   * lets the retry loop run and lets the operator see something is wrong.
   */
  timeout?: number;
  autoConnect?: boolean;
  /**
   * Sends a tiny ping this often while connected. Only the public relay needs
   * it: a socket that carries nothing for a long time can be dropped by the
   * networks in between, and a host sits idle for hours waiting to be called.
   */
  keepAliveMs?: number;
}

/**
 * What `useWebRTC` needs from a signaling connection — satisfied by a single
 * server's socket and by a host listening on several at once.
 */
export interface SignalingTransport {
  id: string | null;
  connected: boolean;
  connect(): void;
  disconnect(): unknown;
  on(event: string, handler: (payload: any) => void): unknown;
  off(event: string, handler?: (payload: any) => void): unknown;
  emit(event: string, data?: unknown): unknown;
}

type Listener = (payload: any) => void;

/**
 * Converts a user-facing origin (`http://192.168.1.5:4000`) into the WebSocket
 * endpoint. Accepts an already-`ws://` URL so saved preferences keep working.
 */
export function toWebSocketUrl(serverUrl: string): string {
  let raw = (serverUrl || '').trim();
  if (!raw) raw = 'http://localhost:4000';
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `http://${raw}`;

  try {
    const url = new URL(raw);
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    // A saved URL may already carry the path; don't double it up.
    url.pathname = SIGNALING_PATH;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `ws://localhost:4000${SIGNALING_PATH}`;
  }
}

export class SignalingSocket {
  /** Peer id assigned by the server; mirrors socket.io's `socket.id`. */
  public id: string | null = null;
  public connected = false;

  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private attempts = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Frames emitted before the socket opened, flushed on connect. */
  private queue: string[] = [];

  constructor(
    private readonly url: string,
    private readonly options: SignalingOptions = {}
  ) {
    if (options.autoConnect !== false) this.connect();
  }

  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUser = false;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // Abandon an attempt that never completes the handshake.
    const timeout = this.options.timeout ?? 10_000;
    this.connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        // `onclose` fires from this and drives the usual reconnect path.
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
    }, timeout);

    ws.onopen = () => {
      this.clearConnectTimer();
      this.connected = true;
      this.attempts = 0;
      for (const frame of this.queue.splice(0)) {
        try {
          ws.send(frame);
        } catch {
          /* dropped on a racing close; the peer will retry */
        }
      }
      this.startKeepAlive();
      this.dispatch('connect', undefined);
    };

    ws.onmessage = (event) => {
      let frame: { event?: string; data?: unknown };
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (!frame || typeof frame.event !== 'string') return;

      // The server's first frame identifies this peer.
      if (frame.event === 'welcome') {
        const peerId = (frame.data as { peerId?: string } | undefined)?.peerId;
        if (peerId) this.id = peerId;
      }
      this.dispatch(frame.event, frame.data);
    };

    ws.onerror = () => {
      // `onclose` always follows; reconnect is handled there so it runs once.
    };

    ws.onclose = () => {
      this.clearConnectTimer();
      this.stopKeepAlive();
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      if (wasConnected) this.dispatch('disconnect', undefined);
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    const every = this.options.keepAliveMs;
    if (!every) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send('{"event":"ping","data":null}');
        } catch {
          /* onclose follows */
        }
      }
    }, every);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const max = this.options.reconnectionAttempts ?? 15;
    if (this.attempts >= max) return;
    this.attempts += 1;

    const base = this.options.reconnectionDelay ?? 1000;
    const delay = Math.min(base * Math.min(this.attempts, 10), 10_000);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private dispatch(event: string, payload: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (err) {
        console.warn(`[signaling] listener for "${event}" threw:`, err);
      }
    }
  }

  public on(event: string, handler: Listener): this {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return this;
  }

  public off(event: string, handler?: Listener): this {
    if (!handler) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(handler);
    return this;
  }

  public emit(event: string, data?: unknown): this {
    const frame = JSON.stringify({ event, data: data ?? null });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(frame);
      } catch (err) {
        console.warn('[signaling] send failed:', err);
      }
    } else {
      // Bounded so a server that never comes up can't grow this without limit.
      if (this.queue.length < 64) this.queue.push(frame);
    }
    return this;
  }

  public disconnect(): this {
    this.closedByUser = true;
    this.clearConnectTimer();
    this.stopKeepAlive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.queue.length = 0;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close(1000, 'client disconnect');
      } catch {
        /* already closing */
      }
    }
    return this;
  }
}

/** socket.io-compatible factory so call sites read unchanged. */
export function io(serverUrl: string, options: SignalingOptions = {}): SignalingSocket {
  return new SignalingSocket(toWebSocketUrl(serverUrl), options);
}

export type Socket = SignalingTransport;

/** One server a host registers on. */
export interface SignalingRoute {
  /** Named in the `via` field of what this server says, e.g. `relay`. */
  label: string;
  url: string;
  options?: SignalingOptions;
  /** Adjusts a frame bound for this server only; `null` skips it there. */
  decorate?: (event: string, data: any) => any;
}

/** Fields that carry a server-assigned peer or request id. */
const ID_FIELDS = ['fromId', 'senderId', 'peerId', 'hostId', 'requestId', 'targetId'] as const;

/**
 * A host listening on more than one signaling server at once.
 *
 * The host registers its Desk ID on its own embedded server — so the LAN works
 * with no internet — and on the public relay, so a machine on another network
 * can reach it by the same ID. `useWebRTC` holds one socket and one peer
 * connection; this presents several servers as that one socket.
 *
 * Each server mints its own peer ids, and two servers can mint the same one,
 * so ids from every server but the first are prefixed with the route's label
 * on the way in and stripped on the way out. A frame naming a peer (by
 * `targetId` or `requestId`) goes only to the server that peer is on; one that
 * names nobody, like `host:create`, goes to all of them.
 */
export class MultiSignalingSocket implements SignalingTransport {
  public id: string | null = null;
  private readonly routes: Array<{ route: SignalingRoute; socket: SignalingSocket; prefix: string }>;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly subscribed = new Set<string>();

  constructor(routes: SignalingRoute[]) {
    this.routes = routes.map((route, index) => ({
      route,
      prefix: index === 0 ? '' : `${route.label}~`,
      socket: new SignalingSocket(toWebSocketUrl(route.url), { ...route.options, autoConnect: false }),
    }));

    this.routes.forEach(({ socket, route }, index) => {
      socket.on('welcome', (data) => {
        if (index === 0) this.id = data?.peerId ?? this.id;
      });
      socket.on('connect', () => {
        this.dispatch('route:connect', { via: route.label });
        this.dispatch('connect', { via: route.label });
      });
      socket.on('disconnect', () => {
        this.dispatch('route:disconnect', { via: route.label });
        if (!this.connected) this.dispatch('disconnect', undefined);
      });
    });

    for (const { socket, route } of this.routes) {
      if (route.options?.autoConnect !== false) socket.connect();
    }
  }

  public get connected(): boolean {
    return this.routes.some(({ socket }) => socket.connected);
  }

  /** Whether the named server is currently connected. */
  public isConnected(label: string): boolean {
    return this.routes.some(({ route, socket }) => route.label === label && socket.connected);
  }

  public connect(): void {
    for (const { socket } of this.routes) socket.connect();
  }

  public disconnect(): this {
    for (const { socket } of this.routes) socket.disconnect();
    return this;
  }

  public on(event: string, handler: Listener): this {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    this.subscribe(event);
    return this;
  }

  public off(event: string, handler?: Listener): this {
    if (!handler) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(handler);
    return this;
  }

  public emit(event: string, data?: unknown): this {
    const named = this.namedPeer(data);
    for (const { socket, route, prefix } of this.routes) {
      let payload: any = data;
      if (named !== null) {
        const onThisServer = prefix ? named.startsWith(prefix) : !this.hasAnyPrefix(named);
        if (!onThisServer) continue;
        payload = this.rewriteIds(data, (id) => (prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id));
      }
      if (route.decorate) {
        payload = route.decorate(event, payload);
        if (payload === null) continue;
      }
      socket.emit(event, payload);
    }
    return this;
  }

  /** Lifecycle events are wired in the constructor; everything else lazily. */
  private subscribe(event: string): void {
    if (this.subscribed.has(event)) return;
    if (['connect', 'disconnect', 'route:connect', 'route:disconnect'].includes(event)) return;
    this.subscribed.add(event);
    for (const { socket, prefix, route } of this.routes) {
      socket.on(event, (payload: any) => {
        let data = prefix ? this.rewriteIds(payload, (id) => `${prefix}${id}`) : payload;
        if (data && typeof data === 'object' && !Array.isArray(data)) data = { ...data, via: route.label };
        this.dispatch(event, data);
      });
    }
  }

  private namedPeer(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    if (typeof record.targetId === 'string' && record.targetId) return record.targetId;
    if (typeof record.requestId === 'string' && record.requestId) return record.requestId;
    return null;
  }

  private hasAnyPrefix(id: string): boolean {
    return this.routes.some(({ prefix }) => prefix !== '' && id.startsWith(prefix));
  }

  private rewriteIds(data: unknown, map: (id: string) => string): unknown {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const copy: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    for (const field of ID_FIELDS) {
      if (typeof copy[field] === 'string' && copy[field]) copy[field] = map(copy[field] as string);
    }
    return copy;
  }

  private dispatch(event: string, payload: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (err) {
        console.warn(`[signaling] listener for "${event}" threw:`, err);
      }
    }
  }
}

