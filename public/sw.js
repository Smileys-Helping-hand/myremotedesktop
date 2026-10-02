// RemoteDesk service worker — offline app shell for the browser client.
//
// It exists to keep the page loadable, and nothing more. Everything this app
// actually does is a live request to a signaling server, which may be this
// origin or another machine's, and a cached or failed answer to one of those is
// worse than no answer at all.
//
// The previous version intercepted every request except three named paths and
// answered a failure with `caches.match(...)`, which resolves to `undefined`
// when nothing is cached — and `respondWith(undefined)` is a network error. A
// probe to a host's `/discover` or `/hosts` therefore failed instantly, inside
// the page, before it ever reached the network, and looked to the app exactly
// like a machine that was not there. LAN discovery could not work at all.

const CACHE_NAME = 'remotedesk-v3-gaming';

/** Live endpoints: always the network, never this worker. */
const LIVE_PATHS = new Set([
  '/rtc',
  '/control',
  '/healthz',
  '/network-info',
  '/hosts',
  '/discover',
]);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop the previous cache, whose entries were populated under the old
      // rule and may include API responses that must never be replayed.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Anything aimed at another origin is a host we are talking to — signaling,
  // discovery, file downloads. Not ours to touch.
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET') return;
  if (LIVE_PATHS.has(url.pathname) || url.pathname.startsWith('/api/')) return;

  // The app shell: network first, so a new release is picked up, with the
  // cache as the offline fallback. A miss propagates the real network error
  // rather than being turned into an opaque one.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
