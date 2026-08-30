/**
 * Globals the platform injects that TypeScript cannot infer.
 *
 * Tauri exposes these on `window` in the desktop build only; `isTauri()` in
 * `src/utils/tauriBridge.ts` probes for them to decide whether the native host
 * commands are available.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: Record<string, unknown>;
    __TAURI__?: Record<string, unknown>;
  }
}

export {};
