/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js  (v2 — hardened)
   ──────────────────────────────────────────────────────────────
   Blocks popup ads, redirects, and unsafe content from embed
   servers without breaking playback.

   HOW IT WORKS (6-layer defence):
   1. window.open() override         — kills new-tab/popup attempts
   2. document.onclick/mousedown nuke — embed sites bind click on
                                        the whole document to fire
                                        window.open on any click;
                                        we poll and null them out
   3. Invisible overlay trap          — transparent div over the
                                        iframe catches every click
                                        before the iframe does,
                                        consuming the user-gesture
                                        so the iframe can't use it
                                        to open a new tab
   4. visibilitychange / blur guard   — sites use these to detect
                                        when focus left the page
                                        and fire popunders; we
                                        intercept and suppress
   5. beforeunload / popstate guard   — prevents top-frame hijack
   6. MutationObserver               — removes injected <a> and
                                        overlay <div>s that
                                        auto-click to open ads

   DYNAMIC SERVER WHITELIST:
   index.html sets  window.aflixServers = [array of server URL
   strings from the loaded config] before this script runs.
   If that global is absent we fall back to a built-in list.
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── ADBLOCK KILL-SWITCH ────────────────────────────────────
     If the user has toggled adblock OFF in Settings, bail out.
  ──────────────────────────────────────────────────────────── */
  try {
    if (localStorage.getItem('aflix_adblock_off') === '1') {
      console.warn('[AFlix AdBlock] ⚠ Disabled by user — ads may appear.');
      return;
    }
  } catch(e) {}

  /* ── DYNAMIC SAFE_ORIGINS ──────────────────────────────────
     Built from window.aflixServers + a permanent fallback set.
  ──────────────────────────────────────────────────────────── */
  const PERMANENT_SAFE = [
    'themoviedb.org',
    'image.tmdb.org',
    'youtube.com',
    'youtu.be',
    window.location.hostname
  ];

  function buildSafeOrigins() {
    const origins = new Set(PERMANENT_SAFE);
    const serverUrls = window.aflixServers || [];
    for (const raw of serverUrls) {
      try {
        const url = raw.startsWith('http') ? raw : 'https://' + raw;
        origins.add(new URL(url).hostname.toLowerCase());
      } catch(e) {}
    }
    return [...origins];
  }

  let _safeOrigins = null;
  function getSafeOrigins() {
    if (!_safeOrigins) _safeOrigins = buildSafeOrigins();
    return _safeOrigins;
  }

  window.aflixRefreshSafeOrigins = function() { _safeOrigins = null; };

  function isSafeOrigin(hostname) {
    const h = (hostname || '').toLowerCase();
    return getSafeOrigins().some(o => h === o || h.endsWith('.' + o));
  }

  /* ─────────────────────────────────────────────────────────────
     LAYER 1 — Block window.open()
     Embed sites call window.open() directly on click. Return a
     fake window object so any chained .focus() etc. don't throw.
  ──────────────────────────────────────────────────────────── */
  const _noop = () => ({
    closed: true, focus: () => {}, blur: () => {},
    close: () => {}, postMessage: () => {},
    document: { write: () => {}, writeln: () => {}, close: () => {} }
  });
  window.open = _noop;

  /* ─────────────────────────────────────────────────────────────
     LAYER 2 — Nuke document.onclick / document.onmousedown
     The most common trick: embed player injects a click handler
     on THE WHOLE DOCUMENT (not inside the iframe) that fires
     window.open() on the very next user click. We poll every
     200 ms for up to 60 s and null any such handler out.
     We also use a MutationObserver to catch inline onevent
     attributes being added to <body> / <html>.
  ──────────────────────────────────────────────────────────── */
  let _docClickPollCount = 0;
  const _docClickInterval = setInterval(function() {
    if (typeof document.onclick === 'function') {
      console.warn('[AFlix AdBlock] Killed document.onclick popup trap');
      document.onclick = null;
    }
    if (typeof document.onmousedown === 'function') {
      console.warn('[AFlix AdBlock] Killed document.onmousedown popup trap');
      document.onmousedown = null;
    }
    if (typeof document.body?.onclick === 'function') {
      console.warn('[AFlix AdBlock] Killed body.onclick popup trap');
      document.body.onclick = null;
    }
    if (typeof document.body?.onmousedown === 'function') {
      console.warn('[AFlix AdBlock] Killed body.onmousedown popup trap');
      document.body.onmousedown = null;
    }
    if (++_docClickPollCount >= 300) clearInterval(_docClickInterval); // 60 s
  }, 200);

  /* ─────────────────────────────────────────────────────────────
     LAYER 3 — Invisible click-absorbing overlay over the iframe
     Embed sites can only call window.open() during a genuine
     user-gesture (browser requirement). They piggyback on your
     click inside the iframe. We place a transparent <div> on top
     of the iframe that intercepts mousedown FIRST (capture phase),
     then immediately re-dispatches a synthetic click to the iframe
     so playback controls still work — but the original user-gesture
     is consumed, so the iframe's window.open() call is blocked.

     This overlay is created/destroyed by index.html calling:
       window.aflixOverlay.attach(iframeEl)
       window.aflixOverlay.detach()
  ──────────────────────────────────────────────────────────── */
  (function setupOverlay() {
    let overlay = null;
    let targetIframe = null;

    function createOverlay() {
      const el = document.createElement('div');
      el.id = 'aflix-click-shield';
      el.style.cssText = [
        'position:absolute',
        'inset:0',
        'z-index:2147483646',  // max z-index - 1
        'cursor:pointer',
        'background:transparent',
        '-webkit-tap-highlight-color:transparent',
      ].join(';');

      // Absorb the raw mousedown (consumes user gesture at capture phase)
      el.addEventListener('mousedown', function(e) {
        e.stopImmediatePropagation();
        // Don't preventDefault — we still want click to reach controls
      }, true);

      // On click, forward to the underlying iframe position so controls work
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        if (targetIframe) {
          // Temporarily hide the shield so the real click hits the iframe
          el.style.pointerEvents = 'none';
          const underneath = document.elementFromPoint(e.clientX, e.clientY);
          if (underneath) {
            underneath.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true,
              clientX: e.clientX, clientY: e.clientY
            }));
          }
          setTimeout(() => { el.style.pointerEvents = ''; }, 50);
        }
      }, false);

      return el;
    }

    function attach(iframeEl) {
      detach();
      if (!iframeEl || !iframeEl.parentElement) return;
      overlay = createOverlay();
      targetIframe = iframeEl;
      // The iframe's parent must be position:relative for absolute overlay to work
      const parent = iframeEl.parentElement;
      const pos = window.getComputedStyle(parent).position;
      if (pos === 'static') parent.style.position = 'relative';
      parent.appendChild(overlay);
    }

    function detach() {
      if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
      overlay = null;
      targetIframe = null;
    }

    window.aflixOverlay = { attach, detach };
  })();

  /* ─────────────────────────────────────────────────────────────
     LAYER 4 — Block visibilitychange / blur popunder tricks
     Sites listen for document becoming hidden (user switches tab)
     and fire window.open() at that moment (popunder). We override
     addEventListener to intercept visibilitychange and blur on
     the document/window coming from cross-origin contexts.

     We can't block it inside the iframe (cross-origin), but we
     CAN block any postMessage that tries to tell the parent to
     open a URL, and we block top-level visibilitychange handlers
     that weren't registered by AFlix itself.
  ──────────────────────────────────────────────────────────── */
  const _aflix_legit_visibility_listeners = new WeakSet();

  // Mark our own listeners as legit
  window.aflixMarkLegit = function(fn) {
    try { _aflix_legit_visibility_listeners.add(fn); } catch(e) {}
    return fn;
  };

  // Intercept addEventListener on document to watch for visibilitychange abuse
  const _origDocAdd = document.addEventListener.bind(document);
  document.addEventListener = function(type, fn, opts) {
    if ((type === 'visibilitychange' || type === 'blur') &&
        typeof fn === 'function' &&
        !_aflix_legit_visibility_listeners.has(fn)) {
      // Wrap it — if it tries to window.open(), noop
      const wrapped = function(e) {
        const prevOpen = window.open;
        window.open = _noop;
        try { fn.call(this, e); } finally { window.open = _noop; }
      };
      return _origDocAdd(type, wrapped, opts);
    }
    return _origDocAdd(type, fn, opts);
  };

  /* ─────────────────────────────────────────────────────────────
     LAYER 5 — Block beforeunload / popstate top-frame hijacks
  ──────────────────────────────────────────────────────────── */
  window.addEventListener('beforeunload', function(e) {
    const modal = document.getElementById('playerModal');
    if (modal && modal.classList.contains('open')) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  /* ─────────────────────────────────────────────────────────────
     LAYER 6 — MutationObserver: remove injected ad nodes
  ──────────────────────────────────────────────────────────── */
  const AD_HOSTS = [
    'doubleclick', 'googlesyndication', 'adservice', 'popads',
    'popcash', 'exoclick', 'trafficjunky', 'juicyads', 'hilltopads',
    'adnxs', 'rubiconproject', 'openx', 'pubmatic', 'criteo',
    'smartadserver', 'advertising', 'clickadu', 'adcash',
    'propellerads', 'adsterra', 'yllix', 'clkrev', 'onclick',
    'popunder', 'go2jump', 'adult', 'xxx', 'porn', 'sex',
    'nude', 'naked', 'erotic', 'onlyfans', 'chaturbate',
    'livejasmin', 'cams.com'
  ];

  function isAdUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, window.location.href);
      if (isSafeOrigin(u.hostname)) return false;
      const full = (u.hostname + u.pathname).toLowerCase();
      return AD_HOSTS.some(h => full.includes(h));
    } catch(e) {
      return AD_HOSTS.some(h => String(url).toLowerCase().includes(h));
    }
  }

  function isFullscreenOverlay(el) {
    try {
      const st = window.getComputedStyle(el);
      const zi  = parseInt(st.zIndex, 10);
      const w   = parseInt(st.width, 10);
      const h   = parseInt(st.height, 10);
      return (
        (st.position === 'fixed' || st.position === 'absolute') &&
        zi > 9000 &&
        w  > window.innerWidth  * 0.7 &&
        h  > window.innerHeight * 0.7
      );
    } catch(e) { return false; }
  }

  const OUR_IDS = new Set([
    'playerModal','detailModal','settingsModal',
    'wlPanel','iptvModal','toastWrap','aflix-click-shield'
  ]);

  const observer = new MutationObserver(function(mutations) {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;

        if (node.tagName === 'A') {
          const href = node.href || node.getAttribute('href') || '';
          if (isAdUrl(href)) {
            node.remove();
            console.warn('[AFlix AdBlock] Removed ad link:', href);
            continue;
          }
        }

        if (node.tagName === 'SCRIPT') {
          const src = node.src || '';
          if (isAdUrl(src)) {
            node.remove();
            console.warn('[AFlix AdBlock] Removed ad script:', src);
            continue;
          }
        }

        if (node.tagName === 'DIV' || node.tagName === 'SECTION' || node.tagName === 'SPAN') {
          setTimeout(() => {
            if (node.parentNode && isFullscreenOverlay(node) && !OUR_IDS.has(node.id || '')) {
              node.remove();
              console.warn('[AFlix AdBlock] Removed overlay element:', node.tagName, node.id);
            }
          }, 100);
        }

        const adLinks = node.querySelectorAll && node.querySelectorAll('a[href]');
        if (adLinks) {
          adLinks.forEach(a => {
            if (isAdUrl(a.href)) {
              a.addEventListener('click', ev => { ev.preventDefault(); ev.stopImmediatePropagation(); }, true);
              a.removeAttribute('href');
              a.style.pointerEvents = 'none';
            }
          });
        }
      }
    }
  });

  function startObserver() {
    observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });
  }
  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);

  /* ─────────────────────────────────────────────────────────────
     LAYER 7 — postMessage firewall
     Only block messages carrying actual external ad HTTP URLs.
  ──────────────────────────────────────────────────────────── */
  window.addEventListener('message', function(e) {
    if (e.origin === window.location.origin) return;
    try {
      if (isSafeOrigin(new URL(e.origin).hostname)) return;
    } catch(err) {}

    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
    catch(err) { return; }
    if (!data || typeof data !== 'object') return;

    const hasAdUrl = Object.values(data).some(v => {
      if (typeof v !== 'string' || !v.startsWith('http')) return false;
      try {
        const u = new URL(v);
        return !isSafeOrigin(u.hostname) && AD_HOSTS.some(h => u.hostname.includes(h));
      } catch(e) { return false; }
    });

    if (hasAdUrl) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage from:', e.origin, data);
    }
  }, true);

  /* ─────────────────────────────────────────────────────────────
     LAYER 8 — Intercept <a target="_blank"> clicks
  ──────────────────────────────────────────────────────────── */
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    if (href.startsWith('javascript:')) { e.preventDefault(); return; }
    try {
      const u = new URL(href, window.location.href);
      if (!isSafeOrigin(u.hostname) &&
          (a.target === '_blank' || a.target === '_top' || a.target === '_parent')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        console.warn('[AFlix AdBlock] Blocked outbound link:', href);
      }
    } catch(e) {}
  }, true);

  console.log('[AFlix AdBlock] ✓ Active (v2 hardened) — 8-layer popup protection enabled');

})();
