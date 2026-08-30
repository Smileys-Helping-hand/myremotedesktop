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
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      if (wasConnected) this.dispatch('disconnect', undefined);
      if (!this.closedByUser) this.scheduleReconnect();
    };
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

export type Socket = SignalingSocket;
