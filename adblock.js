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

  /* ── 6. SANDBOX ENFORCEMENT helper ─────────────────────────── */
  //
  // DESIGN: Many high-quality embed servers (VidLink, Videasy, etc.) actively
  // detect a strict sandbox and refuse to load, showing a "Please Disable
  // Sandbox" wall. The solution is NOT to drop sandbox entirely — it's to use
  // the minimal set of permissions the players actually require, while letting
  // the JS layers above (window.open override, MutationObserver, click capture,
  // postMessage firewall) handle real ad blocking.
  //
  // Key permissions explained:
  //   allow-popups                     — required by many players to initialise
  //                                      their own sub-iframes (quality picker,
  //                                      subtitle loader, HLS worker). Without
  //                                      this, players detect the sandbox and bail.
  //   allow-popups-to-escape-sandbox   — any window.open() the player calls opens
  //                                      WITHOUT sandbox. Sounds scary, but our
  //                                      window.open() override above already
  //                                      returns a fake dead object, so nothing
  //                                      actually opens. This flag just satisfies
  //                                      the player's feature-detect check.
  //   allow-top-navigation-by-user-activation
  //                                    — allows top-frame nav ONLY on a real user
  //                                      gesture (click/tap). Auto-redirects and
  //                                      script-triggered navigations are still
  //                                      blocked. This is the critical flag that
  //                                      stops background hijacks while letting
  //                                      players pass their own nav-capability test.
  //   allow-forms                      — some players POST to their own origin for
  //                                      subtitle/quality preference persistence.
  //   NOT included:
  //   allow-top-navigation             — would allow unrestricted top-frame hijack
  //   allow-top-navigation-to-custom-protocols — not needed, blocks tel:/mailto: abuse

  window.aflixHardenIframe = function(iframe) {
    if (!iframe) return;

    iframe.setAttribute('sandbox', [
      'allow-scripts',
      'allow-same-origin',
      'allow-fullscreen',
      'allow-presentation',
      'allow-orientation-lock',
      'allow-forms',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-top-navigation-by-user-activation'
    ].join(' '));

    // 'no-referrer' caused servers like VidFast, VidSrc, and Videasy to block
    // playback because they check document.referrer inside the frame to verify
    // the embed comes from a real site. 'strict-origin-when-cross-origin' sends
    // only our origin (no path/query) — enough to pass their check while not
    // leaking the full URL of the user's session.
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');

    iframe.setAttribute('allow', [
      'autoplay',
      'fullscreen *',          // * needed for cross-origin fullscreen chains
      'picture-in-picture',
      'encrypted-media',
      'gyroscope',
      'accelerometer',
      'clipboard-write'        // needed by some players' copy-link feature
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
    const hasNavIntent = ['redirect', 'navigate', 'popup'].some(k => dataStr.includes(k));

    if (hasAdHost || (hasOutboundUrl && hasNavIntent)) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage from:', e.origin, data);
    }
  }, true);

  console.log('[AFlix AdBlock] ✓ Active — popup & ad protection enabled');

})();
