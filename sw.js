/* Service worker — what makes Stride installable and able to open without a connection.
   Deliberately conservative: it caches the app's own shell only. Training data always
   comes fresh from the backend, so nothing here can show stale sessions or statuses.

   Bump CACHE when the shell changes so old copies get cleared out. */
const CACHE = 'stride-shell-v4';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
// Absolute pathnames, so a fetch's url.pathname can be checked against it directly.
// Deliberately excludes passcode.js: caching it would mean a changed passcode
// doesn't take effect until a second reload. Anything not in this list is left
// for the browser to fetch normally — not cached, not intercepted.
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
  // Anything off-origin — the Render backend, Chart.js, Google Fonts — is left alone.
  // Caching the API would risk showing yesterday's plan as though it were today's.
  if (url.origin !== self.location.origin) return;

  // The self-service app is a separate app that happens to live under
  // /self-service/ on the same site, so it falls inside this worker's scope by
  // accident rather than by intent. Leave every one of its requests alone.
  // Without this, the navigate handler below would store a self-service page as
  // this app's cached './index.html' — so opening Stride offline would show
  // someone else's sign-in screen — and an offline visit to self-service would
  // be answered with the personal app. It has its own worker; this one should
  // not touch it.
  if (url.pathname.includes('/self-service/')) return;

  // Page loads: try the network first so a redeploy is picked up immediately,
  // and fall back to the cached copy only when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Anything outside the known shell (passcode.js, passcode-tool.html, anything
  // added later) — don't intercept, let the browser fetch it fresh every time.
  if (!SHELL_PATHS.has(url.pathname)) return;

  // Shell icons and similar: serve from cache, refresh in the background.
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
