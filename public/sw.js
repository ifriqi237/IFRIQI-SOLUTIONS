// IFRIQI service worker — minimal, network-first.
// The site is redeployed very frequently during active development, so this
// deliberately does NOT cache-first the app shell (a stale cached HTML/JS
// would be actively harmful). It exists mainly to satisfy the browser's
// installability requirement (a fetch-handling service worker), with only
// the small, rarely-changing icon files precached as an offline fallback.
const CACHE = 'ifriqi-shell-v1';
const SHELL = ['/icon-192.png','/icon-512.png','/icon-maskable-192.png','/icon-maskable-512.png','/favicon.ico'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
