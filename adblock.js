/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js
   ──────────────────────────────────────────────────────────────
   Pure JS ad blocking — no iframe sandbox used (servers detect
   any sandbox token and refuse to play).

   8-LAYER DEFENCE:
   1. window.open() override        — kills all popup/popunder attempts
   2. Top-frame navigation guard    — blocks window.top.location hijacks
   3. Anchor click intercept        — kills injected outbound link clicks
   4. beforeunload redirect guard   — cancels unload-based ad redirects
   5. MutationObserver              — removes injected ad nodes/overlays
   6. aflixHardenIframe()           — enforces allow attrs, removes sandbox
   7. postMessage firewall          — drops ad/redirect cross-frame msgs
   8. Continuous overlay scanner    — polls every 800ms for hover ad divs
   + Service Worker (sw.js)         — blocks ad network requests at network level
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── SHARED: ad hostname fragments & safe origins ─────────── */

  const AD_HOSTS = [
    'doubleclick', 'googlesyndication', 'adservice', 'popads',
    'popcash', 'exoclick', 'trafficjunky', 'juicyads', 'hilltopads',
    'adnxs', 'rubiconproject', 'openx', 'pubmatic', 'criteo',
    'smartadserver', 'advertising', 'clickadu', 'adcash',
    'propellerads', 'adsterra', 'yllix', 'clkrev', 'onclick',
    'popunder', 'go2jump', 'tsyndicate', 'adspyglass', 'trafmag',
    'bidvertiser', 'revcontent', 'mgid', 'richpush', 'pushcrew',
    'onesignal', 'adult', 'xxx', 'porn', 'sex', 'nude', 'naked',
    'erotic', 'onlyfans', 'chaturbate', 'livejasmin', 'cams.com',
    'trafficstars', 'adskeeper', 'adtelligent', 'undertone',
    'outbrain', 'taboola', 'zedo', 'adhigher', 'adform',
    'valueclick', 'conversantmedia', 'servedby', 'ad.fly',
    'adf.ly', 'linkbucks', 'shorte.st', 'exe.io', 'ouo.io',
    'bc.vc', 'shink.me', 'cashurl', 'clicksfly', 'fc.lc',
    'shrinkme', 'gplinks', 'oke.io'
  ];

  const SAFE_ORIGINS = [
    'player.videasy.net', 'videasy.net',
    'player.autoembed.cc', 'autoembed.cc',
    'vidfast.pro',
    'vidsrc.icu',
    'vidsrc.me',
    '2embed.online', 'www.2embed.online',
    'vidsrc.cc', 'vidsrc.to', 'vidsrc.xyz', 'vidsrc.su', 'vidsrc.vip',
    'vidlink.pro', 'embed.su', 'moviesapi.club', 'vembed.stream',
    'youtube.com', 'youtu.be',
    'themoviedb.org', 'image.tmdb.org',
    window.location.hostname
  ];

  function isAdUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(String(url), window.location.href);
      const str = (u.hostname + u.pathname).toLowerCase();
      return AD_HOSTS.some(h => str.includes(h));
    } catch(e) {
      return AD_HOSTS.some(h => String(url).toLowerCase().includes(h));
    }
  }

  function isSafeOrigin(url) {
    try {
      const host = new URL(String(url), window.location.href).hostname;
      return SAFE_ORIGINS.some(o => host === o || host.endsWith('.' + o));
    } catch(e) { return false; }
  }

  /* ── 1. window.open() OVERRIDE ─────────────────────────────── */
  // Returns convincing fake window so player feature-detection passes.
  // about:blank opens pass through (players use for feature checks).
  // Same-origin opens pass through (player subtitle/quality popups).
  // Everything else: dead fake window, nothing opens.

  const _realOpen = window.open.bind(window);

  function _fakeWindow() {
    const fake = {
      closed: false, name: '_blank', opener: window,
      location: { href: 'about:blank', assign(){}, replace(){}, reload(){} },
      document: { write(){}, writeln(){}, close(){}, open(){},
                  readyState: 'complete', body: { innerHTML: '' } },
      history:  { back(){}, forward(){}, go(){} },
      focus(){}, blur(){},
      close() { this.closed = true; },
      postMessage(){}, addEventListener(){}, removeEventListener(){},
      setTimeout:  (fn, ms) => setTimeout(fn, ms),
      clearTimeout: id => clearTimeout(id),
    };
    setTimeout(() => { fake.closed = true; }, 100);
    return fake;
  }

  window.open = function(url, target, features) {
    try {
      if (url && url !== '' && url !== 'about:blank') {
        const u = new URL(String(url), window.location.href);
        if (u.origin === window.location.origin) return _realOpen(url, target, features);
        if (isAdUrl(url)) { console.warn('[AFlix AdBlock] Blocked ad open:', url); return _fakeWindow(); }
      }
      // about:blank / empty — pass through for player feature-detection
      if (!url || url === '' || url === 'about:blank') {
        const w = _realOpen('about:blank', '_blank',
          'width=1,height=1,left=-99999,top=-99999,toolbar=no,menubar=no');
        if (w) setTimeout(() => { try { w.close(); } catch(e){} }, 30);
        return w || _fakeWindow();
      }
      console.warn('[AFlix AdBlock] Blocked window.open():', url);
      return _fakeWindow();
    } catch(e) { return _fakeWindow(); }
  };

  /* ── 2. TOP-FRAME NAVIGATION GUARD ────────────────────────── */

  function _safeNav(url) {
    try {
      const u = new URL(String(url), window.location.href);
      if (u.origin !== window.location.origin) {
        console.warn('[AFlix AdBlock] Blocked nav to:', url); return;
      }
      window.location.href = url;
    } catch(e) {}
  }

  if (window === window.top) {
    try {
      ['assign', 'replace'].forEach(fn => {
        const orig = window.location[fn].bind(window.location);
        try {
          Object.defineProperty(window.location, fn, {
            value(url) { _safeNav(url); }, configurable: true, writable: true
          });
        } catch(e) {}
      });
    } catch(e) {}
  }

  /* ── 3. ANCHOR CLICK INTERCEPT ─────────────────────────────── */

  document.addEventListener('click', function(e) {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    if (href.startsWith('javascript:')) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    try {
      const u = new URL(href, window.location.href);
      const safe = isSafeOrigin(href) || u.origin === window.location.origin;
      if (!safe && (a.target === '_blank' || a.target === '_top' || a.target === '_parent')) {
        e.preventDefault(); e.stopImmediatePropagation();
        console.warn('[AFlix AdBlock] Blocked outbound link:', href);
        return;
      }
      if (isAdUrl(href)) {
        e.preventDefault(); e.stopImmediatePropagation();
        console.warn('[AFlix AdBlock] Blocked ad link:', href);
      }
    } catch(e) {}
  }, true);

  /* ── 4. BEFOREUNLOAD REDIRECT GUARD ───────────────────────── */

  window.addEventListener('beforeunload', function(e) {
    const modal = document.getElementById('playerModal');
    if (modal && modal.classList.contains('open')) {
      e.preventDefault(); e.returnValue = ''; return '';
    }
  });

  /* ── 5. MUTATION OBSERVER ──────────────────────────────────── */

  const OUR_IDS = new Set([
    'playerModal','detailModal','settingsModal','wlPanel',
    'iptvModal','toastWrap','playerStage','playerFrame','pLoading','pInfo'
  ]);

  function isFullscreenOverlay(el) {
    try {
      const st = window.getComputedStyle(el);
      const zi = parseInt(st.zIndex, 10) || 0;
      const w  = parseFloat(st.width)  || 0;
      const h  = parseFloat(st.height) || 0;
      return (st.position === 'fixed' || st.position === 'absolute') &&
             zi > 9000 &&
             w  > window.innerWidth  * 0.6 &&
             h  > window.innerHeight * 0.6 &&
             !OUR_IDS.has(el.id);
    } catch(e) { return false; }
  }

  function scrubNode(node) {
    if (!node || node.nodeType !== 1) return;
    const tag  = node.tagName;
    const href = node.href || node.src || node.getAttribute('href') || node.getAttribute('src') || '';

    if ((tag === 'A' || tag === 'SCRIPT' || tag === 'IFRAME') && isAdUrl(href)) {
      node.remove();
      console.warn('[AFlix AdBlock] Removed ad node:', tag, href);
      return;
    }

    if (tag === 'DIV' || tag === 'SECTION' || tag === 'SPAN' || tag === 'ASIDE') {
      setTimeout(() => {
        if (node.parentNode && isFullscreenOverlay(node)) {
          node.remove();
          console.warn('[AFlix AdBlock] Removed overlay:', tag, node.id || node.className);
        }
      }, 120);
    }

    if (node.querySelectorAll) {
      node.querySelectorAll('a[href], script[src], iframe[src]').forEach(child => {
        const src = child.href || child.src || '';
        if (isAdUrl(src)) {
          child.addEventListener('click', ev => { ev.preventDefault(); ev.stopImmediatePropagation(); }, true);
          child.removeAttribute('href'); child.removeAttribute('src');
          child.style.pointerEvents = 'none';
        }
      });
    }
  }

  const _observer = new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) scrubNode(n);
  });

  function startObserver() {
    _observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', startObserver)
    : startObserver();

  /* ── 6. IFRAME HARDENING — aflixHardenIframe() ─────────────── */
  // NO sandbox — any token is detected by embed servers.
  // Ad blocking is done by JS layers above + sw.js network blocking.

  window.aflixHardenIframe = function(iframe) {
    if (!iframe) return;
    iframe.removeAttribute('sandbox');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('allow', [
      'autoplay', 'fullscreen *', 'picture-in-picture',
      'encrypted-media', 'gyroscope', 'accelerometer', 'clipboard-write'
    ].join('; '));
  };

  /* ── 7. postMessage FIREWALL ───────────────────────────────── */

  const PLAYER_EVENTS = new Set([
    'ended','complete','finished','nextepisode','next_episode',
    'timeupdate','progress','play','pause','ready','loaded',
    'qualitychange','quality_change','subtitlechange','fullscreen',
    'playerready','player_ready','duration','buffering','error',
    'seeked','seeking','volumechange','ratechange','cuechange'
  ]);

  window.addEventListener('message', function(e) {
    if (e.origin === window.location.origin) return;
    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
    catch(err) { return; }
    if (!data || typeof data !== 'object') return;

    const evType = (data.type || data.event || data.action || '').toLowerCase();
    if (PLAYER_EVENTS.has(evType)) return;

    const str    = JSON.stringify(data).toLowerCase();
    const hasAd  = AD_HOSTS.some(h => str.includes(h));
    const hasUrl = Object.values(data).some(v =>
      typeof v === 'string' && v.startsWith('http') && !isSafeOrigin(v));
    const hasNav = ['redirect','navigate','popup','newwindow','newtab'].some(k => str.includes(k));

    if (hasAd || (hasUrl && hasNav)) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage:', e.origin, evType || str.slice(0, 80));
    }
  }, true);

  /* ── 8. CONTINUOUS OVERLAY SCANNER ────────────────────────── */
  // Polls every 800ms — catches ad overlays that inject after a delay
  // or toggle visibility rather than inserting new DOM nodes.

  function scanOverlays() {
    document.querySelectorAll('body > *').forEach(el => {
      if (!OUR_IDS.has(el.id) && isFullscreenOverlay(el)) {
        el.remove();
        console.warn('[AFlix AdBlock] Scanner removed overlay:', el.tagName, el.id || el.className);
      }
    });
    document.querySelectorAll('body > a[href]').forEach(a => {
      if (isAdUrl(a.href)) { a.remove(); console.warn('[AFlix AdBlock] Scanner removed ad link:', a.href); }
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', () => setInterval(scanOverlays, 800))
    : setInterval(scanOverlays, 800);

  console.log('[AFlix AdBlock] ✓ Active — 8-layer pure-JS ad & popup protection enabled');

})();
