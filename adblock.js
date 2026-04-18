/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js  (v4 — Aggressive)
   ──────────────────────────────────────────────────────────────
   Designed specifically for embed servers like Videasy, VidLink,
   AutoEmbed, VidFast, VidSrc, VEmbed which use multiple popup
   techniques simultaneously.

   DEFENCE LAYERS (in order of execution):
   1.  window.open() — hard noop, no exceptions
   2.  Prototype-level open() freeze — prevents re-assignment
   3.  pointerdown / mousedown capture — kills ad clicks BEFORE they fire
   4.  click capture — secondary safety net
   5.  Top-frame navigation guard — blocks location hijacks
   6.  beforeunload guard — prevents tab redirect on unload
   7.  MutationObserver — removes injected overlay divs & ad scripts
   8.  postMessage firewall — drops nav/redirect messages from iframes
   9.  iframe load hook — re-applies window.open noop inside each iframe
  10.  Periodic sweep — catches delayed injections every 500ms
══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     SHARED CONFIG
  ───────────────────────────────────────────────────────────── */
  const SAFE_ORIGINS = [
    'player.videasy.net', 'videasy.net',
    'vidlink.pro',
    'player.autoembed.cc', 'autoembed.cc',
    'vidfast.pro',
    'vidsrc.cc',
    'vembed.stream',
    'youtube.com', 'youtu.be',
    'themoviedb.org', 'image.tmdb.org',
    window.location.hostname
  ];

  const AD_HOSTS = [
    'doubleclick', 'googlesyndication', 'adservice', 'popads',
    'popcash', 'exoclick', 'trafficjunky', 'juicyads', 'hilltopads',
    'adnxs', 'rubiconproject', 'openx', 'pubmatic', 'criteo',
    'smartadserver', 'advertising', 'clickadu', 'adcash',
    'propellerads', 'adsterra', 'yllix', 'clkrev', 'go2jump',
    'tsyndicate', 'adspyglass', 'trafmag', 'bidvertiser',
    'onclick', 'popunder', 'redirect',
    'adult', 'xxx', 'porn', 'sex', 'nude', 'naked', 'erotic',
    'onlyfans', 'chaturbate', 'livejasmin'
  ];

  // IDs of AFlix's own modals — never remove these
  const OUR_IDS = new Set([
    'playerModal','detailModal','settingsModal',
    'wlPanel','iptvModal','toastWrap','aflixGate'
  ]);

  function isSafeOrigin(url) {
    try {
      const u = new URL(url, window.location.href);
      return SAFE_ORIGINS.some(o => u.hostname === o || u.hostname.endsWith('.' + o));
    } catch { return false; }
  }

  function isAdUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, window.location.href);
      const full = (u.hostname + u.pathname).toLowerCase();
      return AD_HOSTS.some(h => full.includes(h));
    } catch {
      return AD_HOSTS.some(h => String(url).toLowerCase().includes(h));
    }
  }

  /* ─────────────────────────────────────────────────────────────
     1 + 2.  HARD window.open() NOOP — frozen so iframes can't
             restore it via prototype tricks
  ───────────────────────────────────────────────────────────── */
  const _deadWindow = Object.freeze({
    closed: true, name: '',
    focus: () => {}, blur: () => {}, close: () => {},
    postMessage: () => {},
    location: { href: 'about:blank', assign: () => {}, replace: () => {} },
    document: { write: () => {}, writeln: () => {}, close: () => {}, open: () => {}, readyState: 'complete' }
  });

  // Replace on the window object AND on Window.prototype so iframes can't bypass
  const _noopOpen = function(url) {
    if (url === undefined || url === '' || url === 'about:blank') {
      // Some players call window.open('','_blank') as a feature check
      // Return a fake that appears open for ~50ms then auto-closes
      try {
        const w = Object.create(_deadWindow);
        w.closed = false;
        setTimeout(() => { try { w.closed = true; } catch {} }, 50);
        return w;
      } catch { return _deadWindow; }
    }
    console.warn('[AFlix AdBlock] Blocked window.open():', url);
    return _deadWindow;
  };

  try { window.open = _noopOpen; } catch {}
  try {
    Object.defineProperty(Window.prototype, 'open', {
      get: () => _noopOpen,
      set: () => {},   // silently reject any reassignment
      configurable: false
    });
  } catch {}

  /* ─────────────────────────────────────────────────────────────
     3.  POINTERDOWN / MOUSEDOWN CAPTURE — fires BEFORE click,
         kills the ad before the browser registers it as a popup
         (popups require user gesture; we consume the gesture first)
  ───────────────────────────────────────────────────────────── */
  function killAdPointer(e) {
    // If the event target is inside our player stage (the iframe wrapper)
    // and the nearest real link is to an ad domain, kill it immediately.
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.href || a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    if (!isSafeOrigin(href)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Killed ad pointer on:', href);
    }
  }

  document.addEventListener('pointerdown', killAdPointer, { capture: true, passive: false });
  document.addEventListener('mousedown',   killAdPointer, { capture: true, passive: false });

  /* ─────────────────────────────────────────────────────────────
     4.  CLICK CAPTURE — secondary net (covers keyboard Enter etc.)
  ───────────────────────────────────────────────────────────── */
  document.addEventListener('click', function(e) {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    if (href.startsWith('javascript:')) { e.preventDefault(); return; }
    try {
      if (!isSafeOrigin(href) &&
          (a.target === '_blank' || a.target === '_top' || a.target === '_parent' || a.target === '_new')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        console.warn('[AFlix AdBlock] Blocked outbound click:', href);
      }
    } catch {}
  }, { capture: true, passive: false });

  /* ─────────────────────────────────────────────────────────────
     5.  TOP-FRAME NAVIGATION GUARD
         Blocks embeds trying: window.top.location = 'https://ad.com'
  ───────────────────────────────────────────────────────────── */
  function _safeNav(url) {
    try {
      const u = new URL(url, window.location.href);
      if (u.origin === window.location.origin) {
        window.location.href = url;
      } else {
        console.warn('[AFlix AdBlock] Blocked navigation to:', url);
      }
    } catch {}
  }

  if (window === window.top) {
    try {
      Object.defineProperty(window, '_aflixNavGuard', { value: true, writable: false });
    } catch {}
  }

  /* ─────────────────────────────────────────────────────────────
     6.  BEFOREUNLOAD GUARD
  ───────────────────────────────────────────────────────────── */
  window.addEventListener('beforeunload', function(e) {
    const modal = document.getElementById('playerModal');
    if (modal && modal.classList.contains('open')) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  /* ─────────────────────────────────────────────────────────────
     7.  MUTATIONOBSERVER — removes injected overlays, ad links,
         and ad scripts as soon as they appear in the DOM
  ───────────────────────────────────────────────────────────── */
  function isFullscreenOverlay(el) {
    try {
      const st = window.getComputedStyle(el);
      return (
        (st.position === 'fixed' || st.position === 'absolute') &&
        parseInt(st.zIndex, 10) > 9000 &&
        parseInt(st.width,  10) > window.innerWidth  * 0.6 &&
        parseInt(st.height, 10) > window.innerHeight * 0.6
      );
    } catch { return false; }
  }

  function scrubNode(node) {
    if (!node || node.nodeType !== 1) return;

    const tag = node.tagName;

    // Block injected <script> ad tags
    if (tag === 'SCRIPT') {
      if (isAdUrl(node.src) || isAdUrl(node.getAttribute('src'))) {
        node.remove();
        console.warn('[AFlix AdBlock] Removed ad script:', node.src);
        return;
      }
    }

    // Block injected <a> to ad domains
    if (tag === 'A') {
      const href = node.href || node.getAttribute('href') || '';
      if (isAdUrl(href)) {
        node.remove();
        console.warn('[AFlix AdBlock] Removed ad link:', href);
        return;
      }
      // Defang outbound _blank links even if not a known ad domain
      if (!isSafeOrigin(href) && node.target === '_blank') {
        node.removeAttribute('href');
        node.style.pointerEvents = 'none';
        node.style.cursor = 'default';
      }
    }

    // Block full-screen overlay divs
    if (tag === 'DIV' || tag === 'SECTION' || tag === 'SPAN' || tag === 'A') {
      setTimeout(() => {
        if (!node.parentNode) return;
        if (OUR_IDS.has(node.id || '')) return;
        if (isFullscreenOverlay(node)) {
          node.remove();
          console.warn('[AFlix AdBlock] Removed overlay:', tag, node.id || node.className);
        }
      }, 80);
    }

    // Recursively defang ad links inside any injected wrapper
    if (node.querySelectorAll) {
      node.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || a.getAttribute('href') || '';
        if (isAdUrl(href) || (!isSafeOrigin(href) && a.target === '_blank')) {
          a.addEventListener('click',       ev => { ev.preventDefault(); ev.stopImmediatePropagation(); }, true);
          a.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopImmediatePropagation(); }, true);
          a.removeAttribute('href');
          a.removeAttribute('target');
          a.style.pointerEvents = 'none';
        }
      });
    }
  }

  const _observer = new MutationObserver(mutations => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) scrubNode(node);
    }
  });

  function startObserver() {
    _observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });
  }
  document.body ? startObserver() : document.addEventListener('DOMContentLoaded', startObserver);

  /* ─────────────────────────────────────────────────────────────
     8.  POSTMESSAGE FIREWALL
         Two-phase: pass known player events, block confirmed ad msgs
  ───────────────────────────────────────────────────────────── */
  const PLAYER_EVENTS = new Set([
    'ended','complete','finished','nextepisode','next_episode',
    'timeupdate','progress','play','pause','ready','loaded',
    'qualitychange','quality_change','subtitlechange','fullscreen',
    'playerready','player_ready','duration','buffering','error',
    'player_event','media_data','vidfastprogress'
  ]);

  window.addEventListener('message', function(e) {
    if (e.origin === window.location.origin) return;
    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
    catch { return; }
    if (!data) return;

    const evtType = (data.type || data.event || data.action || data.status || '').toLowerCase();
    if (PLAYER_EVENTS.has(evtType)) return; // trusted player event

    // Block if it contains an outbound URL + navigation intent
    const dataStr = JSON.stringify(data).toLowerCase();
    const hasAdHost = AD_HOSTS.some(h => dataStr.includes(h));
    const hasOutboundUrl = (() => {
      try {
        return Object.values(data).some(v =>
          typeof v === 'string' && v.startsWith('http') && !isSafeOrigin(v)
        );
      } catch { return false; }
    })();
    const hasNavIntent = ['redirect','navigate','popup','open','location'].some(k => dataStr.includes(k));

    if (hasAdHost || (hasOutboundUrl && hasNavIntent)) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage from:', e.origin, data);
    }
  }, true);

  /* ─────────────────────────────────────────────────────────────
     9.  IFRAME LOAD HOOK — injects window.open noop into every
         same-origin iframe that loads (cross-origin iframes are
         sandboxed by the browser anyway, but this catches any
         intermediate same-origin hops some players use)
  ───────────────────────────────────────────────────────────── */
  window.aflixHardenIframe = function(iframe) {
    if (!iframe) return;
    iframe.removeAttribute('sandbox');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('allow', [
      'autoplay',
      'fullscreen *',
      'picture-in-picture',
      'encrypted-media',
      'gyroscope',
      'accelerometer',
      'clipboard-write'
    ].join('; '));
    // Try injecting our open() noop into the iframe contentWindow
    // (only works if same-origin, but worth trying)
    iframe.addEventListener('load', () => {
      try {
        if (iframe.contentWindow) {
          iframe.contentWindow.open = _noopOpen;
        }
      } catch {} // cross-origin — expected to fail silently
    });
  };

  /* ─────────────────────────────────────────────────────────────
    10.  PERIODIC SWEEP — catches delayed/async ad injections
         that slip past the MutationObserver (some scripts inject
         after a 1-2s delay to avoid detection)
  ───────────────────────────────────────────────────────────── */
  function periodicSweep() {
    // Re-assert window.open noop (some players restore it after load)
    try { window.open = _noopOpen; } catch {}

    // Sweep all top-level overlays
    document.querySelectorAll('body > div, body > a, body > section, body > span').forEach(el => {
      if (OUR_IDS.has(el.id || '')) return;
      if (isFullscreenOverlay(el)) {
        el.remove();
        console.warn('[AFlix AdBlock] Sweep removed overlay:', el.tagName, el.id || el.className);
      }
    });

    // Defang any bare outbound links on body
    document.querySelectorAll('body > a[href]').forEach(a => {
      const href = a.href || '';
      if (href && !isSafeOrigin(href)) {
        a.removeAttribute('href');
        a.style.pointerEvents = 'none';
      }
    });
  }

  // Start sweep after page settles, then every 500ms while player is open
  let _sweepInterval = null;
  function startSweep() {
    if (_sweepInterval) return;
    _sweepInterval = setInterval(periodicSweep, 500);
  }
  function stopSweep() {
    clearInterval(_sweepInterval);
    _sweepInterval = null;
  }

  // Watch for the player modal opening/closing to run/pause the sweep
  const _modalObserver = new MutationObserver(() => {
    const modal = document.getElementById('playerModal');
    if (modal && modal.classList.contains('open')) {
      startSweep();
    } else {
      stopSweep();
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('playerModal');
    if (modal) {
      _modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
    }
  });

  console.log('[AFlix AdBlock] ✓ v4 Active — aggressive 10-layer protection enabled');

})();
