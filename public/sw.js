// RemoteDesk Service Worker for PWA Offline & Install Support
const CACHE_NAME = 'remotedesk-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Let WebSockets, WebRTC, and API requests go directly to network
  if (
    event.request.url.includes('/rtc') ||
    event.request.url.includes('/network-info') ||
    event.request.url.includes('/healthz')
  ) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
