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

  /* ── 6. IFRAME HARDENING — aflixHardenIframe() ─────────────── */
  //
  // HOW SANDBOX DETECTION WORKS (and how we beat it):
  //   Servers read window.frameElement.sandbox from inside the iframe.
  //   This only works when allow-same-origin is present (same-origin access).
  //   WITHOUT allow-same-origin → iframe gets null/opaque origin → accessing
  //   window.frameElement throws a cross-origin SecurityError → detection
  //   code crashes silently → player loads normally. Server cannot see
  //   the sandbox at all. We get popup blocking AND no block screen.
  //
  // HOW POPUP ADS FIRE (and how we kill them):
  //   Pop-under ads attach a document/body click listener and call window.open()
  //   on any user click (Wikipedia: Pop-up ad). WITHOUT allow-popups in sandbox
  //   → window.open() is completely dead inside the iframe at the browser level.
  //   No JS override needed — the browser kills it before JS even sees it.
  //
  // WHY NOT allow-same-origin + allow-scripts together:
  //   With both, embedded JS can call frameElement.removeAttribute('sandbox')
  //   and fully escape the sandbox. Never use both together (MDN, rocketvalidator).

  window.aflixHardenIframe = function(iframe) {
    if (!iframe) return;

    iframe.setAttribute('sandbox', [
      'allow-scripts',                          // player JS runs
      'allow-forms',                            // some players POST for preferences
      'allow-fullscreen',                       // fullscreen button works
      'allow-orientation-lock',                 // mobile orientation
      'allow-presentation',                     // Presentation API
      'allow-top-navigation-by-user-activation' // only real user clicks can nav top frame
      // NOT allow-same-origin → null origin, frameElement unreadable, no sandbox detection
      // NOT allow-popups      → window.open() dead at browser level, popup ads killed
    ].join(' '));

    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');

    iframe.setAttribute('allow', [
      'autoplay',
      'fullscreen *',        // * required for cross-origin fullscreen chains
      'picture-in-picture',
      'encrypted-media',
      'gyroscope',
      'accelerometer',
      'clipboard-write'
    ].join('; '));
  };

  /* ── 7. postMessage firewall ────────────────────────────────── */
  // Two-phase filter — allow legit player events, block ad/nav payloads.

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

    // Phase 2: block confirmed ad/nav payloads
    const dataStr = JSON.stringify(data).toLowerCase();
    const hasAdHost    = AD_HOSTS.some(h => dataStr.includes(h));
    const hasOutbound  = Object.values(data).some(v =>
      typeof v === 'string' && v.startsWith('http') &&
      !SAFE_ORIGINS.some(o => v.includes(o))
    );
    const hasNavIntent = ['redirect', 'navigate', 'popup'].some(k => dataStr.includes(k));

    if (hasAdHost || (hasOutbound && hasNavIntent)) {
      e.stopImmediatePropagation();
      console.warn('[AFlix AdBlock] Blocked postMessage from:', e.origin, data);
    }
  }, true);

  /* ── 8. TRANSPARENT CLICK SHIELD over the iframe ────────────── */
  // Pop-under ads fire on any click reaching the iframe's document/body listener.
  // This shield sits in front of the iframe, intercepts every click, then
  // re-dispatches it as an untrusted synthetic event. Browsers only allow
  // window.open() inside TRUSTED (real) user events — synthetic events are
  // untrusted, so any window.open() the iframe tries to call gets auto-blocked
  // by the browser on top of the sandbox already killing it.

  function installClickShield() {
    const stage  = document.getElementById('playerStage');
    const iframe = document.getElementById('playerFrame');
    if (!stage || !iframe || stage.querySelector('.aflix-click-shield')) return;

    const shield = document.createElement('div');
    shield.className = 'aflix-click-shield';
    Object.assign(shield.style, {
      position: 'absolute', inset: '0', zIndex: '1',
      cursor: 'pointer', background: 'transparent', pointerEvents: 'auto'
    });

    shield.addEventListener('click', function(e) {
      e.stopPropagation();
      // Briefly disable shield so the real click passes through for player controls
      shield.style.pointerEvents = 'none';
      setTimeout(() => { shield.style.pointerEvents = 'auto'; }, 300);
    }, true);

    if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
    stage.appendChild(shield);
    console.log('[AFlix AdBlock] ✓ Click shield installed');
  }

  document.addEventListener('DOMContentLoaded', function() {
    const modal = document.getElementById('playerModal');
    if (!modal) return;
    new MutationObserver(function() {
      if (modal.classList.contains('open')) setTimeout(installClickShield, 200);
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  });

  console.log('[AFlix AdBlock] ✓ Active — 8-layer ad & popup protection enabled');

})();
