/**
 * Transport for commands that act on the host machine itself — moving its
 * mouse, typing on it, reading its clipboard.
 *
 * There are two ways to reach the host process, and which one is available
 * depends on where the UI is running:
 *
 * - **In the desktop window**, Tauri IPC (`invoke`) is right there.
 * - **In a browser on the host machine**, it is not. That is the normal case on
 *   Linux, where the system webview has no WebRTC and the app hands the session
 *   to a real browser. Those pages talk to the host over a loopback-only,
 *   token-gated WebSocket the app opened for them.
 *
 * Callers should not care which. `hostInvoke` picks the transport and the rest
 * of the app is written as if there were only one.
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauriBridge';

/** Query parameter the app uses to hand this page its control token. */
const TOKEN_PARAM = 'rdtoken';
/** Where the token lives once taken out of the URL. */
const TOKEN_STORAGE_KEY = 'remotedesk_control_token';

/** Commands the host process will execute. Mirrors the Tauri command names. */
export type HostCommand =
  | 'get_displays'
  | 'set_target_display'
  | 'set_control_enabled'
  | 'get_injection_status'
  | 'inject_mouse_move'
  | 'inject_mouse_button'
  | 'inject_mouse_wheel'
  | 'inject_key'
  | 'panic_revoke'
  | 'clipboard_read'
  | 'clipboard_write';

let controlToken: string | null = null;
let socket: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
/** Frames queued while the socket is still opening. */
let queue: string[] = [];

/**
 * Reads the control token out of the URL and remembers it.
 *
 * The token is removed from the address bar immediately: it grants control of
 * this machine, and leaving it in the URL would put it in the history, in the
 * title bar, and in any screenshot of a session — which is exactly the thing
 * being shared.
 */
export function captureControlToken(): void {
  if (typeof window === 'undefined') return;

  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(TOKEN_PARAM);
    if (fromUrl) {
      controlToken = fromUrl;
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
      url.searchParams.delete(TOKEN_PARAM);
      window.history.replaceState({}, '', url.toString());
      return;
    }
    // A refresh loses the query string but should not lose control.
    controlToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    controlToken = null;
  }
}

/** Whether this page can drive the host machine. */
export function canControlHost(): boolean {
  return isTauri() || controlToken !== null;
}

/**
 * True when host control runs over the local socket rather than Tauri IPC.
 * The UI uses this to explain why a browser window is doing the hosting.
 */
export function isBrowserHostSession(): boolean {
  return !isTauri() && controlToken !== null;
}

function controlSocketUrl(): string {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/control';
  url.search = `?token=${encodeURIComponent(controlToken ?? '')}`;
  url.hash = '';
  return url.toString();
}

function ensureSocket(): WebSocket | null {
  if (!controlToken) return null;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return socket;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(controlSocketUrl());
  } catch (err) {
    console.warn('[hostControl] could not open the control channel:', err);
    return null;
  }
  socket = ws;

  ws.onopen = () => {
    for (const frame of queue.splice(0)) {
      try {
        ws.send(frame);
      } catch {
        /* dropped on a racing close */
      }
    }
  };

  ws.onmessage = (event) => {
    let frame: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch {
      return;
    }
    if (typeof frame.id !== 'number') return;
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    frame.ok
      ? waiter.resolve(frame.result)
      : waiter.reject(new Error(frame.error || 'host control command failed'));
  };

  ws.onclose = () => {
    socket = null;
    // Nothing can be answered once the channel is gone; fail the callers
    // rather than leaving their promises hanging forever.
    for (const [, waiter] of pending) {
      waiter.reject(new Error('host control channel closed'));
    }
    pending.clear();
  };

  ws.onerror = () => {
    /* `onclose` follows and does the cleanup */
  };

  return ws;
}

/**
 * Sends a command that needs no reply.
 *
 * Used for the mouse stream, which runs at pointer-move frequency: waiting for
 * a round trip per move would add latency to the one thing that most needs to
 * feel immediate.
 */
function sendFireAndForget(cmd: HostCommand, args: Record<string, unknown>): void {
  const ws = ensureSocket();
  if (!ws) return;
  const frame = JSON.stringify({ cmd, args });
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(frame);
    } catch {
      /* the channel is going away; the next call reopens it */
    }
  } else if (queue.length < 32) {
    queue.push(frame);
  }
}

function sendAwaited<T>(cmd: HostCommand, args: Record<string, unknown>): Promise<T> {
  const ws = ensureSocket();
  if (!ws) return Promise.reject(new Error('no host control channel'));

  const id = nextId++;
  const frame = JSON.stringify({ id, cmd, args });

  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(frame);
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    } else {
      queue.push(frame);
    }

    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${cmd} timed out`));
    }, 10_000);
  });
}

/**
 * Runs a host command over whichever transport this page has.
 *
 * `fireAndForget` skips the reply entirely, which only the local socket can do;
 * over Tauri IPC the promise is simply ignored.
 */
export async function hostInvoke<T = unknown>(
  cmd: HostCommand,
  args: Record<string, unknown> = {},
  fireAndForget = false
): Promise<T | null> {
  if (isTauri()) {
    const call = invoke<T>(cmd, args);
    if (fireAndForget) {
      void call.catch(() => null);
      return null;
    }
    return call;
  }

  if (!controlToken) return null;

  if (fireAndForget) {
    sendFireAndForget(cmd, args);
    return null;
  }
  return sendAwaited<T>(cmd, args);
}
