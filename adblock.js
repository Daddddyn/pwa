/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js
   ──────────────────────────────────────────────────────────────
   Blocks popup ads, redirects, and unsafe content from embed
   servers without breaking playback.

   HOW IT WORKS (3-layer defence):
   1. window.open() override  — kills all new-tab/popup attempts
   2. beforeunload / popstate guard — prevents top-frame hijack
   3. MutationObserver — removes injected <a> and overlay <div>s
      that auto-click to open ads

   DYNAMIC SERVER WHITELIST:
   index.html sets  window.aflixServers = [array of server URL
   strings from the loaded config] before this script runs.
   If that global is absent we fall back to a built-in list.
   This means adblock.js never needs editing when you add a new
   server to aflix-config.json.
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── ADBLOCK KILL-SWITCH ────────────────────────────────────
     If the user has toggled adblock OFF in Settings, bail out
     immediately so none of the protection layers are applied.
  ──────────────────────────────────────────────────────────── */
  try {
    if (localStorage.getItem('aflix_adblock_off') === '1') {
      console.warn('[AFlix AdBlock] ⚠ Disabled by user — ads may appear.');
      return;
    }
  } catch(e) {}

  /* ── DYNAMIC SAFE_ORIGINS ──────────────────────────────────
     Built from window.aflixServers (set by index.html after
     the config loads) + a permanent fallback set.
     Hostnames only — no protocols or paths.
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
    // Pull hostnames out of every server URL the config registered
    const serverUrls = window.aflixServers || [];
    for (const raw of serverUrls) {
      try {
        // raw may be a full URL like "https://vidsrc-me.ru/embed/movie/{id}"
        // or just a hostname — handle both
        const url = raw.startsWith('http') ? raw : 'https://' + raw;
        origins.add(new URL(url).hostname.toLowerCase());
      } catch(e) {}
    }
    return [...origins];
  }

  // Safe origins are evaluated lazily on first use so that
  // index.html has time to set window.aflixServers even if it
  // does so after this script executes.
  let _safeOrigins = null;
  function getSafeOrigins() {
    if (!_safeOrigins) _safeOrigins = buildSafeOrigins();
    return _safeOrigins;
  }

  // index.html can call this after config loads to refresh the list
  window.aflixRefreshSafeOrigins = function() { _safeOrigins = null; };

  function isSafeOrigin(hostname) {
    const h = hostname.toLowerCase();
    return getSafeOrigins().some(o => h === o || h.endsWith('.' + o));
  }

  /* ── 1. BLOCK window.open() ────────────────────────────────── */
  const _noop = () => ({
    closed: true, focus: () => {}, blur: () => {},
    close: () => {}, postMessage: () => {},
    document: { write: () => {}, writeln: () => {}, close: () => {} }
  });
  window.open = _noop;

  /* ── 2. BLOCK top-frame navigation hijacks ─────────────────── */
  function _safeNav(url) {
    try {
      const u = new URL(url, window.location.href);
      if (u.origin === window.location.origin) {
        window.location.href = url;
      } else {
        console.warn('[AFlix AdBlock] Blocked navigation to:', url);
      }
    } catch(e) {}
  }

  /* ── 3. INTERCEPT <a target="_blank"> clicks ───────────────── */
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

  /* ── 4. BLOCK beforeunload redirect tricks ───────────────────── */
  window.addEventListener('beforeunload', function(e) {
    const modal = document.getElementById('playerModal');
    if (modal && modal.classList.contains('open')) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  /* ── 5. MUTATION OBSERVER — remove injected ad overlays ─────── */
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
      // Never flag URLs from our own safe servers
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
    'wlPanel','iptvModal','toastWrap'
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

  /* ── 6. SANDBOX NOTE ────────────────────────────────────────── */
  // Sandbox attributes are intentionally NOT applied to embed iframes.
  // All vidsrc/vembed-style players do internal same-origin redirects
  // during player init; any sandbox token — even allow-same-origin alone
  // — causes those redirects to resolve against localhost (Apache 404).
  // Ad protection is handled entirely by the JS layers above.

  /* ── 7. postMessage firewall ────────────────────────────────── */
  // Only block messages that carry an actual external HTTP URL in
  // a navigation-intent key. Plain strings like "location" that
  // are part of normal player state objects are ignored.
  window.addEventListener('message', function(e) {
    if (e.origin === window.location.origin) return;

    // Check if the sender is a known-safe server — if so, trust it
    try {
      if (isSafeOrigin(new URL(e.origin).hostname)) return;
    } catch(err) {}

    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
    catch(err) { return; }
    if (!data || typeof data !== 'object') return;

    // Look specifically for values that are external HTTP URLs
    // pointing to non-safe origins — that's the real ad telltale.
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

  console.log('[AFlix AdBlock] ✓ Active — popup & ad protection enabled');

})();
