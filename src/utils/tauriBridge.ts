/**
 * Tauri Native OS Input Injection Bridge.
 * Safe wrapper around @tauri-apps/api/core invoke calls.
 */
import { invoke } from '@tauri-apps/api/core';
import { canControlHost, hostInvoke } from './hostControl';

export interface DisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface NetworkInfo {
  port: number;
  /** URLs a peer on the same network can dial to reach this host. */
  lanAddresses: string[];
  rooms: number;
  connections: number;
}

export interface InjectionStatus {
  controlEnabled: boolean;
  killSwitchActive: boolean;
  suspendedRemainingMs: number;
  target: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/** Check if running within Tauri native runtime */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

export async function tauriGetDisplays(): Promise<DisplayInfo[]> {
  if (!canControlHost()) return [];
  try {
    return (await hostInvoke<DisplayInfo[]>('get_displays')) ?? [];
  } catch (err) {
    console.warn('[host] get_displays error:', err);
    return [];
  }
}

export async function tauriSetTargetDisplay(display: DisplayInfo): Promise<void> {
  if (!canControlHost()) return;
  try {
    await hostInvoke('set_target_display', { display });
  } catch (err) {
    console.warn('[host] set_target_display error:', err);
  }
}

export async function tauriSetControlEnabled(enabled: boolean): Promise<InjectionStatus | null> {
  if (!canControlHost()) return null;
  try {
    return await hostInvoke<InjectionStatus>('set_control_enabled', { enabled });
  } catch (err) {
    console.warn('[host] set_control_enabled error:', err);
    return null;
  }
}

export async function tauriInjectMouseMove(normX: number, normY: number): Promise<void> {
  if (!canControlHost()) return;
  try {
    // Fire-and-forget: this runs at pointer-move frequency, and a round trip
    // per move would show up directly as cursor lag.
    await hostInvoke('inject_mouse_move', { normX, normY }, true);
  } catch {
    // Intermittent failures during high-frequency streaming are not worth
    // reporting; the next move supersedes this one anyway.
  }
}

export async function tauriInjectMouseButton(
  button: 'left' | 'middle' | 'right',
  pressed: boolean,
  normX?: number,
  normY?: number
): Promise<void> {
  if (!canControlHost()) return;
  try {
    await hostInvoke('inject_mouse_button', {
      button,
      pressed,
      normX: normX ?? null,
      normY: normY ?? null,
    });
  } catch (err) {
    console.warn('[host] inject_mouse_button error:', err);
  }
}

export async function tauriInjectMouseWheel(deltaX: number, deltaY: number): Promise<void> {
  if (!canControlHost()) return;
  try {
    await hostInvoke('inject_mouse_wheel', {
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
    });
  } catch (err) {
    console.warn('[host] inject_mouse_wheel error:', err);
  }
}

export async function tauriInjectKey(code: string, pressed: boolean): Promise<boolean> {
  if (!canControlHost()) return false;
  try {
    return (await hostInvoke<boolean>('inject_key', { code, pressed })) ?? false;
  } catch (err) {
    console.warn('[host] inject_key error:', err);
    return false;
  }
}

export async function tauriPanicRevoke(reason: string = 'User panic'): Promise<InjectionStatus | null> {
  if (!canControlHost()) return null;
  try {
    return await hostInvoke<InjectionStatus>('panic_revoke', { reason });
  } catch (err) {
    console.warn('[host] panic_revoke error:', err);
    return null;
  }
}

export async function tauriGetInjectionStatus(): Promise<InjectionStatus | null> {
  if (!canControlHost()) return null;
  try {
    return await hostInvoke<InjectionStatus>('get_injection_status');
  } catch {
    return null;
  }
}

/**
 * Origin of the signaling server embedded in this app's host process.
 *
 * A packaged RemoteDesk runs its own rendezvous point, so hosting needs no
 * separate process. Returns `null` outside Tauri, or if the server could not
 * bind a port — callers then fall back to a manually configured URL.
 */
export async function tauriGetSignalUrl(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return (await invoke<string | null>('get_signal_url')) ?? null;
  } catch (err) {
    console.warn('[Tauri] get_signal_url error:', err);
    return null;
  }
}

/** LAN addresses and live room/peer counts for the embedded signaling server. */
export async function tauriGetNetworkInfo(): Promise<NetworkInfo | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<NetworkInfo>('get_network_info');
  } catch (err) {
    console.warn('[Tauri] get_network_info error:', err);
    return null;
  }
}

