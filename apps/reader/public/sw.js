/* App-shell cache so the reader UI still loads when the network is down. API calls are never cached. */
const CACHE = 'kiu-reader-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))); });
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreVary: true }).then((r) => r || caches.match("/", { ignoreVary: true }))),
  );
});

// The page tells the worker which hashed assets it loaded, so a later offline reload can serve the whole app shell.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'CACHE' && Array.isArray(e.data.urls)) {
    e.waitUntil(caches.open(CACHE).then((c) => Promise.all(e.data.urls.map((u) => c.add(u).catch(() => undefined)))));
  }
});
