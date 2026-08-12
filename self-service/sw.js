/* Service worker for the self-service app — what makes it installable to a
   home screen and able to open without a connection.

   Registered from a page under /self-service/, so its scope is that folder
   only. It is deliberately a separate worker from the personal app's ../sw.js:
   the two apps have separate shells, and that one now explicitly ignores
   anything under /self-service/ so the pair can't cache over each other.

   Same conservative approach as the personal app: the shell only. Plan data
   always comes fresh from the backend, so nothing here can show a stale
   session or status. config.js is deliberately not cached — it holds the
   Supabase/backend URLs and needs to take effect the moment it changes.

   Bump CACHE when the shell changes so old copies get cleared out. */
const CACHE = 'stride-selfservice-shell-v1';

const SHELL = [
  './',
  './index.html',
  './generate-plan.html',
  './upload.html',
  './reset-password.html',
  './strava-callback.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  '../icons/favicon.svg',
  '../icons/icon-192.png',
  '../icons/icon-512.png',
  '../icons/apple-touch-icon.png'
];
const SHELL_PATHS = new Set(SHELL.map((u) => new URL(u, self.location).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    // addAll fails the whole install if any one file 404s, so add them individually.
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Off-origin — the Render backend, Supabase, Google Fonts, the Supabase CDN —
  // is left alone. Caching the API would risk showing yesterday's plan.
  if (url.origin !== self.location.origin) return;

  // Page loads: network first, so a redeploy is picked up immediately, falling
  // back to the cached copy of that same page only when offline. Unlike the
  // personal app this app has several pages, so each is cached under its own
  // URL rather than all collapsing onto one index.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Anything outside the known shell (config.js above all) — don't intercept.
  if (!SHELL_PATHS.has(url.pathname)) return;

  // Shell assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
