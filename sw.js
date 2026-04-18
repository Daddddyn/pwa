/* ══════════════════════════════════════════
   AFlix Service Worker — sw.js
   Caches the app shell for offline launch.
   API/media requests always go to network.
   Ad network requests are blocked entirely.
══════════════════════════════════════════ */

const CACHE_NAME = 'aflix-v2';

// App shell files to cache on install
const SHELL_FILES = [
  './',
  './index.html',
  './adblock.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.7/hls.min.js'
];

/* ── AD NETWORK BLOCKLIST ──────────────────────────────────────
   Requests from any of these hostname fragments are intercepted
   by the service worker and returned as a 204 No Content,
   meaning the ad resource simply never loads.
   Add more entries as needed.
───────────────────────────────────────────────────────────────*/
const AD_NETWORK_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'adservice.google.com',
  'popads.net',
  'popcash.net',
  'exoclick.com',
  'trafficjunky.net',
  'juicyads.com',
  'hilltopads.net',
  'adnxs.com',
  'rubiconproject.com',
  'openx.net',
  'pubmatic.com',
  'criteo.com',
  'smartadserver.com',
  'clickadu.com',
  'adcash.com',
  'propellerads.com',
  'adsterra.com',
  'yllix.com',
  'clkrev.com',
  'go2jump.org',
  'tsyndicate.com',
  'adspyglass.com',
  'trafmag.com',
  'bidvertiser.com',
  'revcontent.com',
  'mgid.com',
  'richpush.co',
  'pushcrew.com',
  'onesignal.com'
];

function isAdRequest(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return AD_NETWORK_HOSTS.some(h => hostname.includes(h));
  } catch(e) { return false; }
}

// Install: cache app shell
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_FILES.map(url => {
        // Use no-cors for cross-origin requests
        if (url.startsWith('http')) {
          return new Request(url, { mode: 'no-cors' });
        }
        return url;
      })).catch(err => {
        console.warn('[AFlix SW] Shell cache failed (non-fatal):', err);
      });
    })
  );
});

// Activate: clear old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
//   - AD NETWORKS → Block immediately (204 No Content)
//   - App shell (same-origin HTML/JS/CSS/icons) → Cache First, then Network
//   - TMDB API / embed iframes / IPTV streams → Network Only (no caching)
//   - Google Fonts / CDN scripts → Stale While Revalidate
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── BLOCK AD NETWORKS ─────────────────────────────────────────
  // Return an empty 204 so ads silently fail without errors
  if (isAdRequest(request.url)) {
    event.respondWith(new Response('', {
      status: 204,
      statusText: 'No Content',
      headers: { 'X-AFlix-Blocked': 'ad-network' }
    }));
    return;
  }

  // Never cache: API calls, embed streams, CORS fetch for playlists
  const networkOnly = [
    'api.themoviedb.org',
    'image.tmdb.org',
    'vidlink.pro',
    'vidsrc',
    'vembed',
    'raw.githubusercontent.com',
    'corsproxy.io',
    'youtube.com',
    'youtu.be'
  ];
  if (networkOnly.some(h => url.hostname.includes(h))) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Google Fonts + CDN: stale-while-revalidate
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          const fetchPromise = fetch(request).then(response => {
            if (response.ok || response.type === 'opaque') {
              cache.put(request, response.clone());
            }
            return response;
          });
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // App shell: cache first, fallback to network, fallback to index.html
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
        }
        return response;
      }).catch(() => {
        // Offline fallback: serve index.html for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});
