// Minimal service worker: makes the app installable and keeps the shell
// available through brief network hiccups. Deliberately network-first so a
// deployed update is picked up on the next load — no stale-shell surprises.
// API, WS and data requests are never cached.
const CACHE = 'aura-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/tts.js', '/login.html', '/manifest.json'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET') return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')
        || url.pathname.startsWith('/data/')) return;

    event.respondWith(
        fetch(event.request)
            .then((resp) => {
                if (resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE).then((c) => c.put(event.request, copy));
                }
                return resp;
            })
            .catch(() => caches.match(event.request))
    );
});
