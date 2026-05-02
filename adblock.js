/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js  (v3 — self-wiring)
   ──────────────────────────────────────────────────────────────
   Blocks popup ads that open a new browser tab from embed
   servers (VidLink, Videasy, VidFast, etc.).

   ROOT CAUSE of popups that survive v1/v2:
   ─────────────────────────────────────────
   Embed servers inject a click handler on window/document of
   the PARENT PAGE (not inside the iframe) via postMessage or
   by the iframe's onload triggering a script that runs in the
   parent context. That handler calls window.open() on the very
   next user click anywhere on the page. Because it fires on a
   real user gesture, browsers allow it through.

   WHAT ACTUALLY WORKS (verified by uBlock Origin source + Brave
   ad-blocking research + community reports):
   ─────────────────────────────────────────────────────────────
   1. Kill window.open() permanently and re-kill it every frame
      via requestAnimationFrame so it can't be restored.
   2. Poll & null document.onclick / document.onmousedown /
      window.onclick every 200 ms — this is the most common
      injection vector.
   3. Capture mousedown at the window level (capture=true) BEFORE
      it reaches the iframe's transparent ad layer. Log whether
      window.open is being called synchronously during that event.
   4. Override addEventListener on window AND document to intercept
      any 'click' or 'mousedown' listener added AFTER page load
      by the embed script, and wrap it to null window.open during
      its execution.
   5. Kill visibilitychange popunders.
   6. Service Worker blocks ad network requests at the network level.
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
    'themoviedb.org', 'image.tmdb.org',
    'youtube.com', 'youtu.be',
    window.location.hostname
  ];
  let _safeOrigins = null;
  function getSafeOrigins() {
    if (_safeOrigins) return _safeOrigins;
    const s = new Set(PERMANENT_SAFE);
    for (const raw of (window.aflixServers || [])) {
      try { s.add(new URL(raw.startsWith('http') ? raw : 'https://' + raw).hostname.toLowerCase()); }
      catch(e) {}
    }
    return (_safeOrigins = [...s]);
  }
  window.aflixRefreshSafeOrigins = () => { _safeOrigins = null; };
  function isSafe(h) {
    h = (h||'').toLowerCase();
    return getSafeOrigins().some(o => h === o || h.endsWith('.'+o));
  }

  /* ══════════════════════════════════════════════════════════
     LAYER 1 — window.open PERMANENT NOOP
     Re-applied every animation frame so scripts that save a
     reference to the original and restore it are defeated.
  ══════════════════════════════════════════════════════════ */
  const _fakeWin = () => ({
    closed:true, focus:()=>{}, blur:()=>{}, close:()=>{},
    postMessage:()=>{},
    document:{write:()=>{},writeln:()=>{},close:()=>{}}
  });

  function _killOpen() { window.open = _fakeWin; }
  _killOpen();

  // Re-apply every frame — defeats any script that caches the original
  // and restores it asynchronously
  (function rafLoop() {
    _killOpen();
    requestAnimationFrame(rafLoop);
  })();

  /* ══════════════════════════════════════════════════════════
     LAYER 2 — Poll & null document/window click handlers
     Most embed servers do: document.onclick = function(){ window.open(...) }
     We poll every 150 ms and clear any such handler.
  ══════════════════════════════════════════════════════════ */
  const _ourListeners = new WeakSet();

  setInterval(function() {
    const targets = [document, window, document.body, document.documentElement];
    const props = ['onclick','onmousedown','onmouseup','onpointerdown','ontouchstart'];
    for (const t of targets) {
      if (!t) continue;
      for (const p of props) {
        if (typeof t[p] === 'function' && !_ourListeners.has(t[p])) {
          console.warn('[AFlix AdBlock] Cleared', p, 'popup trap on', t === document ? 'document' : t === window ? 'window' : t.tagName);
          t[p] = null;
        }
      }
    }
  }, 150);

  /* ══════════════════════════════════════════════════════════
     LAYER 3 — Intercept addEventListener to wrap click/mousedown
     handlers added by embed scripts after load.
     We wrap them: during their execution, window.open = noop.
  ══════════════════════════════════════════════════════════ */
  const _BLOCK_TYPES = new Set(['click','mousedown','mouseup','pointerdown','touchstart','visibilitychange','blur']);

  function _wrapListener(type, fn) {
    if (!fn || typeof fn !== 'function') return fn;
    if (_ourListeners.has(fn)) return fn;
    const wrapped = function(e) {
      _killOpen();
      try { return fn.apply(this, arguments); }
      finally { _killOpen(); }
    };
    _ourListeners.add(wrapped);
    return wrapped;
  }

  // Patch addEventListener on window, document, and Element.prototype
  const _targets = [window, document, EventTarget.prototype];
  for (const target of _targets) {
    const _orig = target.addEventListener;
    if (!_orig) continue;
    target.addEventListener = function(type, fn, opts) {
      if (_BLOCK_TYPES.has(type) && typeof fn === 'function' && !_ourListeners.has(fn)) {
        fn = _wrapListener(type, fn);
      }
      return _orig.call(this, type, fn, opts);
    };
  }

  /* ══════════════════════════════════════════════════════════
     LAYER 4 — window-level mousedown capture (before iframe)
     Runs before any iframe-injected handler gets a chance.
     Kills window.open at the exact moment a click starts.
  ══════════════════════════════════════════════════════════ */
  const _shieldHandler = function(e) {
    _killOpen();
    // If the click is outside our own UI elements, be extra aggressive
    const id = e.target?.id || '';
    const cls = e.target?.className || '';
    const isOurUI = ['playerModal','playerWrap','playerStage','playerFrame',
                     'detailModal','settingsModal','wlPanel','iptvModal']
                    .some(i => id.includes(i) || cls.includes(i));
    if (isOurUI || e.target?.closest?.('#playerModal, #detailModal, #settingsModal')) {
      // Double-kill with a small delay to catch deferred window.open calls
      setTimeout(_killOpen, 0);
      setTimeout(_killOpen, 50);
      setTimeout(_killOpen, 150);
    }
  };
  const _shieldHandlerMarked = _shieldHandler;
  _ourListeners.add(_shieldHandlerMarked);
  window.addEventListener('mousedown', _shieldHandlerMarked, true);
  window.addEventListener('pointerdown', _shieldHandlerMarked, true);
  window.addEventListener('click', _shieldHandlerMarked, true);
  window.addEventListener('touchstart', _shieldHandlerMarked, { capture: true, passive: true });

  /* ══════════════════════════════════════════════════════════
     LAYER 5 — Define aflixHardenIframe (called by index.html
     every time a new embed URL is loaded into the iframe)
  ══════════════════════════════════════════════════════════ */
  window.aflixHardenIframe = function(iframe) {
    if (!iframe) return;

    // Each time the iframe gets a new src, re-kill open and
    // re-attach our load listener
    iframe.addEventListener('load', function() {
      _killOpen();
      setTimeout(_killOpen, 100);
      setTimeout(_killOpen, 500);
      setTimeout(_killOpen, 1500);
    });

    console.log('[AFlix AdBlock] iframe hardened:', iframe.src || '(blank)');
  };

  /* ══════════════════════════════════════════════════════════
     LAYER 6 — Self-wire to #playerFrame on DOM ready
     index.html's aflixHardenIframe hook only fires when a src
     is being SET. We also hook the existing iframe immediately
     so we catch it from the very first load.
  ══════════════════════════════════════════════════════════ */
  function _wirePlayerFrame() {
    const iframe = document.getElementById('playerFrame');
    if (iframe) {
      window.aflixHardenIframe(iframe);

      // Watch for src attribute changes via MutationObserver
      new MutationObserver(function(muts) {
        for (const m of muts) {
          if (m.attributeName === 'src') {
            _killOpen();
            setTimeout(_killOpen, 100);
            setTimeout(_killOpen, 500);
          }
        }
      }).observe(iframe, { attributes: true, attributeFilter: ['src'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wirePlayerFrame);
  } else {
    _wirePlayerFrame();
  }

  /* ══════════════════════════════════════════════════════════
     LAYER 7 — Block outbound <a> link clicks
  ══════════════════════════════════════════════════════════ */
  const _linkGuard = function(e) {
    const a = e.target?.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    if (href.startsWith('javascript:')) { e.preventDefault(); return; }
    try {
      const u = new URL(href, window.location.href);
      if (!isSafe(u.hostname) &&
          (a.target === '_blank' || a.target === '_top' || a.target === '_parent')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        console.warn('[AFlix AdBlock] Blocked outbound link:', href);
      }
    } catch(err) {}
  };
  _ourListeners.add(_linkGuard);
  document.addEventListener('click', _linkGuard, true);

  /* ══════════════════════════════════════════════════════════
     LAYER 8 — postMessage firewall
  ══════════════════════════════════════════════════════════ */
  const AD_HOSTS = [
    'doubleclick','googlesyndication','adservice','popads','popcash',
    'exoclick','trafficjunky','juicyads','hilltopads','adnxs',
    'rubiconproject','openx','pubmatic','criteo','smartadserver',
    'clickadu','adcash','propellerads','adsterra','yllix','clkrev',
    'onclick','popunder','go2jump'
  ];
  const _msgGuard = function(e) {
    if (e.origin === window.location.origin) return;
    try { if (isSafe(new URL(e.origin).hostname)) return; } catch(err) {}
    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch(err) { return; }
    if (!data || typeof data !== 'object') return;
    const hasAd = Object.values(data).some(v => {
      if (typeof v !== 'string' || !v.startsWith('http')) return false;
      try { const u = new URL(v); return !isSafe(u.hostname) && AD_HOSTS.some(h => u.hostname.includes(h)); }
      catch(e) { return false; }
    });
    if (hasAd) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage ad from:', e.origin);
    }
  };
  _ourListeners.add(_msgGuard);
  window.addEventListener('message', _msgGuard, true);

  /* ══════════════════════════════════════════════════════════
     LAYER 9 — MutationObserver: remove injected ad nodes
  ══════════════════════════════════════════════════════════ */
  const OUR_IDS = new Set([
    'playerModal','detailModal','settingsModal',
    'wlPanel','iptvModal','toastWrap'
  ]);

  function isAdUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, window.location.href);
      if (isSafe(u.hostname)) return false;
      const full = (u.hostname + u.pathname).toLowerCase();
      return AD_HOSTS.some(h => full.includes(h));
    } catch(e) { return AD_HOSTS.some(h => String(url).toLowerCase().includes(h)); }
  }

  function isBigOverlay(el) {
    try {
      const st = window.getComputedStyle(el);
      const zi = parseInt(st.zIndex, 10);
      return (st.position === 'fixed' || st.position === 'absolute') &&
             zi > 9000 &&
             parseInt(st.width) > window.innerWidth * 0.7 &&
             parseInt(st.height) > window.innerHeight * 0.7;
    } catch(e) { return false; }
  }

  new MutationObserver(function(muts) {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'A' && isAdUrl(node.href || node.getAttribute('href'))) {
          node.remove(); continue;
        }
        if (node.tagName === 'SCRIPT' && isAdUrl(node.src)) {
          node.remove(); continue;
        }
        if (['DIV','SECTION','SPAN'].includes(node.tagName)) {
          setTimeout(() => {
            if (node.parentNode && isBigOverlay(node) && !OUR_IDS.has(node.id || ''))
              node.remove();
          }, 100);
        }
        node.querySelectorAll?.('a[href]')?.forEach(a => {
          if (isAdUrl(a.href)) {
            a.addEventListener('click', ev => { ev.preventDefault(); ev.stopImmediatePropagation(); }, true);
            a.removeAttribute('href');
            a.style.pointerEvents = 'none';
          }
        });
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ══════════════════════════════════════════════════════════
     LAYER 10 — beforeunload guard (top-frame hijack)
  ══════════════════════════════════════════════════════════ */
  window.addEventListener('beforeunload', function(e) {
    const modal = document.getElementById('playerModal');
    if (modal?.classList.contains('open')) {
      e.preventDefault(); e.returnValue = ''; return '';
    }
  });

  console.log('[AFlix AdBlock] ✓ v3 active — 10-layer popup protection');

})();
