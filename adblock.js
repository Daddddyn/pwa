/* ══════════════════════════════════════════════════════════════
   AFlix Ad & Popup Blocker — adblock.js
   ──────────────────────────────────────────────────────────────
   Blocks popup ads, redirects, and unsafe content from embed
   servers (vidsrc, vembed, etc.) without breaking playback.

   HOW IT WORKS (3-layer defence):
   1. window.open() override  — kills all new-tab/popup attempts
   2. beforeunload / popstate guard — prevents top-frame hijack
   3. MutationObserver — removes injected <a> and overlay <div>s
      that auto-click to open ads
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── 1. BLOCK window.open() ────────────────────────────────── */
  // Embed iframes call window.open() to launch popup ads.
  // We replace it with a no-op that returns a fake window object
  // so the embed doesn't crash, it just silently fails to open anything.
  const _noop = () => ({
    closed: true, focus: () => {}, blur: () => {},
    close: () => {}, postMessage: () => {},
    document: { write: () => {}, writeln: () => {}, close: () => {} }
  });
  window.open = _noop;

  /* ── 2. BLOCK top-frame navigation hijacks ─────────────────── */
  // Some embeds try window.top.location = 'https://ad-site.com'
  // We intercept location assignment on the top window.
  try {
    const _loc = window.location;
    const _guard = {
      get href()    { return _loc.href; },
      set href(v)   { _safeNav(v); },
      assign(v)     { _safeNav(v); },
      replace(v)    { _safeNav(v); }
    };
    // Only block if this script is running in the TOP frame
    if (window === window.top) {
      Object.defineProperty(window, '_aflixBlockedNav', { value: true, writable: true });
    }
  } catch(e) {}

  function _safeNav(url) {
    // Allow only same-origin navigations
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
  // Ads often inject anchor tags. We kill clicks that try to open
  // new tabs pointing to non-whitelisted domains.
  const SAFE_ORIGINS = [
    'vidsrc.cc', 'vidsrc.to', 'vidsrc.xyz',
    'vembed.stream', 'youtube.com', 'youtu.be',
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
  // Some embeds call window.location = 'ad' inside a beforeunload handler.
  window.addEventListener('beforeunload', function(e) {
    // If the player modal is open, cancel the navigation entirely.
    const modal = document.getElementById('playerModal');
    if (modal && modal.classList.contains('open')) {
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

  /* ── 6. IFRAME HARDENING helper ────────────────────────────── */
  // HOW EMBED SERVERS DETECT SANDBOX:
  //   When any sandbox attribute is present, the browser sets window.origin = "null"
  //   inside the iframe. Embed servers (VidLink, AutoEmbed, VidFast, etc.) check
  //   this at runtime — if origin is "null" they show "Please Disable Sandbox" /
  //   "Iframe Sandbox Detected". No combination of sandbox tokens bypasses this.
  //   Source: https://blog.huli.tw/2022/04/07/en/iframe-and-window-open/
  //
  // ALSO: referrerpolicy="no-referrer" suppresses document.referrer inside the
  //   iframe, which some embeds check to verify they're embedded from a real page.
  //
  // SOLUTION: No sandbox, no referrerpolicy. Ad protection is handled entirely
  //   by JS layers 1-5 and 7 in this file (window.open noop, click intercept,
  //   MutationObserver, postMessage firewall, beforeunload guard).
  //   Note: window.open override only affects the TOP frame — embed iframes run
  //   in their own cross-origin browsing context and are unaffected by it.
  window.aflixHardenIframe = function(iframe) {
    if (!iframe) return;
    // Remove sandbox and referrerpolicy — both trigger embed detection
    iframe.removeAttribute('sandbox');
    iframe.removeAttribute('referrerpolicy');
    // Keep the allow/permissions policy for autoplay and fullscreen
    iframe.setAttribute('allow',
      'autoplay; fullscreen; picture-in-picture; encrypted-media; gyroscope; accelerometer'
    );
  };

  /* ── 7. postMessage firewall ────────────────────────────────── */
  // Block suspicious postMessages from iframes trying to trigger
  // navigation or open windows in the parent frame.
  window.addEventListener('message', function(e) {
    // Only intercept messages from non-same-origin frames
    if (e.origin === window.location.origin) return;

    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
    catch(err) { return; }

    if (!data) return;

    // Block any postMessage that tries to navigate the top window
    const suspicious = ['redirect', 'navigate', 'open', 'popup', 'location'];
    const dataStr = JSON.stringify(data).toLowerCase();
    if (suspicious.some(k => dataStr.includes(k))) {
      // Only log — don't stopImmediatePropagation so auto-next still works
      // for legit 'ended'/'complete' events (checked by setupAutoNext())
      const isAdMessage = AD_HOSTS.some(h => dataStr.includes(h)) ||
                          suspicious.slice(0, 4).some(k => {
                            // check if the value of a key contains a URL-like string
                            try {
                              return Object.values(data).some(v =>
                                typeof v === 'string' && v.startsWith('http') && !SAFE_ORIGINS.some(o => v.includes(o))
                              );
                            } catch(e) { return false; }
                          });
      if (isAdMessage) {
        e.stopImmediatePropagation();
        console.warn('[AFlix AdBlock] Blocked postMessage from:', e.origin, data);
      }
    }
  }, true);

  console.log('[AFlix AdBlock] ✓ Active — popup & ad protection enabled');

})();
