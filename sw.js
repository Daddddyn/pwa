/* ══════════════════════════════════════════
   AFlix Service Worker — sw.js
   Caches the app shell for offline launch.
   API/media requests always go to network.
   Ad network requests are blocked entirely.
══════════════════════════════════════════ */

const CACHE_NAME = 'aflix-v3';

// App shell files to cache on install
const SHELL_FILES = [
  './',
  './index.html',
  './adblock.js',
  './popup-blocker.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.7/hls.min.js'
];

/* ── AD NETWORK BLOCKLIST ──────────────────────────────────────
   Dynamically sourced from AdGuard's published filter lists.
   On install the SW fetches these lists, parses out all blocked
   hostnames, stores them in Cache Storage, and refreshes them
   every 48 hours. Falls back to the built-in seed list if the
   network is unavailable.
───────────────────────────────────────────────────────────────*/

// Remote filter lists to fetch (Adblock / hosts syntax)
// These are official AdGuard-maintained lists, updated daily.
const FILTER_LISTS = [
  // AdGuard DNS filter — combines Base, Social, Tracking, EasyList, EasyPrivacy
  'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt',
  // AdGuard Popup Ads filter — specifically targets popups & redirects
  'https://filters.adtidy.org/extension/ublock/filters/19.txt',
  // EasyPrivacy — trackers & fingerprinting
  'https://easylist.to/easylist/easyprivacy.txt',
];

const BLOCKLIST_CACHE_KEY  = 'aflix-adblock-hosts-v1';
const BLOCKLIST_TS_KEY     = 'aflix-adblock-ts-v1';
const BLOCKLIST_REFRESH_MS = 48 * 60 * 60 * 1000; // 48 hours

// Seed list — used immediately on first load before filter lists download,
// and as a permanent fallback if all fetches fail.
const SEED_HOSTS = new Set([
  'doubleclick.net','googlesyndication.com','adservice.google.com',
  'googletagservices.com','googleadservices.com',
  'popads.net','popcash.net','popunder.net','pop.network',
  'exoclick.com','exosrv.com','exdynsrv.com',
  'trafficjunky.net','trafficjunky.com',
  'juicyads.com','hilltopads.net','hilltopads.com',
  'adnxs.com','adnxs-simple.com',
  'rubiconproject.com','openx.net','openx.com',
  'pubmatic.com','criteo.com','criteo.net',
  'smartadserver.com','clickadu.com','adcash.com',
  'propellerads.com','adsterra.com',
  'yllix.com','clkrev.com','go2jump.org','go2cloud.org',
  'tsyndicate.com','adspyglass.com','trafmag.com',
  'bidvertiser.com','revcontent.com','mgid.com',
  'taboola.com','outbrain.com',
  'adform.net','appnexus.com','appnexus.net',
  'casalemedia.com','improvedigital.com',
  'triplelift.com','sharethrough.com','indexexchange.com',
  'districtm.io','districtm.ca','bidswitch.net',
  'scorecardresearch.com','quantserve.com','comscore.com',
  'hotjar.com','fullstory.com',
  'onesignal.com','pushcrew.com','richpush.co',
  'sendpulse.com','pushengage.com','pushwoosh.com','gravitec.net',
  'ero-advertising.com','adultadworld.com','plugrush.com',
  'adxpansion.com','tubecorporate.com',
  'onclickads.net','onclick.io',
  'clickaine.com','clickadilla.com',
  'trafficfactory.biz','dtscdn.com','dtsrv.com',
  'adskeeper.co.uk','adskeeper.com',
  'connatix.com','media.net',
  'spotxchange.com','spotx.tv','teads.tv',
  'advertising.com','adnetwork.net','yads.com'
]);

// Live set — starts as seed, gets replaced when filter lists load
let adHostSet = new Set(SEED_HOSTS);

/* Parse an Adblock/hosts/domains filter file into a Set of hostnames.
   Handles:
     ||example.com^                  (Adblock network rule)
     ||example.com^$popup            (with options)
     0.0.0.0 example.com            (hosts file)
     example.com                    (domains-only)
*/
function parseFilterList(text) {
  const hosts = new Set();
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('#')) continue;

    // Adblock-style: ||hostname^  or  ||hostname^$options
    if (line.startsWith('||')) {
      const end   = line.search(/[\^\/\$]/);
      const host  = line.slice(2, end > 2 ? end : undefined).toLowerCase();
      if (host && !host.includes('/') && host.includes('.')) hosts.add(host);
      continue;
    }

    // hosts-file style: 0.0.0.0 hostname  or  127.0.0.1 hostname
    if (line.startsWith('0.0.0.0') || line.startsWith('127.0.0.1')) {
      const parts = line.split(/\s+/);
      if (parts[1] && parts[1].includes('.') && !parts[1].includes('/')) {
        hosts.add(parts[1].toLowerCase());
      }
      continue;
    }

    // domains-only: bare hostname with no spaces or slashes
    if (!line.includes(' ') && !line.includes('/') &&
        !line.startsWith('@') && !line.startsWith('[') &&
        line.includes('.')) {
      hosts.add(line.toLowerCase());
    }
  }
  return hosts;
}

