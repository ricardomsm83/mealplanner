/* ============================================================
   Healthy Meal Planner — Service Worker
   Strategy:
     • App shell (HTML/CSS/JS/manifest/icons) → cache-first
     • Firebase SDK from gstatic CDN → stale-while-revalidate
     • Firestore / Auth API calls → network-only (never cache)
     • Everything else → network-first, fallback to cache
   ============================================================ */

const CACHE_VERSION = 'hmp-v1.0.0';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE   = `${CACHE_VERSION}-runtime`;

// Files that make up the "app shell" — pre-cached on install
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

// ============================================================
// INSTALL — pre-cache the app shell
// ============================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL).catch(err => {
        // Don't fail install if a non-critical asset is missing (e.g. optional icon)
        console.warn('[SW] Some shell assets failed to cache:', err);
      }))
      .then(() => self.skipWaiting()) // activate immediately on install
  );
});

// ============================================================
// ACTIVATE — clean up old caches from previous versions
// ============================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !k.startsWith(CACHE_VERSION))
          .map(k => {
            console.log('[SW] Removing old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ============================================================
// FETCH — routing strategies
// ============================================================
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests
  if (req.method !== 'GET') return;

  // 1) Never cache Firestore / Auth / Google APIs — always live network
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('firebaseinstallations.googleapis.com') ||
    url.hostname.includes('firebaseio.com')
  ) {
    return; // fall through to browser default (network)
  }

  // 2) Firebase SDK from gstatic → stale-while-revalidate
  if (url.hostname === 'www.gstatic.com' && url.pathname.includes('firebasejs')) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 3) Google user avatars → cache-first (they rarely change)
  if (url.hostname === 'lh3.googleusercontent.com') {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 4) Same-origin app assets → cache-first (app shell) with network update
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 5) Everything else → network-first with cache fallback
  event.respondWith(networkFirst(req));
});

// ============================================================
// STRATEGIES
// ============================================================
async function cacheFirst(req) {
  const cache = await caches.open(APP_SHELL_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    // Refresh in background (don't await)
    fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Offline fallback for HTML navigations
    if (req.mode === 'navigate') {
      return cache.match('./index.html');
    }
    throw err;
  }
}

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      return (await caches.match('./index.html')) || Response.error();
    }
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fetchPromise;
}

// ============================================================
// MESSAGE — allow the page to trigger skipWaiting on updates
// ============================================================
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
