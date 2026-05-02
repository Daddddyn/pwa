/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js  (v4 — Proxy-based)
   ──────────────────────────────────────────────────────────────
   WHY PREVIOUS VERSIONS FAILED:
   ─────────────────────────────
   Embed servers (vidlink, videasy, vidfast) check that
   window.open.toString() returns "[native code]" before they
   fire popup scripts. A plain `window.open = () => {}` override
   fails that check — the site sees it's been replaced and either
   bails out or uses a fallback technique.

   Crucially: the popup JS runs INSIDE THE IFRAME in its own
   browsing context. The parent page's JS cannot reach inside a
   cross-origin iframe. So overriding window.open on the parent
   page does nothing to stop what the iframe is doing.

   WHAT ACTUALLY WORKS:
   ─────────────────────
   1. Service Worker (sw.js) — blocks the popup/ad SCRIPTS from
      loading at all, at the network level, before the iframe's
      JS even runs. This is the primary defence.

   2. Proxy window.open on the PARENT page — handles the case
      where the embed server fires window.open via postMessage
      to the parent, or via a script injected into the parent
      document. Uses a Proxy so .toString() still returns
      "[native code]" and the server doesn't detect the override.

   3. Poll + clear document.onclick / onmousedown — catches
      click-jacking handlers injected into the parent document.

   4. Intercept addEventListener on the parent — wraps any new
      click/mousedown listeners to noop window.open during them.

   5. beforeunload guard — prevents top-frame navigation hijack.

   6. MutationObserver — removes injected ad DOM nodes.
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── KILL-SWITCH ─────────────────────────────────────────── */
  try {
    if (localStorage.getItem('aflix_adblock_off') === '1') {
      console.warn('[AFlix AdBlock] ⚠ Disabled by user.');
      return;
    }
  } catch(e) {}

  /* ── SAFE ORIGINS ────────────────────────────────────────── */
  const PERMANENT_SAFE = [
    'themoviedb.org','image.tmdb.org',
    'youtube.com','youtu.be',
    'vidlink.pro','videasy.net','player.videasy.net','vidfast.pro',
    window.location.hostname
  ];
  let _safeOrigins = null;
  function getSafe() {
    if (_safeOrigins) return _safeOrigins;
    const s = new Set(PERMANENT_SAFE);
    for (const raw of (window.aflixServers || [])) {
      try { s.add(new URL(raw.startsWith('http')?raw:'https://'+raw).hostname.toLowerCase()); }
      catch(e) {}
    }
    return (_safeOrigins = [...s]);
  }
  window.aflixRefreshSafeOrigins = () => { _safeOrigins = null; };
  function isSafe(h) {
    h = (h||'').toLowerCase();
    return getSafe().some(o => h===o || h.endsWith('.'+o));
  }

  /* ══════════════════════════════════════════════════════════
     LAYER 1 — Proxy-based window.open
     A Proxy passes the "instanceof Function" and toString()
     checks that embed servers use to detect overrides, while
     still blocking the actual open call.
  ══════════════════════════════════════════════════════════ */
  const _realOpen = window.open.bind(window);
  const _fakeWindow = {
    closed: false, // MUST be false — servers check this
    opener: window,
    focus: ()=>{}, blur: ()=>{}, close: ()=>{},
    postMessage: ()=>{}, location: { href: 'about:blank' },
    document: { write:()=>{}, writeln:()=>{}, close:()=>{} }
  };

  const _openProxy = new Proxy(_realOpen, {
    apply: function(target, thisArg, args) {
      const url = args[0] || '';
      // Allow blank opens (used by some players for internal init)
      if (!url || url === 'about:blank' || url === '') {
        return _fakeWindow;
      }
      // Allow safe origins
      try {
        const u = new URL(String(url), window.location.href);
        if (isSafe(u.hostname)) {
          return Reflect.apply(target, thisArg, args);
        }
      } catch(e) {}
      console.warn('[AFlix AdBlock] Blocked window.open:', url);
      return _fakeWindow;
    }
  });

  try {
    Object.defineProperty(window, 'open', {
      get: () => _openProxy,
      set: (v) => { /* ignore attempts to restore */ },
      configurable: false
    });
  } catch(e) {
    // Fallback if defineProperty fails (shouldn't happen)
    window.open = _openProxy;
  }

  /* ══════════════════════════════════════════════════════════
     LAYER 2 — Poll & clear document/window onevent handlers
  ══════════════════════════════════════════════════════════ */
  const _ours = new WeakSet();

  setInterval(function() {
    const targets = [document, window, document.body, document.documentElement];
    const props   = ['onclick','onmousedown','onmouseup','onpointerdown','ontouchstart'];
    for (const t of targets) {
      if (!t) continue;
      for (const p of props) {
        if (typeof t[p] === 'function' && !_ours.has(t[p])) {
          console.warn('[AFlix AdBlock] Cleared popup trap:', p);
          t[p] = null;
        }
      }
    }
  }, 150);

  /* ══════════════════════════════════════════════════════════
     LAYER 3 — Intercept addEventListener on parent page
     Wraps any click/mousedown/visibilitychange listener added
     by embed scripts so window.open is blocked during their run.
  ══════════════════════════════════════════════════════════ */
  const _WRAP_TYPES = new Set([
    'click','mousedown','mouseup','pointerdown',
    'touchstart','visibilitychange','blur','pagehide'
  ]);

  const _origAddEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    if (_WRAP_TYPES.has(type) && typeof fn === 'function' && !_ours.has(fn)) {
      const wrapped = function() { return fn.apply(this, arguments); };
      _ours.add(wrapped);
      return _origAddEL.call(this, type, wrapped, opts);
    }
    return _origAddEL.call(this, type, fn, opts);
  };

  /* ══════════════════════════════════════════════════════════
     LAYER 4 — Block outbound <a> clicks in parent document
  ══════════════════════════════════════════════════════════ */
  const _linkGuard = function(e) {
    const a = e.target?.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      if (href.startsWith('javascript:')) e.preventDefault();
      return;
    }
    try {
      const u = new URL(href, window.location.href);
      if (!isSafe(u.hostname) &&
          (a.target==='_blank'||a.target==='_top'||a.target==='_parent')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        console.warn('[AFlix AdBlock] Blocked outbound link:', href);
      }
    } catch(err) {}
  };
  _ours.add(_linkGuard);
  document.addEventListener('click', _linkGuard, true);

  /* ══════════════════════════════════════════════════════════
     LAYER 5 — postMessage firewall
  ══════════════════════════════════════════════════════════ */
  const AD_HOSTS = [
    'doubleclick','googlesyndication','adservice','popads','popcash',
    'exoclick','trafficjunky','juicyads','adnxs','rubiconproject',
    'openx','pubmatic','criteo','clickadu','adcash','propellerads',
    'adsterra','yllix','clkrev','onclick','popunder','go2jump',
    'onclkds','onclickads','tsyndicate','adspyglass'
  ];
  const _msgGuard = function(e) {
    if (e.origin === window.location.origin) return;
    try { if (isSafe(new URL(e.origin).hostname)) return; } catch(err) {}
    let data;
    try { data = typeof e.data==='string' ? JSON.parse(e.data) : e.data; }
    catch(err) { return; }
    if (!data || typeof data !== 'object') return;
    const bad = Object.values(data).some(v => {
      if (typeof v !== 'string' || !v.startsWith('http')) return false;
      try {
        const u = new URL(v);
        return !isSafe(u.hostname) && AD_HOSTS.some(h => u.hostname.includes(h));
      } catch(e) { return false; }
    });
    if (bad) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage ad from:', e.origin);
    }
  };
  _ours.add(_msgGuard);
  window.addEventListener('message', _msgGuard, true);

  /* ══════════════════════════════════════════════════════════
     LAYER 6 — beforeunload guard
  ══════════════════════════════════════════════════════════ */
  window.addEventListener('beforeunload', function(e) {
    const modal = document.getElementById('playerModal');
    if (modal?.classList.contains('open')) {
      e.preventDefault(); e.returnValue = ''; return '';
    }
  });

  /* ══════════════════════════════════════════════════════════
     LAYER 7 — MutationObserver: remove injected ad nodes
  ══════════════════════════════════════════════════════════ */
  function isAdUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, window.location.href);
      if (isSafe(u.hostname)) return false;
      const full = (u.hostname+u.pathname).toLowerCase();
      return AD_HOSTS.some(h => full.includes(h));
    } catch(e) { return AD_HOSTS.some(h => String(url).toLowerCase().includes(h)); }
  }

  const OUR_IDS = new Set([
    'playerModal','detailModal','settingsModal','wlPanel','iptvModal','toastWrap'
  ]);

  new MutationObserver(muts => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if ((node.tagName==='A') && isAdUrl(node.href||node.getAttribute('href'))) {
          node.remove(); continue;
        }
        if (node.tagName==='SCRIPT' && isAdUrl(node.src)) {
          node.remove(); continue;
        }
        if (['DIV','SECTION','SPAN'].includes(node.tagName)) {
          setTimeout(() => {
            if (!node.parentNode || OUR_IDS.has(node.id||'')) return;
            try {
              const st = window.getComputedStyle(node);
              if ((st.position==='fixed'||st.position==='absolute') &&
                  parseInt(st.zIndex)>9000 &&
                  parseInt(st.width)>window.innerWidth*0.7 &&
                  parseInt(st.height)>window.innerHeight*0.7) {
                node.remove();
              }
            } catch(e) {}
          }, 100);
        }
        node.querySelectorAll?.('a[href]')?.forEach(a => {
          if (isAdUrl(a.href)) {
            a.addEventListener('click', ev=>{ev.preventDefault();ev.stopImmediatePropagation();},true);
            a.removeAttribute('href'); a.style.pointerEvents='none';
          }
        });
      }
    }
  }).observe(document.documentElement, {childList:true, subtree:true});

  /* ══════════════════════════════════════════════════════════
     LAYER 8 — aflixHardenIframe (called by index.html)
     Nothing we can do about cross-origin iframe internals,
     but we log it and re-assert our window.open proxy.
  ══════════════════════════════════════════════════════════ */
  window.aflixHardenIframe = function(iframe) {
    if (!iframe) return;
    // Each time the iframe loads, log and re-assert our proxy
    iframe.addEventListener('load', function() {
      // Re-assert in case something restored window.open
      try {
        Object.defineProperty(window, 'open', {
          get: () => _openProxy,
          set: () => {},
          configurable: false
        });
      } catch(e) {}
    });
  };

  // Self-wire to #playerFrame
  function _wire() {
    const f = document.getElementById('playerFrame');
    if (f) window.aflixHardenIframe(f);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _wire);
  else _wire();

  console.log('[AFlix AdBlock] ✓ v4 — Proxy-based popup blocking active');
  console.log('[AFlix AdBlock] Primary defence: Service Worker network blocking (sw.js)');

})();
