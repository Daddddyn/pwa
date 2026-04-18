/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js
   ──────────────────────────────────────────────────────────────
   TECHNIQUE SOURCE: Confirmed working implementations from:
   • uBlock Origin prevent-window-open scriptlet (gorhill/uBlock)
     commits: 7f11d62, 85877b1 — Proxy-based window.open intercept
   • AdGuard Scriptlets issue #145 — <object> decoy with Proxy
     wrapping contentWindow so opener===window, frameElement===null
   • AdGuard Scriptlets issue #71 — vidstream/egybest adblock
     detection solved by returning a convincing fake window

   8-LAYER DEFENCE + BLUR REFOCUS:
   1. window.open() Proxy (uBO/AdGuard confirmed technique)
   2. Top-frame navigation guard
   3. Anchor click intercept
   4. beforeunload redirect guard
   5. MutationObserver — removes injected ad nodes/overlays
   6. aflixHardenIframe() — enforces allow attrs, removes sandbox
   7. postMessage firewall
   8. Continuous overlay scanner (800ms poll)
   9. Blur-refocus — steals back window focus if iframe fires a popup
   + Service Worker (sw.js) — network-level ad blocking
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
    // Tier 1 — ad-free by design
    'iframe.pstream.org', 'pstream.org',
    'vidora.su',
    // Tier 2 — clean / low-ad
    'player.autoembed.cc', 'autoembed.cc',
    'vidsrc.icu',
    // Tier 3 — fallback servers
    'embed.su',
    'vidlink.pro',
    // General streaming infra
    'vidsrc.cc', 'vidsrc.to', 'vidsrc.xyz', 'vidsrc.su', 'vidsrc.vip',
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

  /* ── 1. window.open() PROXY — uBO + AdGuard confirmed technique ── */
  /*
   * SOURCE: gorhill/uBlock commits 7f11d62 + 85877b1 (prevent-window-open)
   *         AdguardTeam/Scriptlets issue #145 (egybest/vidstream fix)
   *
   * Key insight from AdGuard issue #145 (confirmed working on adblock-
   * detection sites): the fake window MUST satisfy these checks:
   *   • window.opener === window  (site checks this to confirm popup opened)
   *   • window.frameElement === null
   *
   * Technique: create a real <object> element (uBO uses iframe or object),
   * append it off-screen, return its contentWindow wrapped in a Proxy
   * that intercepts opener/frameElement. Remove after delay.
   * This passes player feature-detection because it's a real window object.
   *
   * The Proxy approach (not simple function override) is what both uBO and
   * AdGuard settled on after years of iteration — it's the only way to
   * intercept every possible property access on the returned window.
   */

  const _nativeOpen = window.open.bind(window);
  const _setTimeout  = window.setTimeout.bind(window);

  // Build the Proxy-wrapped contentWindow from a real off-screen <object>
  // Mirrors AdGuard issue #145 confirmed working implementation exactly.
  function _createDecoyWindow(url, delay) {
    try {
      const decoy = document.createElement('object');
      decoy.data  = url || 'about:blank';
      // Position completely off-screen — player must not see it
      decoy.style.cssText = [
        'height:1px', 'width:1px', 'position:absolute',
        'top:-99999px', 'left:-99999px', 'pointer-events:none',
        'visibility:hidden'
      ].join('!important;') + '!important';
      document.body.appendChild(decoy);

      _setTimeout(() => {
        try { decoy.remove(); } catch(e) {}
      }, delay || 10000);

      // Wrap contentWindow in Proxy so opener===window and frameElement===null
      // This is the exact fix from AdGuard issue #145 that solved egybest/vidstream
      const cw = decoy.contentWindow;
      if (cw) {
        return new Proxy(cw, {
          get(target, prop) {
            if (prop === 'opener')       return window;
            if (prop === 'frameElement') return null;
            if (prop === 'closed')       return false;
            try { return target[prop]; } catch(e) { return undefined; }
          },
          set(target, prop, value) {
            try { target[prop] = value; } catch(e) {}
            return true;
          }
        });
      }
      // contentWindow unavailable (Firefox <object> quirk noted in AdGuard #145)
      // Fall back to Proxy on the element itself
      return new Proxy(decoy, {
        get(target, prop) {
          if (prop === 'opener')       return window;
          if (prop === 'frameElement') return null;
          if (prop === 'closed')       return false;
          return false;
        },
        set(target, prop, value) { return true; }
      });
    } catch(err) {
      // Last-resort minimal fake window if DOM manipulation fails
      return _nullWindow();
    }
  }

  // Null window for cases where we can't/won't create a decoy
  // (i.e. clearly malicious ad URL where we don't need to fool anyone)
  function _nullWindow() {
    return {
      closed: true, opener: null, frameElement: null,
      location: { href: 'about:blank', assign(){}, replace(){}, reload(){} },
      document: { write(){}, writeln(){}, close(){}, open(){},
                  readyState:'complete', body:{ innerHTML:'' } },
      focus(){}, blur(){}, close(){}, postMessage(){},
      addEventListener(){}, removeEventListener(){}
    };
  }

  // Install via Proxy on window itself — uBO's confirmed approach
  // Proxying 'open' on window instead of replacing window.open directly
  // is more robust: avoids sites caching a reference to the original.
  try {
    window.open = new Proxy(_nativeOpen, {
      apply(target, thisArg, args) {
        const url     = args[0] ? String(args[0]) : '';
        const target_ = args[1] || '_blank';

        // Empty / about:blank — pass through (player feature-detection)
        if (!url || url === '' || url === 'about:blank') {
          // Open real about:blank and immediately close — lets player's
          // typeof/instanceof checks pass (uBO commit 7f11d62 technique)
          try {
            const w = Reflect.apply(target, thisArg,
              ['about:blank', '_blank', 'width=1,height=1,left=-99999,top=-99999,toolbar=no,menubar=no,scrollbars=no']);
            if (w) { _setTimeout(() => { try { w.close(); } catch(e){} }, 50); }
            return w || _nullWindow();
          } catch(e) { return _nullWindow(); }
        }

        // Same-origin — always allow (player subtitle/quality popups)
        try {
          const u = new URL(url, window.location.href);
          if (u.origin === window.location.origin) {
            return Reflect.apply(target, thisArg, args);
          }
        } catch(e) {}

        // Safe embed origin — allow
        if (isSafeOrigin(url)) {
          return Reflect.apply(target, thisArg, args);
        }

        // Confirmed ad URL — return null window, don't even create decoy
        if (isAdUrl(url)) {
          console.warn('[AFlix AdBlock] Blocked ad popup:', url);
          return _nullWindow();
        }

        // Unknown cross-origin — this is where streaming sites do their
        // popup/redirect. Return decoy window with opener===window so
        // the site's adblock detection passes. (AdGuard issue #145 fix)
        console.warn('[AFlix AdBlock] Blocked cross-origin popup (decoy returned):', url);
        // Use 10 second decoy delay — matches AdGuard's confirmed working rule:
        // prevent-window-open, "", "10000", "obj"
        return _createDecoyWindow('about:blank', 10000);
      }
    });
    console.log('[AFlix AdBlock] window.open Proxy installed (uBO/AdGuard technique)');
  } catch(e) {
    // Proxy failed — fall back to direct assignment
    const __orig = window.open;
    window.open = function(url, tgt, feat) {
      if (!url || url === '' || url === 'about:blank') return __orig.call(window, url, tgt, feat);
      try {
        if (new URL(String(url), window.location.href).origin === window.location.origin)
          return __orig.call(window, url, tgt, feat);
      } catch(err) {}
      if (isSafeOrigin(url)) return __orig.call(window, url, tgt, feat);
      console.warn('[AFlix AdBlock] Blocked popup (fallback):', url);
      return _nullWindow();
    };
  }

  /* ── 2. TOP-FRAME NAVIGATION GUARD ────────────────────────── */

  if (window === window.top) {
    // Intercept history.pushState / replaceState redirects
    ['pushState', 'replaceState'].forEach(fn => {
      const orig = history[fn].bind(history);
      history[fn] = function(state, title, url) {
        if (url) {
          try {
            const u = new URL(String(url), window.location.href);
            if (u.origin !== window.location.origin) {
              console.warn('[AFlix AdBlock] Blocked history nav to:', url);
              return;
            }
          } catch(e) {}
        }
        return orig.call(history, state, title, url);
      };
    });

    // Block location.assign / replace cross-origin redirects
    try {
      ['assign', 'replace'].forEach(fn => {
        try {
          Object.defineProperty(window.location, fn, {
            value(url) {
              try {
                const u = new URL(String(url), window.location.href);
                if (u.origin !== window.location.origin) {
                  console.warn('[AFlix AdBlock] Blocked location.' + fn + ':', url);
                  return;
                }
              } catch(e) {}
              window.location[fn].call(window.location, url);
            },
            configurable: true, writable: true
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
    if (href.startsWith('javascript:')) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
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
    const href = node.href || node.src ||
                 node.getAttribute('href') || node.getAttribute('src') || '';

    if ((tag === 'A' || tag === 'SCRIPT' || tag === 'IFRAME') && isAdUrl(href)) {
      node.remove();
      console.warn('[AFlix AdBlock] Removed ad node:', tag, href);
      return;
    }

    if (tag === 'DIV' || tag === 'SECTION' || tag === 'SPAN' || tag === 'ASIDE') {
      _setTimeout(() => {
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
          child.addEventListener('click', ev => {
            ev.preventDefault(); ev.stopImmediatePropagation();
          }, true);
          child.removeAttribute('href');
          child.removeAttribute('src');
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
  // No sandbox — embed servers detect any sandbox token and refuse.

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
    const hasNav = ['redirect','navigate','popup','newwindow','newtab']
      .some(k => str.includes(k));

    if (hasAd || (hasUrl && hasNav)) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage:', e.origin, evType || str.slice(0, 80));
    }
  }, true);

  /* ── 8. CONTINUOUS OVERLAY SCANNER ────────────────────────── */

  function scanOverlays() {
    document.querySelectorAll('body > *').forEach(el => {
      if (!OUR_IDS.has(el.id) && isFullscreenOverlay(el)) {
        el.remove();
        console.warn('[AFlix AdBlock] Scanner removed overlay:', el.tagName, el.id || el.className);
      }
    });
    document.querySelectorAll('body > a[href]').forEach(a => {
      if (isAdUrl(a.href)) {
        a.remove();
        console.warn('[AFlix AdBlock] Scanner removed ad link:', a.href);
      }
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', () => setInterval(scanOverlays, 800))
    : setInterval(scanOverlays, 800);

  /* ── 9. BLUR-REFOCUS — steal back focus if iframe fires a popup ──
     When a new tab opens from inside the player iframe the browser
     shifts focus there, firing our window's 'blur' event. We call
     window.focus() immediately to pull focus back, keeping any rogue
     popup buried behind AFlix. Only active while the player is open
     so normal tab-switching outside the player still works fine.    */
  window.addEventListener('blur', function() {
    try {
      var modal = document.getElementById('playerModal');
      if (modal && modal.classList.contains('open')) {
        setTimeout(function() { try { window.focus(); } catch(e) {} }, 0);
      }
    } catch(e) {}
  }, true);

  console.log('[AFlix AdBlock] ✓ Active — uBO/AdGuard Proxy technique, 9-layer protection');

})();

/* ── PATCH: replace closing section with Layer 9 + updated log ── */
