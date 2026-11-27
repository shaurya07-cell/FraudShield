// FraudShield Service Worker — caches app shell only, never API or WebSocket.
const CACHE_NAME = 'fraudshield-shell-v1';

// Populated at build time by file‐hash names; at runtime we cache whatever
// the app shell requests on first load.
const APP_SHELL_PATHS = ['/', '/index.html'];

// Patterns that must NEVER be cached — API calls, WebSocket, and hot-reload.
const NEVER_CACHE = [
  /\/api\b/,
  /\/score\b/,
  /\/metrics\b/,
  /\/graph\b/,
  /\/transactions\b/,
  /\/simulate\b/,
  /\/reset\b/,
  /\/gateway\b/,
  /\/razorpay\b/,
  /\/payments\b/,
  /\/stream\b/,
  /\/health\b/,
  /\/ws\b/,
  /^wss?:\/\//,
  /sockjs/,
  /hot-update/,
  /__vite/,
];

function shouldCache(url) {
  const u = new URL(url);
  // Never cache cross-origin API requests
  if (u.origin !== self.location.origin) return false;
  // Never cache API / WS paths
  for (const pattern of NEVER_CACHE) {
    if (pattern.test(u.pathname) || pattern.test(url)) return false;
  }
  return true;
}

// Install: pre-cache the HTML shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_PATHS))
  );
  self.skipWaiting();
});

// Activate: purge old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for navigation, cache-first for static assets,
// always pass through for API / WS.
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET and anything we must never cache
  if (request.method !== 'GET' || !shouldCache(request.url)) return;

  // Navigation requests (HTML pages): network-first, fall back to cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets (JS, CSS, fonts, images): cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Only cache successful same-origin responses
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