export interface WebviewCapabilities {
  hasGetDisplayMedia: boolean;
  hasWebRtc: boolean;
  hasDataChannels: boolean;
  userAgent: string;
  /** Origin the app is served from — decides secure-context status. */
  origin: string;
  /** WebRTC and capture APIs are only exposed in a secure context. */
  isSecureContext: boolean;
}

/** What this webview can actually do, as the running page sees it. */
export function probeWebviewCapabilities(): WebviewCapabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    hasGetDisplayMedia: typeof nav?.mediaDevices?.getDisplayMedia === 'function',
    hasWebRtc: typeof window !== 'undefined' && typeof window.RTCPeerConnection === 'function',
    hasDataChannels:
      typeof window !== 'undefined' &&
      typeof window.RTCPeerConnection?.prototype?.createDataChannel === 'function',
    userAgent: nav?.userAgent ?? 'unknown',
    origin: typeof window !== 'undefined' ? window.location.origin : 'unknown',
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext === true,
  };
}

/**
 * Reports webview capabilities to the host process so they appear in its log.
 *
 * Screen capture comes from the platform webview, and whether it works varies by
 * OS, runtime version and (on Linux) desktop portal — so the answer is recorded
 * at startup rather than discovered when an operator tries to share.
 */
export async function reportWebviewCapabilities(): Promise<WebviewCapabilities> {
  const caps = probeWebviewCapabilities();
  if (isTauri()) {
    try {
      await invoke('report_webview_capabilities', { caps });
    } catch (err) {
      console.warn('[Tauri] report_webview_capabilities error:', err);
    }
  }
  return caps;
}

/**
 * Clipboard access through the host process rather than the webview.
 *
 * `navigator.clipboard` needs a focused, permission-granted document, which is
 * exactly what a remote-control window often is not — and WebKitGTK on Linux is
 * stricter still. The Tauri clipboard plugin reads and writes the real OS
 * clipboard regardless of webview focus. Callers fall back to `navigator` when
 * these return `null` / `false`, so the web build is unaffected.
 */
export async function tauriReadClipboard(): Promise<string | null> {
  if (isTauri()) {
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return await readText();
    } catch (err) {
      console.warn('[host] clipboard read error:', err);
      return null;
    }
  }

  // Hosting from a browser: the host process owns the real clipboard, and
  // reading it there avoids the focus and permission rules a page is subject to.
  if (!canControlHost()) return null;
  try {
    return await hostInvoke<string | null>('clipboard_read');
  } catch (err) {
    console.warn('[host] clipboard read error:', err);
    return null;
  }
}

export async function tauriWriteClipboard(text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return true;
    } catch (err) {
      console.warn('[host] clipboard write error:', err);
      return false;
    }
  }

  if (!canControlHost()) return false;
  try {
    return (await hostInvoke<boolean>('clipboard_write', { text })) ?? false;
  } catch (err) {
    console.warn('[host] clipboard write error:', err);
    return false;
  }
}

/**
 * Saves a received file through the OS save dialog.
 *
 * A blob download is unreliable inside a desktop webview — WebKitGTK in
 * particular has no download UI of its own — so the host process writes the
 * bytes to a path the operator picks. Returns `false` when not running under
 * Tauri, or if the operator cancelled, so the caller can keep its browser
 * download link as the fallback.
 */
export async function tauriSaveFile(fileName: string, bytes: ArrayBuffer): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const path = await save({ defaultPath: fileName });
    if (!path) return false;
    await writeFile(path, new Uint8Array(bytes));
    return true;
  } catch (err) {
    console.warn('[Tauri] file save error:', err);
    return false;
  }
}

export interface FirewallStatus {
  /** False where the platform does not gate inbound connections this way. */
  applicable: boolean;
  /** Whether the inbound rule was found. Meaningless when not applicable. */
  rulePresent: boolean;
  /** Command the operator can run as administrator to add it. */
  fixCommand: string;
}

/**
 * Whether other machines can actually reach this host.
 *
 * Windows blocks inbound connections to a new program by default. The installer
 * adds a rule, but that can fail silently — when it does, the host looks
 * perfectly healthy while every client reports it as unreachable, and nothing
 * on either side explains why.
 *
 * Returns `null` outside Tauri, and `applicable: false` on platforms that do
 * not need the rule, so the caller can stay quiet rather than warn wrongly.
 */
export async function tauriFirewallStatus(): Promise<FirewallStatus | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<FirewallStatus>('firewall_status');
  } catch (err) {
    console.warn('[Tauri] firewall_status error:', err);
    return null;
  }
}
