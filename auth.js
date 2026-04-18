/* ══════════════════════════════════════════════════════════════
   AFlix Auth — auth.js
   ──────────────────────────────────────────────────────────────
   Drop-in login screen. Add ONE line to index.html <head>:
     <script src="auth.js"><\/script>

   HOW IT WORKS:
   1. On load, checks sessionStorage for a valid auth token.
      If found → app loads normally.
   2. If not authed → hides the app body, injects the login UI.
   3. User enters username + password.
   4. auth.js fetches aflix-config.json, finds the matching
      user entry, and computes SHA-256(username:password).
   5. If the computed hash matches the stored hash → auth passes,
      session token written, app body revealed.
   6. Session lasts until the tab/browser is closed.

   MASTER SECRET — must match aflix-keygen.html exactly.
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── CONFIG ──────────────────────────────────────────────── */
  const MASTER_SECRET   = 'CHANGE-THIS-TO-A-LONG-RANDOM-SECRET-STRING-KEEP-PRIVATE';
  const CONFIG_URL      = './aflix-config.json';
  const SESSION_KEY     = '_aflixAuth';
  const SESSION_EXPIRY  = 12 * 60 * 60 * 1000; // 12 hours in ms
  const MAX_ATTEMPTS    = 5;
  const LOCKOUT_MS      = 15 * 60 * 1000; // 15-minute lockout after 5 failures

  /* ─── SESSION CHECK ───────────────────────────────────────── */
  function isSessionValid() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      const { expiry } = JSON.parse(raw);
      return Date.now() < expiry;
    } catch { return false; }
  }

  function writeSession(username) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      user:   username,
      expiry: Date.now() + SESSION_EXPIRY
    }));
  }

  // Already authed this session → do nothing
  if (isSessionValid()) return;

  /* ─── CRYPTO HELPERS ──────────────────────────────────────── */
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  /* ─── BLOCK APP UNTIL AUTHED ──────────────────────────────── */
  // Immediately hide the page content so nothing is visible during load
  const _blockStyle = document.createElement('style');
  _blockStyle.id = '_aflixAuthBlock';
  _blockStyle.textContent = 'body > *:not(#_aflixLoginRoot) { display: none !important; }';
  document.head.appendChild(_blockStyle);

  /* ─── BUILD LOGIN UI ──────────────────────────────────────── */
  function buildUI() {
    const root = document.createElement('div');
    root.id = '_aflixLoginRoot';
    root.innerHTML = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap');

        #_aflixLoginRoot {
          position: fixed; inset: 0;
          background: #070708;
          display: flex; align-items: center; justify-content: center;
          z-index: 999999;
          font-family: 'Syne', sans-serif;
          padding: 1.5rem;
        }

        #_aflixLoginRoot::before {
          content: '';
          position: fixed; inset: 0;
          background-image:
            linear-gradient(rgba(232,25,44,.035) 1px, transparent 1px),
            linear-gradient(90deg, rgba(232,25,44,.035) 1px, transparent 1px);
          background-size: 44px 44px;
          animation: _agrid 24s linear infinite;
          pointer-events: none;
        }
        @keyframes _agrid { to { background-position: 44px 44px; } }

        #_aflixLoginRoot::after {
          content: '';
          position: fixed;
          width: 700px; height: 700px;
          bottom: -300px; right: -200px;
          background: radial-gradient(circle, rgba(232,25,44,.06) 0%, transparent 65%);
          pointer-events: none;
        }

        ._alCard {
          width: 100%; max-width: 400px;
          background: #0f0f11;
          border: 1px solid rgba(232,25,44,.15);
          border-radius: 18px;
          padding: 2.5rem 2rem;
          position: relative;
          box-shadow: 0 0 80px rgba(232,25,44,.06), 0 32px 64px rgba(0,0,0,.7);
          animation: _aslide .5s cubic-bezier(.16,1,.3,1) both;
        }
        @keyframes _aslide {
          from { opacity:0; transform: translateY(28px); }
          to   { opacity:1; transform: translateY(0); }
        }

        ._alCorner {
          position: absolute; top: 14px; right: 14px;
          width: 7px; height: 7px;
          border-top: 2px solid #e8192c; border-right: 2px solid #e8192c;
          opacity: .45;
        }
        ._alCornerBl {
          top:auto; right:auto; bottom:14px; left:14px;
          border-top:none; border-right:none;
          border-bottom: 2px solid #e8192c; border-left: 2px solid #e8192c;
        }

        ._alLogo {
          display: flex; align-items: center; gap: .65rem;
          margin-bottom: 2rem;
        }
        ._alMark {
          width: 38px; height: 38px;
          background: #e8192c;
          border-radius: 9px;
          display: flex; align-items: center; justify-content: center;
          font-weight: 800; font-size: .85rem; color: #fff;
          letter-spacing: -.5px; flex-shrink: 0;
          box-shadow: 0 0 20px rgba(232,25,44,.4);
        }
        ._alName { font-size: 1.3rem; font-weight: 800; color: #f0f0f0; }
        ._alSub { font-size: .7rem; color: #555; margin-left: auto; font-family: 'DM Sans', sans-serif; }

        ._alTitle { font-size: 1.4rem; font-weight: 800; color: #f0f0f0; margin-bottom: .3rem; }
        ._alDesc { font-size: .78rem; color: #555; margin-bottom: 1.8rem; line-height: 1.5; font-family: 'DM Sans', sans-serif; }

        ._alLabel {
          display: block;
          font-size: .65rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: .1em;
          color: #555; margin-bottom: .45rem;
        }
        ._alField { margin-bottom: 1.1rem; position: relative; }

        ._alInput {
          width: 100%;
          background: #18181c;
          border: 1px solid rgba(255,255,255,.07);
          border-radius: 9px;
          padding: .75rem 1rem;
          color: #f0f0f0;
          font-family: 'DM Sans', sans-serif;
          font-size: .92rem;
          outline: none;
          transition: border-color .2s, box-shadow .2s;
          -webkit-appearance: none;
        }
        ._alInput:focus {
          border-color: rgba(232,25,44,.45);
          box-shadow: 0 0 0 3px rgba(232,25,44,.07);
        }
        ._alInput::placeholder { color: #333; }
        ._alInput._err { border-color: rgba(232,25,44,.6); }

        ._alEye {
          position: absolute; right: .9rem; top: 50%; transform: translateY(-50%);
          background: none; border: none; cursor: pointer;
          color: #444; font-size: .85rem; line-height: 1;
          transition: color .2s; padding: 0;
        }
        ._alEye:hover { color: #888; }

        ._alBtn {
          width: 100%; background: #e8192c; color: #fff;
          border: none; border-radius: 9px;
          padding: .85rem; margin-top: .4rem;
          font-family: 'Syne', sans-serif;
          font-size: .9rem; font-weight: 700;
          cursor: pointer;
          transition: background .2s, box-shadow .2s, transform .1s;
          position: relative; overflow: hidden;
        }
        ._alBtn:hover:not(:disabled) {
          background: #ff3347;
          box-shadow: 0 0 24px rgba(232,25,44,.4);
        }
        ._alBtn:active:not(:disabled) { transform: scale(.98); }
        ._alBtn:disabled { background: #2a2a2e; color: #555; cursor: not-allowed; }
        ._alBtn._loading::after {
          content: '';
          position: absolute; inset: 0;
          background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,.12) 50%, transparent 100%);
          animation: _ashim 1s infinite;
        }
        @keyframes _ashim {
          from { transform: translateX(-100%); }
          to   { transform: translateX(100%); }
        }

        ._alError {
          background: rgba(232,25,44,.08);
          border: 1px solid rgba(232,25,44,.25);
          border-radius: 8px;
          padding: .65rem .9rem;
          font-size: .78rem; color: #ff6b7a;
          margin-top: 1rem;
          font-family: 'DM Sans', sans-serif;
          display: none; line-height: 1.4;
        }
        ._alError.show { display: block; animation: _afade .25s ease; }
        @keyframes _afade { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }

        ._alFooter {
          margin-top: 1.5rem;
          font-size: .7rem; color: #333;
          text-align: center; line-height: 1.5;
          font-family: 'DM Sans', sans-serif;
        }

        ._alAttempts {
          font-size: .68rem; color: #555;
          text-align: right; margin-top: .3rem;
          font-family: 'DM Sans', sans-serif;
          min-height: 1em;
        }
      </style>

      <div class="_alCard">
        <div class="_alCorner"></div>
        <div class="_alCorner _alCornerBl"></div>

        <div class="_alLogo">
          <div class="_alMark">AF</div>
          <span class="_alName">AFlix</span>
          <span class="_alSub">Private Access</span>
        </div>

        <div class="_alTitle">Sign in</div>
        <p class="_alDesc">This is a private app. Contact the owner to get your credentials.</p>

        <div class="_alField">
          <label class="_alLabel" for="_alU">Username</label>
          <input class="_alInput" type="text" id="_alU" placeholder="your username"
                 autocomplete="username" spellcheck="false" autocorrect="off" autocapitalize="off">
        </div>

        <div class="_alField">
          <label class="_alLabel" for="_alP">Password</label>
          <input class="_alInput" type="password" id="_alP" placeholder="your password"
                 autocomplete="current-password">
          <button class="_alEye" type="button" id="_alEyeBtn" onclick="_aflixTogglePw()" title="Show/hide">👁</button>
        </div>

        <div class="_alAttempts" id="_alAttempts"></div>

        <button class="_alBtn" id="_alBtn" onclick="_aflixLogin()">Sign In</button>

        <div class="_alError" id="_alErr"></div>

        <div class="_alFooter">Don't have access? Reach out to the owner to get your account set up.</div>
      </div>
    `;
    document.body.appendChild(root);

    // Enter key submits
    root.querySelectorAll('._alInput').forEach(inp => {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') window._aflixLogin(); });
    });
  }

  /* ─── LOCKOUT STATE ───────────────────────────────────────── */
  function getAttemptState() {
    try {
      const raw = sessionStorage.getItem('_aflixAttempts');
      return raw ? JSON.parse(raw) : { count: 0, lockedUntil: 0 };
    } catch { return { count: 0, lockedUntil: 0 }; }
  }
  function saveAttemptState(s) {
    sessionStorage.setItem('_aflixAttempts', JSON.stringify(s));
  }
  function updateAttemptsUI() {
    const el = document.getElementById('_alAttempts');
    if (!el) return;
    const s = getAttemptState();
    if (s.count > 0 && s.count < MAX_ATTEMPTS) {
      el.textContent = `${MAX_ATTEMPTS - s.count} attempt${MAX_ATTEMPTS - s.count === 1 ? '' : 's'} remaining`;
    } else {
      el.textContent = '';
    }
  }

  /* ─── SHOW ERROR ──────────────────────────────────────────── */
  function showError(msg) {
    const el = document.getElementById('_alErr');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    document.getElementById('_alU')?.classList.toggle('_err', true);
    document.getElementById('_alP')?.classList.toggle('_err', true);
  }
  function clearError() {
    const el = document.getElementById('_alErr');
    if (!el) return;
    el.classList.remove('show');
    document.getElementById('_alU')?.classList.remove('_err');
    document.getElementById('_alP')?.classList.remove('_err');
  }

  /* ─── TOGGLE PASSWORD VISIBILITY ──────────────────────────── */
  window._aflixTogglePw = function() {
    const inp = document.getElementById('_alP');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
  };

  /* ─── GRANT ACCESS ────────────────────────────────────────── */
  function grantAccess(username) {
    writeSession(username);
    sessionStorage.removeItem('_aflixAttempts');
    const root  = document.getElementById('_aflixLoginRoot');
    const block = document.getElementById('_aflixAuthBlock');
    if (root)  root.remove();
    if (block) block.remove();
    console.log('[AFlix Auth] ✓ Session started for:', username);
  }

  /* ─── MAIN LOGIN HANDLER ──────────────────────────────────── */
  window._aflixLogin = async function() {
    clearError();

    // Lockout check
    const state = getAttemptState();
    if (Date.now() < state.lockedUntil) {
      const mins = Math.ceil((state.lockedUntil - Date.now()) / 60000);
      showError(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
      return;
    }

    const username = (document.getElementById('_alU')?.value || '').trim().toLowerCase();
    const password = (document.getElementById('_alP')?.value || '').trim();

    if (!username || !password) {
      showError('Please enter both username and password.');
      return;
    }

    const btn = document.getElementById('_alBtn');
    if (btn) { btn.disabled = true; btn.classList.add('_loading'); btn.textContent = 'Signing in…'; }

    try {
      // Fetch config to get users array
      const res  = await fetch(CONFIG_URL + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load config.');
      const cfg  = await res.json();
      const users = cfg.users || [];

      if (users.length === 0) {
        showError('No users configured. Add user entries to aflix-config.json.');
        return;
      }

      // Find user (case-insensitive username match)
      const userEntry = users.find(u => (u.username || '').toLowerCase() === username);

      if (!userEntry) {
        // Unknown username — same error as bad password (no enumeration)
        recordFailure(state, username);
        return;
      }

      // Recompute verification hash: SHA-256(username:password)
      const computedHash = await sha256(`${username}:${password}`);

      if (computedHash === userEntry.hash) {
        grantAccess(username);
      } else {
        recordFailure(state, username);
      }
    } catch (err) {
      console.error('[AFlix Auth] Error:', err);
      showError('Authentication error. Check your connection and try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('_loading'); btn.textContent = 'Sign In'; }
      updateAttemptsUI();
    }
  };

  function recordFailure(state, username) {
    state.count++;
    if (state.count >= MAX_ATTEMPTS) {
      state.lockedUntil = Date.now() + LOCKOUT_MS;
      state.count = 0;
      saveAttemptState(state);
      showError(`Too many failed attempts. Access locked for 15 minutes.`);
    } else {
      saveAttemptState(state);
      showError(`Incorrect username or password.`);
    }
    console.warn('[AFlix Auth] Failed attempt for:', username);
  }

  /* ─── INIT ────────────────────────────────────────────────── */
  if (document.body) {
    buildUI();
    updateAttemptsUI();
  } else {
    document.addEventListener('DOMContentLoaded', () => { buildUI(); updateAttemptsUI(); });
  }

})();