/* Fetch all filter lists, merge into one Set, persist in Cache Storage */
async function refreshBlocklist() {
  let merged = new Set(SEED_HOSTS);
  let anySucceeded = false;

  for (const url of FILTER_LISTS) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseFilterList(text);
      for (const h of parsed) merged.add(h);
      anySucceeded = true;
      console.log(`[AFlix SW] Loaded ${parsed.size} rules from ${url}`);
    } catch(e) {
      console.warn(`[AFlix SW] Filter list fetch failed: ${url}`, e);
    }
  }

  if (anySucceeded) {
    adHostSet = merged;
    // Persist the merged set so it survives SW restarts
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(
        BLOCKLIST_CACHE_KEY,
        new Response(JSON.stringify([...merged]), {
          headers: { 'Content-Type': 'application/json' }
        })
      );
      await cache.put(
        BLOCKLIST_TS_KEY,
        new Response(String(Date.now()), {
          headers: { 'Content-Type': 'text/plain' }
        })
      );
    } catch(e) {}
    console.log(`[AFlix SW] Blocklist updated — ${merged.size} total rules`);
  }
  return merged;
}

/* Load persisted blocklist from cache (fast, no network) */
async function loadPersistedBlocklist() {
  try {
    const cache = await caches.open(CACHE_NAME);

    // Check if refresh is needed
    const tsRes = await cache.match(BLOCKLIST_TS_KEY);
    if (tsRes) {
      const ts = Number(await tsRes.text());
      if (Date.now() - ts < BLOCKLIST_REFRESH_MS) {
        const blRes = await cache.match(BLOCKLIST_CACHE_KEY);
        if (blRes) {
          const arr = await blRes.json();
          adHostSet = new Set(arr);
          console.log(`[AFlix SW] Blocklist restored from cache — ${adHostSet.size} rules`);
          return; // still fresh, no fetch needed
        }
      }
    }
  } catch(e) {}
  // Cache missing or stale — refresh in background (don't block fetch events)
  refreshBlocklist();
}

function isAdRequest(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Exact match first (fast path)
    if (adHostSet.has(hostname)) return true;
    // Walk up subdomains: sub.example.com → example.com
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      if (adHostSet.has(parts.slice(i).join('.'))) return true;
    }
    return false;
  } catch(e) { return false; }
}

// Install: cache app shell + kick off first blocklist fetch
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
    }).then(() => refreshBlocklist()) // fetch AdGuard lists on first install
  );
});

// Activate: clear old caches + restore saved blocklist
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => loadPersistedBlocklist())
     .then(() => self.clients.claim())
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

  // ── EMBED SERVERS — fetch + inject popup-blocker.js ─────────────
  // The SW can't block ad requests *inside* iframes (they come from
  // the embed server's origin, not ours).  BUT — if we can intercept
  // the embed server's HTML response and prepend our popup-blocker.js
  // script tag, then our blocker runs inside the iframe too, patching
  // window.open / location / etc. before any ad code can call them.
  //
  // This is the exact same technique AdGuard uses: inject a content
  // script into every page it proxies.
  //
  // We only inject into HTML responses (not JS/images/streams).
  // Non-HTML responses from embed servers pass through unmodified.
  const EMBED_HOSTS = [
    'player.videasy.net', 'videasy.net',
    'vidlink.pro',
    'player.autoembed.cc', 'autoembed.cc',
    'vidfast.pro',
    'vidsrc.cc', 'vembed.stream',
  ];

  // The blocker script URL — absolute so it works from any iframe origin.
  // IMPORTANT: replace this with your actual deployed domain.
  const BLOCKER_SCRIPT_URL = self.registration.scope + 'popup-blocker.js';

  // The snippet we prepend to every HTML page from an embed server.
  const INJECT_SNIPPET =
    `<script src="${BLOCKER_SCRIPT_URL}" crossorigin="anonymous"></` + `script>`;

  if (EMBED_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(
      fetch(request, { mode: 'no-cors' })
        .then(async response => {
          const ct = response.headers.get('content-type') || '';
          // Only rewrite HTML — pass JS, HLS playlists, etc. straight through
          if (!ct.includes('text/html')) return response;

          const original = await response.text();
          // Inject right after <head> or at the very start if no <head>
          let rewritten;
          if (original.includes('<head>')) {
            rewritten = original.replace('<head>', '<head>' + INJECT_SNIPPET);
          } else if (original.includes('<html')) {
            rewritten = original.replace(/<html[^>]*>/, m => m + INJECT_SNIPPET);
          } else {
            rewritten = INJECT_SNIPPET + original;
          }

          return new Response(rewritten, {
            status:     response.status,
            statusText: response.statusText,
            headers:    response.headers,
          });
        })
        .catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // Never cache: API calls, IPTV streams, other network-only resources
  const networkOnly = [
    'api.themoviedb.org', 'image.tmdb.org',
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
