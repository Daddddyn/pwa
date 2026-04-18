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
  // Google ad infrastructure
  'doubleclick.net', 'googlesyndication.com', 'adservice.google.com',
  'googletagmanager.com', 'googletagservices.com', 'googleadservices.com',
  // Major ad networks
  'popads.net', 'popcash.net', 'popunder.net',
  'exoclick.com', 'exosrv.com',
  'trafficjunky.net', 'trafficjunky.com',
  'juicyads.com', 'hilltopads.net', 'hilltopads.com',
  'adnxs.com', 'adnxs-simple.com',
  'rubiconproject.com', 'openx.net', 'openx.com',
  'pubmatic.com', 'criteo.com', 'criteo.net',
  'smartadserver.com', 'smartadserver.net',
  'clickadu.com', 'adcash.com', 'adcash.net',
  'propellerads.com', 'propellerclick.com',
  'adsterra.com', 'adsterra.net',
  'yllix.com', 'clkrev.com',
  'go2jump.org', 'tsyndicate.com', 'adspyglass.com',
  'trafmag.com', 'bidvertiser.com',
  'revcontent.com', 'mgid.com',
  'richpush.co', 'pushcrew.com',
  'onesignal.com',
  // Popup / redirect ad networks
  'popcash.net', 'popads.net', 'popunder.net', 'pop.network',
  'clickaine.com', 'clickadilla.com',
  'trafficfactory.biz', 'trafficfactory.com',
  'ero-advertising.com', 'ero-advertising.net',
  'exdynsrv.com', 'exosrv.com',
  'dtscdn.com', 'dtsrv.com',
  'adskeeper.co.uk', 'adskeeper.com',
  'ad-center.com', 'adcenter.net',
  'adcolony.com', 'inmobi.com',
  'moatads.com', 'spotxchange.com',
  'spotx.tv', 'teads.tv', 'teads.com',
  'connatix.com', 'media.net',
  'taboola.com', 'outbrain.com',
  'zergnet.com', 'plista.com',
  'ligatus.com', 'contentad.net',
  'adition.com', 'adform.net', 'adform.com',
  'appnexus.com', 'appnexus.net',
  'yieldmo.com', 'yieldlab.net', 'yieldlab.de',
  'casalemedia.com', 'improve-digital.com',
  'improvedigital.com', 'lijit.com',
  'sovrn.com', 'contextweb.com',
  'servedby-buysellads.com', 'buysellads.com',
  'carbonads.com', 'carbonads.net',
  'triplelift.com', 'sharethrough.com',
  'indexexchange.com', '33across.com',
  'yavli.com', 'districtm.io',
  'districtm.ca', 'emxdgt.com',
  'kargo.com', 'bidswitch.net',
  '1rx.io', 'adsymptotic.com',
  'synacor.com', 'undertone.com',
  'aol.com', 'advertising.com',
  // Tracker / fingerprinting
  'scorecardresearch.com', 'quantserve.com',
  'comscore.com', 'chartbeat.com',
  'hotjar.com', 'fullstory.com',
  'mouseflow.com', 'luckyorange.com',
  // Push notification spam
  'onesignal.com', 'pushcrew.com', 'richpush.co',
  'sendpulse.com', 'pushengage.com',
  'izooto.com', 'webpushr.com',
  'pushwoosh.com', 'gravitec.net',
  // Adult ad networks (common in embed servers)
  'juicyads.com', 'trafficjunky.net',
  'trafficjunky.com', 'ero-advertising.com',
  'adultadworld.com', 'adsexposed.com',
  'adultforce.com', 'plugrush.com',
  'exoclick.com', 'adxpansion.com',
  'trafmag.com', 'tubecorporate.com',
  // Crypto / malware ad redirectors
  'clkrev.com', 'go2jump.org', 'go2cloud.org',
  'onclickads.net', 'onclicka.com',
  'onclick.io', 'adsterra.com',
  'retroavenue.com', 'gamingadventures.net',
  'yads.com', 'adnetwork.net'
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
    'api.themoviedb.org', 'image.tmdb.org',
    'player.videasy.net', 'videasy.net',
    'vidlink.pro',
    'player.autoembed.cc', 'autoembed.cc',
    'vidfast.pro',
    'vidsrc.cc', 'vembed.stream',
    'raw.githubusercontent.com', 'corsproxy.io',
    'youtube.com', 'youtu.be'
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
