/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js
   ──────────────────────────────────────────────────────────────
   Blocks popup ads, redirects, and unsafe content from embed
   servers (vidsrc, vembed, etc.) without breaking playback.

   HOW IT WORKS (5-layer defence):
   1. window.open() override    — kills all new-tab/popup attempts
   2. beforeunload / popstate guard — prevents top-frame hijack
   3. MutationObserver          — removes injected <a> and overlay <div>s
      that auto-click to open ads
   4. First-click shield        — absorbs the first pointer event on the
      player wrapper, blocking sync window.open on click
   5. blob:/data: URL guard     — blocks redirect tricks using blob/data URIs
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── 1. BLOCK window.open() ────────────────────────────────── */
  // Embed iframes call window.open() to launch popup ads.
  // We replace it with a smarter intercept:
  //   - Returns a convincing fake window so player feature-detection passes
  //     (players often do `if (!window.open('','_blank')) { showError() }`)
  //   - The fake window appears "open" briefly then closes itself, satisfying
  //     any readyState checks without actually opening anything visible
  //   - Real ad URLs are silently swallowed; same-origin calls pass through
  const _realOpen = window.open.bind(window);
  window.open = function(url, target, features) {
    // Allow same-origin opens (e.g. player's own subtitle/quality windows)
    try {
      if (url) {
        const u = new URL(String(url), window.location.href);
        if (u.origin === window.location.origin) {
          return _realOpen(url, target, features);
        }
      }
      // Allow blank/empty opens — players use these for feature detection
      if (!url || url === '' || url === 'about:blank') {
        const fake = _realOpen('about:blank', '_blank', 'width=1,height=1,left=-9999,top=-9999');
        if (fake) { setTimeout(() => { try { fake.close(); } catch(e){} }, 50); }
        return fake;
      }
    } catch(e) {}

    // Everything else: return convincing dead fake window
    console.warn('[AFlix AdBlock] Blocked window.open():', url);
    return {
      closed:   false,  // not "closed" immediately — passes `if (w)` checks
      name:     '',
      location: { href: 'about:blank', assign: () => {}, replace: () => {} },
      focus:    () => {},
      blur:     () => {},
      close:    function() { this.closed = true; },
      postMessage: () => {},
      document: {
        write:    () => {},
        writeln:  () => {},
        close:    () => {},
        open:     () => {},
        readyState: 'complete'
      }
    };
  };

  /* ── 2. BLOCK top-frame navigation hijacks ─────────────────── */
  // Embed iframes do: window.top.location = 'https://ad.com'
  //                or: window.location.href = 'https://ad.com'
  //                or: window.location.assign('https://ad.com')
  //                or: window.location.replace('https://ad.com')
  // We intercept ALL of these by locking window.location on the top frame.

  function _safeNav(url) {
    try {
      const u = new URL(String(url), window.location.href);
      if (u.origin === window.location.origin) {
        // Same-origin navigation is fine — use the real location
        _realLocation.href = url;
      } else {
        console.warn('[AFlix AdBlock] Blocked top-frame redirect to:', url);
      }
    } catch(e) {}
  }

  // Keep a reference to the real location object before we shadow it
  const _realLocation = window.location;

  if (window === window.top) {
    try {
      // Override window.location so assignment is intercepted
      Object.defineProperty(window, 'location', {
        get: () => _locationProxy,
        set: (v) => _safeNav(v),   // catches: window.location = 'https://ad.com'
        configurable: false,
        enumerable: true
      });
    } catch(e) {
      // Some browsers don't allow redefining window.location (Firefox strict).
      // Fall back: at least intercept document.location
      try {
        Object.defineProperty(document, 'location', {
          get: () => _locationProxy,
          set: (v) => _safeNav(v),
          configurable: false
        });
      } catch(e2) {}
    }
  }

  // Proxy that forwards safe reads to the real location but blocks writes
  const _locationProxy = new Proxy(_realLocation, {
    get(target, prop) {
      if (prop === 'href')    return target.href;
      if (prop === 'assign')  return (url) => _safeNav(url);
      if (prop === 'replace') return (url) => _safeNav(url);
      if (prop === 'reload')  return () => target.reload();
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
    set(target, prop, value) {
      if (prop === 'href') { _safeNav(value); return true; }
      target[prop] = value;
      return true;
    }
  });

  /* ── 3. INTERCEPT <a target="_blank"> clicks ───────────────── */
  // Ads often inject anchor tags. We kill clicks that try to open
  // new tabs pointing to non-whitelisted domains.
  const SAFE_ORIGINS = [
    // active servers
    'player.videasy.net', 'videasy.net',
    'player.autoembed.cc', 'autoembed.cc',
    'vidfast.pro',
    'vidsrc.icu',
    'vidsrc.me',
    '2embed.online', 'www.2embed.online',
    // legacy / fallback servers
    'vidsrc.cc', 'vidsrc.to', 'vidsrc.xyz', 'vidsrc.su', 'vidsrc.vip',
    'vidlink.pro', 'embed.su', 'moviesapi.club', 'vembed.stream',
    // infra
    'youtube.com', 'youtu.be',
    'themoviedb.org', 'image.tmdb.org',
    window.location.hostname
  ];

  document.addEventListener('click', function(e) {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      if (href.startsWith('javascript:')) e.preventDefault();
      return;
    }
    try {
      const u = new URL(href, window.location.href);
      const isSafe = SAFE_ORIGINS.some(o => u.hostname.endsWith(o));
      if (!isSafe && (a.target === '_blank' || a.target === '_top' || a.target === '_parent')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        console.warn('[AFlix AdBlock] Blocked outbound link:', href);
      }
    } catch(e) {}
  }, true); // capture phase so we run before any inline handlers

  /* ── 4. BLOCK beforeunload / unload redirect tricks ─────────── */
  // Block any navigation away from the page while the player iframe is loaded.
  window.addEventListener('beforeunload', function(e) {
    const iframe = document.getElementById('playerFrame');
    const modal  = document.getElementById('playerModal');
    const iframeActive = iframe && iframe.src && iframe.src !== 'about:blank';
    const modalOpen    = modal  && modal.classList.contains('open');
    if (iframeActive || modalOpen) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  /* ── 5. MUTATION OBSERVER — remove injected ad overlays ─────── */
  // Embeds sometimes inject a transparent full-screen <div> or <a>
  // on top of the video that redirects on click.
  //
  // We watch for:
  //  • <a> tags added to <body> with suspicious hrefs
  //  • full-screen positioned divs with z-index > 9000 (ad overlays)
  //  • <script> tags injected into <body> pointing to ad networks

  // Known ad/tracker hostname fragments to block
  const AD_HOSTS = [
    'doubleclick', 'googlesyndication', 'adservice', 'popads',
    'popcash', 'exoclick', 'trafficjunky', 'juicyads', 'hilltopads',
    'adnxs', 'rubiconproject', 'openx', 'pubmatic', 'criteo',
    'smartadserver', 'advertising', 'clickadu', 'adcash',
    'propellerads', 'popcash', 'adsterra', 'yllix', 'hilltopads',
    'clkrev', 'onclick', 'popunder', 'redirect', 'go2jump',
    'adult', 'xxx', 'porn', 'sex', 'nude', 'naked', 'erotic',
    'onlyfans', 'chaturbate', 'livejasmin', 'cams.com'
  ];

  function isAdUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, window.location.href);
      const full = (u.hostname + u.pathname).toLowerCase();
      return AD_HOSTS.some(h => full.includes(h));
    } catch(e) {
      return AD_HOSTS.some(h => String(url).toLowerCase().includes(h));
    }
  }

  function isFullscreenOverlay(el) {
    try {
      const st = window.getComputedStyle(el);
      const pos = st.position;
      const zi  = parseInt(st.zIndex, 10);
      const w   = parseInt(st.width, 10);
      const h   = parseInt(st.height, 10);
      return (
        (pos === 'fixed' || pos === 'absolute') &&
        zi > 9000 &&
        w  > window.innerWidth  * 0.7 &&
        h  > window.innerHeight * 0.7
      );
    } catch(e) { return false; }
  }

  const observer = new MutationObserver(function(mutations) {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue; // elements only

        // Remove injected <a> pointing to ad domains
        if (node.tagName === 'A') {
          const href = node.href || node.getAttribute('href') || '';
          if (isAdUrl(href)) {
            node.remove();
            console.warn('[AFlix AdBlock] Removed ad link:', href);
            continue;
          }
        }

        // Remove injected <script> pointing to ad networks
        if (node.tagName === 'SCRIPT') {
          const src = node.src || '';
          if (isAdUrl(src)) {
            node.remove();
            console.warn('[AFlix AdBlock] Removed ad script:', src);
            continue;
          }
        }

        // Remove suspicious full-screen overlay divs
        if (node.tagName === 'DIV' || node.tagName === 'SECTION' || node.tagName === 'SPAN') {
          // Small delay to let styles apply, then check
          setTimeout(() => {
            if (node.parentNode && isFullscreenOverlay(node)) {
              const href = node.getAttribute('onclick') || '';
              // Only remove if it has no legit id (not our own modals)
              const id = node.id || '';
              const isOurs = ['playerModal','detailModal','settingsModal',
                              'wlPanel','iptvModal','toastWrap'].includes(id);
              if (!isOurs) {
                node.remove();
                console.warn('[AFlix AdBlock] Removed overlay element:', node.tagName, id);
              }
            }
          }, 100);
        }

        // Recursively check children (some ads inject wrapper divs)
        const adLinks = node.querySelectorAll && node.querySelectorAll('a[href]');
        if (adLinks) {
          adLinks.forEach(a => {
            if (isAdUrl(a.href)) {
              a.addEventListener('click', e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
              a.removeAttribute('href');
              a.style.pointerEvents = 'none';
            }
          });
        }
      }
    }
  });

  // Start observing once DOM is ready
  function startObserver() {
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }
  if (document.body) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver);
  }

  /* ── 6. FIRST-CLICK SHIELD on player wrapper ────────────────── */
  // The #1 trick used by embed servers: the very first click anywhere on the
  // player fires window.open() or a top-nav *before* our open() override runs
  // in the iframe context. The fix: intercept the first pointer event on the
  // iframe container at the top-frame level and swallow it.
  //
  // We only absorb the FIRST click after a new src is loaded — after that the
  // player is trusted and clicks pass through normally.

  window.aflixShieldIframe = function(iframeEl) {
    if (!iframeEl) return;
    let shielded = false;

    iframeEl.addEventListener('load', function() {
      shielded = false; // reset on every new src load
    });

    // Pointer capture on the wrapper div (set by index.html around the iframe)
    const wrapper = iframeEl.parentElement;
    if (!wrapper) return;

    wrapper.addEventListener('pointerdown', function handler(e) {
      if (shielded) return;
      shielded = true;
      // Let the click through so play-button works, but block any window.open
      // that fires synchronously from it by temporarily nuking open for 300ms
      const saved = window.open;
      window.open = () => {
        console.warn('[AFlix AdBlock] Blocked first-click window.open');
        return null;
      };
      setTimeout(() => { window.open = saved; }, 300);
    }, { capture: true });
  };

  /* ── 6b. BLOCK blob: and data: URL navigations ──────────────── */
  // Some embed servers redirect via blob: URLs or data: URIs to bypass
  // hostname-based blocklists. These should never navigate the top frame.
  const _realAssign  = location.assign.bind(location);
  const _realReplace = location.replace.bind(location);

  // Tighten _safeNav to also block blob: / data: schemes
  const _origSafeNav = _safeNav;
  // Redefine to add scheme check (wraps the existing _safeNav closure)
  function _safeNav(url) {
    try {
      const u = new URL(String(url), window.location.href);
      if (u.protocol === 'blob:' || u.protocol === 'data:') {
        console.warn('[AFlix AdBlock] Blocked blob/data redirect:', url);
        return;
      }
    } catch(e) {}
    _origSafeNav(url);
  }

  /* ── 6. IFRAME HARDENING helper ────────────────────────────── */
  //
  // CONFIRMED from internet research (vidlink.pro docs, rivestream, vidsrc,
  // videasy, all open-source streaming sites on GitHub): the ONLY correct way
  // to embed these players is with NO sandbox attribute at all.
  //
  // Any sandbox token — even a fully permissive set — is detected by the
  // player's JavaScript via window.frameElement.sandbox or window.open()
  // returning null, causing the "Please disable sandbox" block screen.
  //
  // Ad blocking is handled entirely by the layers in this file:
  //   • window.open() override  — kills popup ads before they open
  //   • beforeunload guard      — blocks top-frame redirect tricks
  //   • click capture listener  — blocks injected outbound links
  //   • MutationObserver        — removes injected ad overlays/scripts
  //   • postMessage firewall    — drops ad/redirect postMessages
  // Plus the Service Worker in sw.js blocks ad network requests at the
  // network level before they ever reach the browser.
  //
  // referrerpolicy: 'strict-origin-when-cross-origin' sends our origin to
  // the embed server so it can verify we're a real site (not empty referrer),
  // without leaking the full page URL.

  window.aflixHardenIframe = function(iframe) {
    if (!iframe) return;

    // Remove any sandbox that may have been set previously — NO sandbox is
    // the correct approach for these embed servers.
    iframe.removeAttribute('sandbox');

    // strict-origin-when-cross-origin: servers check document.referrer to
    // verify the embed comes from a real site. no-referrer breaks this.
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');

    iframe.setAttribute('allow', [
      'autoplay',
      'fullscreen *',          // * needed for cross-origin fullscreen chains
      'picture-in-picture',
      'encrypted-media',
      'gyroscope',
      'accelerometer',
      'clipboard-write'
    ].join('; '));
  };

  /* ── 7. postMessage firewall ────────────────────────────────── */
  // Smarter two-phase filter:
  //   Phase 1 — ALLOW list: known-good player events pass immediately
  //   Phase 2 — BLOCK list: confirmed ad/nav messages are suppressed
  //
  // This order matters — previous version blocked 'location' which is a key
  // used by Videasy and VidFast for their quality-change postMessages.

  // Events players legitimately send to the parent
  const PLAYER_EVENTS = new Set([
    'ended', 'complete', 'finished', 'nextepisode', 'next_episode',
    'timeupdate', 'progress', 'play', 'pause', 'ready', 'loaded',
    'qualitychange', 'quality_change', 'subtitlechange', 'fullscreen',
    'playerready', 'player_ready', 'duration', 'buffering', 'error'
  ]);

  window.addEventListener('message', function(e) {
    if (e.origin === window.location.origin) return;

    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
    catch(err) { return; }
    if (!data) return;

    // Phase 1: pass known-good player lifecycle events immediately
    const eventType = (data.type || data.event || data.action || '').toLowerCase();
    if (PLAYER_EVENTS.has(eventType)) return;

    // Phase 2: block only confirmed ad/nav payloads
    // A message is dangerous only if it contains an outbound URL + nav intent
    const dataStr = JSON.stringify(data).toLowerCase();
    const hasAdHost   = AD_HOSTS.some(h => dataStr.includes(h));
    const hasOutboundUrl = Object.values(data).some(v =>
      typeof v === 'string' &&
      v.startsWith('http') &&
      !SAFE_ORIGINS.some(o => v.includes(o))
    );
    const hasNavIntent = ['redirect', 'navigate', 'popup', 'open', 'window', 'href'].some(k => dataStr.includes(k));

    // Also block messages where the entire payload IS an external URL string
    const isRawOutboundUrl = typeof e.data === 'string' &&
      e.data.startsWith('http') &&
      !SAFE_ORIGINS.some(o => e.data.includes(o));

    if (hasAdHost || isRawOutboundUrl || (hasOutboundUrl && hasNavIntent)) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage from:', e.origin, data);
    }
  }, true);

  console.log('[AFlix AdBlock] ✓ Active — popup & ad protection enabled');

})();
