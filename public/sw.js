// Offline cache: network first for the page, cache first for hashed assets.
const CACHE = 'droneon-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isAsset = /\/assets\/|\/img\/|\/icons\//.test(req.url);
  if (isAsset) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const c = res.clone(); caches.open(CACHE).then(ch => ch.put(req, c)); return res; })));
  } else {
    e.respondWith(fetch(req).then(res => { const c = res.clone(); caches.open(CACHE).then(ch => ch.put(req, c)); return res; }).catch(() => caches.match(req)));
  }
});
