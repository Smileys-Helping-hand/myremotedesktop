import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { setEmbeddedSignalUrl } from './hooks/useWebRTC';
import { isTauri, reportWebviewCapabilities, tauriGetSignalUrl } from './utils/tauriBridge';
import { captureControlToken, isBrowserHostSession } from './utils/hostControl';
import './index.css';


/**
 * Resolve the embedded signaling server's origin before the first render.
 *
 * The desktop app runs its own signaling server inside the Rust host process,
 * and its port is only known at runtime (4000, or the next free one when
 * another instance already holds it). Views read the URL synchronously, so it
 * has to be cached before they mount. Outside Tauri this resolves to `null` and
 * the app falls back to a same-origin guess.
 */
async function boot() {
  // Must run before anything asks whether this page can drive the host: the
  // token arrives in the URL and is stripped from it immediately.
  captureControlToken();
  if (isBrowserHostSession()) {
    console.info('[boot] host control is available over the local channel');
  }

  try {
    setEmbeddedSignalUrl(await tauriGetSignalUrl());
  } catch (err) {
    console.warn('[boot] embedded signaling server unavailable:', err);
    setEmbeddedSignalUrl(null);
  }

  // Records in the host log whether this webview can capture the screen at all,
  // so a host that cannot share is diagnosable without reproducing it.
  const caps = await reportWebviewCapabilities();
  if (!caps.hasGetDisplayMedia) {
    console.warn('[boot] this webview cannot capture the screen; hosting is unavailable here');
  }

  registerServiceWorker();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

/**
 * Registers the offline service worker — for the browser client only.
 *
 * In the desktop app the assets are already local, so a service worker buys
 * nothing and costs something: registration fails against Tauri's custom
 * protocol (logging an error every launch), and if it did succeed it would
 * serve a cached app shell over the one shipped in the next release.
 */
function registerServiceWorker() {
  if (isTauri() || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.debug('ServiceWorker registration skipped:', err);
    });
  });
}

void boot();
