// DRONE ON service worker. Generated at build time: the cache version and the
// asset list are filled in by the precache plugin in vite.config.ts.
//
// First visit installs everything the game needs, so the second launch works
// offline. Pages and other unhashed files go to the network first and fall
// back to the cache; hashed build files are immutable and come from the cache.

const CACHE = 'droneon-__VERSION__';
const ASSETS = __ASSETS__;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // one by one, so a single missing file never breaks the whole install
    await Promise.all(ASSETS.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch { /* offline during install: it fills in later */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('droneon-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const put = async (req, res) => {
  if (!res || !res.ok || res.type === 'opaque') return;
  const cache = await caches.open(CACHE);
  await cache.put(req, res);
};

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const hashed = /\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(url.pathname);
  if (hashed) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { put(req, res.clone()); return res; })));
    return;
  }
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      put(req, res.clone());
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // an offline navigation always gets the game shell
      if (req.mode === 'navigate') { const shell = await caches.match('./index.html') || await caches.match('./'); if (shell) return shell; }
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
