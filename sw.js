/* ══════════════════════════════════════════
   AFlix Service Worker — sw.js  (v2 hardened)
   ─────────────────────────────────────────
   Two jobs:
   1. Cache the app shell for offline launch
   2. Block ad/tracker network requests at the
      fetch level — BEFORE they reach the page.

   This is the most effective popup-blocking
   layer because it stops the ad scripts from
   loading at all, regardless of what the
   iframe's JS tries to do.
══════════════════════════════════════════ */

const CACHE_NAME = 'aflix-v3';

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

/* ══════════════════════════════════════════
   AD / POPUP SCRIPT BLOCKLIST
   Sources: uBlock Origin uAssets, AdGuard filters,
   EasyList, community streaming site reports.
   Blocks the actual scripts that inject popups —
   not just the final ad destination URLs.
══════════════════════════════════════════ */
const AD_BLOCK_PATTERNS = [
  // Ad networks (exact hostname fragments)
  'doubleclick.net',
  'googlesyndication.com',
  'adservice.google',
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
  'onesignal.com',
  'pushcrew.com',
  'adskeeper.com',
  'adtelligent.com',
  'undertone.com',
  'themoneytizer.com',
  'adform.net',
  '33across.com',
  'yieldmo.com',
  'appnexus.com',
  'lijit.com',
  'sovrn.com',
  'advertising.com',
  'turn.com',
  'casalemedia.com',
  'contextweb.com',
  'taboola.com',
  'outbrain.com',
  'zergnet.com',
  'popunder.ru',
  'onclkds.com',         // onclick/popunder network
  'onclickads.net',
  'adclickads.net',
  'clickaine.com',
  'adsrvr.org',
  'monetizer101.com',
  'adscpm.com',
  'popad.net',
  'popcpm.com',
  'pop.odsmt.com',
  'trafficfactory.biz',
  'etargetnet.com',
  'fleshlightads.com',
  'exosrv.com',          // ExoClick serve domain
  'exoclick.com',
  'juicyads.com',
  'a-ads.com',
  'cointraffic.io',
  'coinzilla.io',
  'bitmedia.io',
  'adbitcoin.network',
  // Popunder/redirect scripts commonly injected by embed players
  'popupads.net',
  'popcpm.net',
  'popad.net',
  'onclick.io',
  'onclk.io',
  'pop-ads.net',
  'popwam.com',
  'ero-advertising.com',
  'trafficjunky.com',
  'adultadworld.com',
  // Tracking / fingerprinting that feeds ad targeting
  'scorecardresearch.com',
  'quantserve.com',
  'chartbeat.com',
  'hotjar.com',
  'mouseflow.com',
  'crazyegg.com',
  // Known popup-injecting CDNs used by streaming embeds
  'static.cloudflareinsights.com', // not blocking cloudflare itself
  'cdn.seedtag.com',
  'cdn.adnxs.com',
  'ads.yahoo.com',
  'ads2.mgid.com',
  'a.adtng.com',
  'cdn.traffective.com',
  'ad.sonar.wherewolf.com.au',
  'btloader.com',         // Blockthrough anti-adblock
  'fundingchoicesmessages.google.com',
  'pagead2.googlesyndication.com',
];

/* Quick hostname extraction — no regex, just splits */
function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch(e) { return ''; }
}

function isBlocked(url) {
  const h = getHostname(url);
  if (!h) return false;
  return AD_BLOCK_PATTERNS.some(p => h === p || h.endsWith('.' + p) || h.includes(p));
}

/* Also block by URL path patterns for scripts commonly used for popups */
const BLOCKED_PATH_PATTERNS = [
  '/popunder',
  '/popup',
  '/pop.js',
  '/pop-up',
  '/pops.js',
  '/onclick',
  '/clickunder',
  '/tabunder',
  '/tabup',
  '/pjslib',          // common popunder lib name
  '/push-notifications',
  '/push.js',
  '/sw-check-permissions',
];

function isBlockedPath(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    return BLOCKED_PATH_PATTERNS.some(p => path.includes(p));
  } catch(e) { return false; }
}

/* ── INSTALL ──────────────────────────────── */
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_FILES.map(url => {
        if (url.startsWith('http')) return new Request(url, { mode: 'no-cors' });
        return url;
      })).catch(err => {
        console.warn('[AFlix SW] Shell cache failed (non-fatal):', err);
      });
    })
  );
});

/* ── ACTIVATE ─────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH ────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* BLOCK: ad networks & popup scripts → silent 204 */
  if (isBlocked(request.url) || isBlockedPath(request.url)) {
    event.respondWith(new Response('', {
      status: 204,
      statusText: 'No Content',
      headers: { 'X-AFlix-Blocked': 'ad-network' }
    }));
    return;
  }

  /* NETWORK ONLY: API, embeds, streams */
  const networkOnly = [
    'api.themoviedb.org',
    'image.tmdb.org',
    'vidsrc', 'vembed', 'vidlink', 'videasy', 'vidfast',
    'raw.githubusercontent.com',
    'corsproxy.io',
    'youtube.com', 'youtu.be'
  ];
  if (networkOnly.some(h => url.hostname.includes(h))) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  /* STALE-WHILE-REVALIDATE: fonts, CDN */
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          const fetchP = fetch(request).then(r => {
            if (r.ok || r.type === 'opaque') cache.put(request, r.clone());
            return r;
          });
          return cached || fetchP;
        })
      )
    );
    return;
  }

  /* CACHE FIRST: app shell */
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(r => {
        if (r.ok) caches.open(CACHE_NAME).then(c => c.put(request, r.clone()));
        return r;
      }).catch(() => {
        if (request.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 503 });
      });
    })
  );
});
