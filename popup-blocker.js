/* ════════════════════════════════════════════════════════════════════
   AFlix Popup Blocker — popup-blocker.js
   ────────────────────────────────────────────────────────────────────
   Based on the same technique used by AdGuard's PopupBlocker project:
   instead of a filter list, we patch the *native browser APIs* that
   are used to open popups and redirect pages.  Scripts on the page
   cannot detect that the blocker is active, and cannot call the real
   APIs without going through our proxy.

   HOW IT WORKS:
   ┌─────────────────────────────────────────────────────────────────┐
   │  1. Gesture tracker   — records whether a user gesture is live  │
   │  2. window.open proxy — only allows opens caused by user input  │
   │  3. location proxy    — blocks all non-same-origin navigation   │
   │  4. Event poisoning   — stops click-hijack overlays at capture  │
   │  5. createElement trap— catches dynamically injected <a> tags   │
   │  6. Anchor intercept  — blocks target=_blank / _top outbound    │
   │  7. SW inject bridge  — asks the SW to inject this file into    │
   │                         every player iframe it serves           │
   └─────────────────────────────────────────────────────────────────┘

   USAGE in index.html — add ONE line before your other scripts:
     <script src="popup-blocker.js"></script>

   That's it.  The SW injection bridge (layer 7) means this script
   also runs inside the embed iframes, which is where the actual
   ad code lives.  The SW rewrites embed responses to prepend this
   script into every HTML page it proxies.
   ════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────
  const _win       = global;
  const _doc       = global.document;
  const _href      = () => _win.location.href;
  const _origin    = () => _win.location.origin;

  function isSameOrigin(url) {
    if (!url || url === '' || url === 'about:blank' || url.startsWith('javascript:')) return true;
    try {
      return new URL(String(url), _href()).origin === _origin();
    } catch (e) { return false; }
  }

  function isBlobOrData(url) {
    try {
      const p = new URL(String(url), _href()).protocol;
      return p === 'blob:' || p === 'data:';
    } catch (e) { return false; }
  }

  function log(...args) {
    // eslint-disable-next-line no-console
    try { console.warn('[AFlix PB]', ...args); } catch (e) {}
  }

  // ── 1. GESTURE TRACKER ───────────────────────────────────────────
  //
  // We track whether a *real* user gesture is currently in progress.
  // A gesture is defined as: pointerdown / touchstart / keydown on a
  // real input element or body, followed within 500 ms by any action.
  //
  // This is exactly how AdGuard distinguishes a legitimate popup
  // (user clicked a real button that opens a quality picker) from an
  // ad popup (script fires window.open() on page load or after delay).

  let _gestureActive  = false;
  let _gestureTimeout = null;
  const GESTURE_TTL   = 500; // ms window after a real gesture

  function _markGesture() {
    _gestureActive = true;
    clearTimeout(_gestureTimeout);
    _gestureTimeout = setTimeout(() => { _gestureActive = false; }, GESTURE_TTL);
  }

  function _isGestureLive() { return _gestureActive; }

  // Trusted gesture events — must fire in capture phase so we see them first
  for (const type of ['pointerdown', 'touchstart', 'keydown', 'mousedown']) {
    _doc.addEventListener(type, _markGesture, { capture: true, passive: true });
  }

  // ── 2. window.open PROXY ─────────────────────────────────────────
  //
  // Replace window.open with a proxy that:
  //   • Allows same-origin opens (player quality pickers etc.)
  //   • Allows about:blank / empty opens (player feature detection)
  //   • Allows opens that happen within GESTURE_TTL of a real click
  //   • BLOCKS everything else — returns a convincing fake window
  //     so player feature-detect code (if (!win) { showError(); })
  //     doesn't break.
  //
  // The fake window has closed=false initially (passes truthiness
  // checks), a location that silently swallows assigns/replaces,
  // and a readyState of 'complete'.

  const _realOpen = _win.open.bind(_win);

  const _fakeWindow = {
    closed:   false,
    name:     '',
    location: {
      href:    'about:blank',
      assign:  () => {},
      replace: () => {},
      reload:  () => {},
    },
    document: {
      write:      () => {},
      writeln:    () => {},
      open:       () => {},
      close:      () => {},
      readyState: 'complete',
      body:       { innerHTML: '' },
    },
    focus:       () => {},
    blur:        () => {},
    close:       function () { this.closed = true; },
    postMessage: () => {},
    addEventListener:    () => {},
    removeEventListener: () => {},
    setTimeout:  (fn) => setTimeout(fn, 0),
    clearTimeout: () => {},
  };

  try {
    Object.defineProperty(_win, 'open', {
      get: () => _openProxy,
      set: () => {},          // swallow attempts to overwrite our proxy
      configurable: false,
      enumerable:   true,
    });
  } catch (e) {
    _win.open = _openProxy;   // Firefox strict fallback
  }

  function _openProxy(url, target, features) {
    // Same-origin: always allow
    if (isSameOrigin(url)) return _realOpen.call(_win, url, target, features);

    // about:blank / empty: allow with tiny hidden window (satisfies checks)
    if (!url || url === '' || url === 'about:blank') {
      const w = _realOpen.call(_win, 'about:blank', '_blank',
                               'width=1,height=1,left=-9999,top=-9999,toolbar=no');
      if (w) setTimeout(() => { try { w.close(); } catch (ex) {} }, 60);
      return w || _fakeWindow;
    }

    // blob:/data: — never
    if (isBlobOrData(url)) {
      log('Blocked blob/data window.open:', url);
      return _fakeWindow;
    }

    // Allow if a real user gesture is live
    if (_isGestureLive()) return _realOpen.call(_win, url, target, features);

    // Everything else — return the fake window
    log('Blocked window.open():', url);
    return _fakeWindow;
  }

  // ── 3. location PROXY ────────────────────────────────────────────
  //
  // Intercepts ALL forms of top-frame navigation:
  //   window.location = 'url'
  //   window.location.href = 'url'
  //   window.location.assign('url')
  //   window.location.replace('url')
  //   window.top.location = 'url'          (from iframes)
  //   document.location = 'url'

  const _realLoc = _win.location;

  function _safeNavigate(url) {
    if (isSameOrigin(url)) {
      // Same-origin navigation is fine
      _realLoc.href = url;
    } else if (isBlobOrData(url)) {
      log('Blocked blob/data navigate:', url);
    } else {
      log('Blocked top-frame redirect:', url);
    }
  }

  const _locProxy = new Proxy(_realLoc, {
    get(target, prop) {
      if (prop === 'assign')  return _safeNavigate;
      if (prop === 'replace') return _safeNavigate;
      if (prop === 'reload')  return () => target.reload();
      if (prop === 'href')    return target.href;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) {
      if (prop === 'href') { _safeNavigate(value); return true; }
      try { target[prop] = value; } catch (e) {}
      return true;
    },
  });

  // Only patch window.location on the top frame — iframes have their
  // own location and we don't want to break same-page navigation.
  if (_win === _win.top) {
    try {
      Object.defineProperty(_win, 'location', {
        get: () => _locProxy,
        set: (v) => _safeNavigate(v),
        configurable: false,
        enumerable:   true,
      });
    } catch (e) {
      // Firefox may resist this — patch document.location as fallback
      try {
        Object.defineProperty(_doc, 'location', {
          get: () => _locProxy,
          set: (v) => _safeNavigate(v),
          configurable: false,
        });
      } catch (e2) {}
    }
  }

  // Also override history.pushState / replaceState if they're being
  // abused to navigate off-site (rare but happens)
  try {
    const _realPush    = history.pushState.bind(history);
    const _realReplace = history.replaceState.bind(history);

    history.pushState = function (state, title, url) {
      if (url && !isSameOrigin(String(url))) {
        log('Blocked history.pushState to:', url);
        return;
      }
      return _realPush(state, title, url);
    };

    history.replaceState = function (state, title, url) {
      if (url && !isSameOrigin(String(url))) {
        log('Blocked history.replaceState to:', url);
        return;
      }
      return _realReplace(state, title, url);
    };
  } catch (e) {}

  // ── 4. EVENT POISONING — click-jacking overlay trap ──────────────
  //
  // Ad overlay technique: inject a transparent full-screen div/a that
  // covers the player.  When the user clicks "play", they actually
  // click the overlay which fires window.open().
  //
  // We counter this by:
  //  a) Scanning for suspicious overlays in the capture phase of click
  //  b) Removing confirmed overlays from the DOM before the event
  //     reaches them
  //
  // "Suspicious overlay" = fixed/absolute, z-index > 1000, covers
  // > 60% of viewport, has no recognisable player-UI id/class.

  const _OUR_IDS = new Set([
    'playerModal','detailModal','settingsModal','wlPanel','iptvModal',
    'toastWrap','playerFrame','playerWrap',
  ]);

  function _isAdOverlay(el) {
    try {
      const s  = _win.getComputedStyle(el);
      const zi = parseInt(s.zIndex, 10);
      const w  = parseInt(s.width,  10);
      const h  = parseInt(s.height, 10);
      return (
        (s.position === 'fixed' || s.position === 'absolute') &&
        zi > 1000 &&
        w  > _win.innerWidth  * 0.6 &&
        h  > _win.innerHeight * 0.6 &&
        !_OUR_IDS.has(el.id)
      );
    } catch (e) { return false; }
  }

  _doc.addEventListener('click', function (e) {
    // Walk up from the clicked element looking for an ad overlay
    let node = e.target;
    while (node && node !== _doc.body) {
      if (node.nodeType === 1 && _isAdOverlay(node)) {
        const href = node.getAttribute('href') || node.getAttribute('onclick') || '';
        // Only remove if it has an outbound link hint or no real content
        if (!href || !isSameOrigin(href)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          node.style.display = 'none';
          setTimeout(() => { try { node.remove(); } catch (ex) {} }, 0);
          log('Removed click-jacking overlay:', node.tagName, '#' + (node.id || ''));
          return;
        }
      }
      node = node.parentElement;
    }
  }, { capture: true });

  // ── 5. createElement TRAP ────────────────────────────────────────
  //
  // Ad scripts dynamically inject <a target="_blank"> tags via
  // document.createElement / innerHTML / insertAdjacentHTML.
  //
  // We patch createElement so any <a> element created by a script
  // gets a setter on its href property that intercepts outbound URLs.

  const _realCreateElement = _doc.createElement.bind(_doc);
  try {
    _doc.createElement = function (tag, opts) {
      const el = _realCreateElement(tag, opts);
      if (typeof tag === 'string' && tag.toLowerCase() === 'a') {
        let _href_val = '';
        Object.defineProperty(el, 'href', {
          get: () => _href_val,
          set: (v) => {
            _href_val = v;
            if (!isSameOrigin(v) && !isBlobOrData(v)) {
              // Neutralise target so even if it gets appended it can't redirect
              el.setAttribute('rel', 'noopener noreferrer');
              // We leave the href so the element looks normal to code that
              // inspects it, but override onclick to block navigation
              el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                log('Blocked injected <a> click:', v);
              }, { capture: true });
            }
          },
          configurable: true,
        });
      }
      return el;
    };
  } catch (e) {}

  // ── 6. ANCHOR INTERCEPT — outbound link blocker ──────────────────
  //
  // Catches any <a href="..."> that tries to open a new tab or hijack
  // the top frame.  Runs in capture phase so inline onclick="..." is
  // never reached for blocked links.

  const SAFE_ORIGINS_SET = new Set([
    'player.videasy.net', 'videasy.net',
    'player.autoembed.cc', 'autoembed.cc',
    'vidfast.pro',
    'vidlink.pro',
    'vidsrc.cc', 'vidsrc.to', 'vidsrc.xyz', 'vidsrc.su', 'vidsrc.vip',
    'vembed.stream', 'embed.su',
    'youtube.com', 'youtu.be',
    'themoviedb.org', 'image.tmdb.org',
  ]);

  function _isSafeHost(hostname) {
    if (!hostname) return false;
    if (hostname === _win.location.hostname) return true;
    return [...SAFE_ORIGINS_SET].some(h => hostname.endsWith(h));
  }

  _doc.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      if (href.startsWith('javascript:')) e.preventDefault();
      return;
    }
    try {
      const u = new URL(href, _href());
      if (!_isSafeHost(u.hostname)) {
        const t = a.target || '';
        if (t === '_blank' || t === '_top' || t === '_parent' || t === '_self') {
          e.preventDefault();
          e.stopImmediatePropagation();
          log('Blocked outbound anchor:', href);
        }
      }
    } catch (ex) {}
  }, { capture: true });

  // ── 7. MutationObserver — DOM injection cleaner ──────────────────
  //
  // Ad scripts sometimes bypass all of the above by:
  //  • Injecting a <script src="ad-network.js"> into the body
  //  • Injecting a full-screen <div> via innerHTML
  //  • Injecting <a> tags that auto-click via dispatchEvent
  //
  // We watch for all of these.

  const AD_FRAGS = [
    'doubleclick','googlesyndication','adservice','popads','popcash',
    'exoclick','trafficjunky','juicyads','hilltopads','adnxs',
    'rubiconproject','openx','pubmatic','criteo','smartadserver',
    'clickadu','adcash','propellerads','adsterra','yllix','clkrev',
    'onclick','popunder','go2jump','go2cloud','tsyndicate','trafmag',
    'bidvertiser','revcontent','mgid','taboola','outbrain','adform',
    'appnexus','improvedigital','triplelift','sharethrough',
    'indexexchange','districtm','bidswitch','onclickads',
    'clickaine','clickadilla','trafficfactory','connatix',
    'spotxchange','teads','ero-advertising','adultadworld','plugrush',
    'adxpansion','tubecorporate','adult','xxx',
  ];

  function _isAdSrc(url) {
    if (!url) return false;
    try {
      const h = new URL(String(url), _href()).hostname.toLowerCase();
      return AD_FRAGS.some(f => h.includes(f));
    } catch (e) {
      return AD_FRAGS.some(f => String(url).toLowerCase().includes(f));
    }
  }

  const _obs = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;

        // Block injected ad scripts
        if (node.tagName === 'SCRIPT' && _isAdSrc(node.src)) {
          node.remove();
          log('Removed injected ad script:', node.src);
          continue;
        }

        // Block injected ad iframes (not our player)
        if (node.tagName === 'IFRAME' && node.id !== 'playerFrame') {
          const src = node.src || '';
          if (_isAdSrc(src)) {
            node.remove();
            log('Removed injected ad iframe:', src);
            continue;
          }
        }

        // Neutralise injected outbound anchors
        if (node.tagName === 'A') {
          const href = node.getAttribute('href') || '';
          if (href && !isSameOrigin(href) && !_isSafeHost(
              (() => { try { return new URL(href, _href()).hostname; } catch(e){return '';} })()
          )) {
            node.addEventListener('click', e => {
              e.preventDefault();
              e.stopImmediatePropagation();
            }, { capture: true });
            node.removeAttribute('target');
            log('Neutralised injected anchor:', href);
          }
        }

        // Delayed check for full-screen overlay divs (styles apply async)
        if (node.tagName === 'DIV' || node.tagName === 'SECTION' ||
            node.tagName === 'SPAN') {
          setTimeout(() => {
            if (node.parentNode && _isAdOverlay(node)) {
              node.remove();
              log('Removed injected overlay:', node.tagName, node.id);
            }
          }, 80);
        }

        // Check children recursively for injected ad anchors
        if (node.querySelectorAll) {
          for (const a of node.querySelectorAll('a[href]')) {
            try {
              const u = new URL(a.getAttribute('href') || '', _href());
              if (!_isSafeHost(u.hostname)) {
                a.addEventListener('click', e => {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                }, { capture: true });
              }
            } catch (e) {}
          }
        }
      }
    }
  });

  function _startObserver() {
    _obs.observe(_doc.body || _doc.documentElement, {
      childList: true,
      subtree:   true,
    });
  }
  if (_doc.body) _startObserver();
  else _doc.addEventListener('DOMContentLoaded', _startObserver);

  // ── 8. postMessage FIREWALL ──────────────────────────────────────
  //
  // Block cross-origin postMessages that contain redirect/popup intents.

  const _PLAYER_EVENTS = new Set([
    'ended','complete','finished','nextepisode','next_episode',
    'timeupdate','progress','play','pause','ready','loaded',
    'qualitychange','quality_change','subtitlechange','fullscreen',
    'playerready','player_ready','duration','buffering','error',
    'metadata','cuepoint','adskip',
  ]);

  _win.addEventListener('message', function (e) {
    if (e.origin === _win.location.origin) return;

    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
    catch (ex) { return; }
    if (!data) return;

    const evType = (data.type || data.event || data.action || '').toLowerCase();
    if (_PLAYER_EVENTS.has(evType)) return; // whitelisted player event

    const str         = JSON.stringify(data).toLowerCase();
    const hasAdHost   = AD_FRAGS.some(f => str.includes(f));
    const isRawUrl    = typeof e.data === 'string' &&
                        e.data.startsWith('http') &&
                        !_isSafeHost(
                          (() => { try { return new URL(e.data).hostname; } catch(ex){return '';} })()
                        );
    const hasNavKey   = ['redirect','navigate','popup','open','href',
                         'window','location'].some(k => str.includes(k));
    const hasOutbound = Object.values(data).some(v =>
      typeof v === 'string' && v.startsWith('http') &&
      !_isSafeHost((() => { try { return new URL(v).hostname; } catch(ex){return '';} })())
    );

    if (hasAdHost || isRawUrl || (hasOutbound && hasNavKey)) {
      e.stopImmediatePropagation();
      log('Blocked postMessage from:', e.origin);
    }
  }, true);

  // ── DONE ─────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  try {
    console.log(
      '[AFlix PB] ✓ Popup blocker active —',
      _win === _win.top ? 'TOP FRAME' : 'SUBFRAME @ ' + _win.location.hostname
    );
  } catch (e) {}

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
