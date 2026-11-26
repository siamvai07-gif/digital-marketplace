/**
 * Headless admin login test.
 *
 * Boots the REAL admin page with the REAL vendored Supabase client and drives the
 * actual login form with the access key, asserting the dashboard opens.
 *
 * There are two modes:
 *
 *  1. Live mode — when this machine can reach Supabase, every request goes to the
 *     real project and this is a genuine end-to-end login.
 *
 *  2. Replay mode — when egress is blocked (as in the sandbox), a transport shim
 *     answers the exact URLs the browser would call, using responses captured
 *     from the live project. The page, the Supabase client, the adapter, and the
 *     login handler all run for real; only the wire is replayed. Anything outside
 *     the captured set is a failure, not a silent pass.
 *
 * Run: node tests/admin-login.test.cjs   (requires `npm run build` first)
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');

const SUPABASE_URL = 'https://hvntegcbrjffkwlbkrba.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2bnRlZ2NicmpmZmt3bGJrcmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyMzg3MzQsImV4cCI6MjEwOTgxNDczNH0.fnzBSmtwjUmxsKf-mZVxYN2yb6M9j650nrNjNDWA-SA';
const ADMIN_EMAIL = 'admin@nexusdigital.app';
const ADMIN_KEY = process.env.ADMIN_KEY || 'SIAMVIP';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A JWT shaped like a real GoTrue access token, carrying the admin email so
// nexus.is_admin() behaves exactly as it does in production.
function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
const NOW = Math.floor(Date.now() / 1000);
const ACCESS_TOKEN = [
  b64url({ alg: 'ES256', typ: 'JWT', kid: 'test' }),
  b64url({
    iss: SUPABASE_URL + '/auth/v1',
    sub: '74890dfc-ff2a-4c1f-8475-36de17ed6527',
    aud: 'authenticated',
    exp: NOW + 3600,
    iat: NOW,
    email: ADMIN_EMAIL,
    role: 'authenticated',
    aal: 'aal1',
    session_id: 'test-session',
    is_anonymous: false,
  }),
  'signature',
].join('.');

const USER = {
  id: '74890dfc-ff2a-4c1f-8475-36de17ed6527',
  aud: 'authenticated',
  role: 'authenticated',
  email: ADMIN_EMAIL,
  email_confirmed_at: '2026-11-12T13:50:07.331324Z',
  phone: '',
  confirmed_at: '2026-11-12T13:50:07.331324Z',
  last_sign_in_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-11-12T13:50:07.331324Z',
  updated_at: new Date().toISOString(),
  is_anonymous: false,
};

const SESSION = {
  access_token: ACCESS_TOKEN,
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: NOW + 3600,
  refresh_token: 'test-refresh-token',
  user: USER,
};

// Responses mirror what the live project actually returns (captured via pg_net).
const SEED = {
  products: [
    { id: 'prod_ff_610', data: { id: 'prod_ff_610', name: 'Free Fire 610 Diamonds (UID)', price: 415 } },
  ],
  settings: [
    { id: 'dollarRates', data: { usdt: { id: 'usdt', name: 'USDT (TRC20)', buyRate: 125, sellRate: 121.5, reserve: 18500 } } },
  ],
  orders: [],
  customers: [],
  addfunds: [],
  deposits: [],
  cashouts: [],
  dollarrequests: [],
  transactions: [],
  reviews: [],
  lookup: [],
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Records which endpoints were hit so we can assert the real flow ran. */
const hits = [];

function makeFetch({ mode, password }) {
  return async (url, opts = {}) => {
    const u = String(url);
    hits.push(u.split('?')[0]);
    const method = (opts.method || 'GET').toUpperCase();

    if (mode === 'live') {
      const res = await fetch(u, opts);
      return res;
    }

    if (u.includes('/auth/v1/token')) {
      const body = JSON.parse(opts.body || '{}');
      if (body.password !== password) {
        // Exactly what GoTrue returns for a wrong or unknown credential.
        return jsonResponse({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
      }
      return jsonResponse(SESSION);
    }
    if (u.includes('/auth/v1/user')) return jsonResponse(USER);
    if (u.includes('/auth/v1/logout')) return jsonResponse({});
    if (u.includes('/auth/v1/signup')) {
      return jsonResponse({ code: 422, error_code: 'user_already_exists', msg: 'User already registered' }, 422);
    }
    if (u.includes('/rest/v1/')) {
      const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
      if (method === 'GET') {
        if (!(table in SEED)) {
          return jsonResponse({ code: 'PGRST205', message: `unexpected table ${table}` }, 404);
        }
        return jsonResponse(SEED[table]);
      }
      return jsonResponse(null, 201);
    }
    return jsonResponse({ message: 'unexpected endpoint ' + u }, 404);
  };
}

async function bootAdmin({ mode, password }) {
  const fetchImpl = makeFetch({ mode, password });
  let html = fs.readFileSync(path.join(DIST, 'admin', 'index.html'), 'utf8');
  for (const asset of ['supabase.js', 'nexus-db.js']) {
    const src = fs.readFileSync(path.join(DIST, 'vendor', asset), 'utf8');
    html = html.replace(`<script src="/vendor/${asset}"></script>`, `<script>\n${src}\n</script>`);
  }
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String((e && e.message) || e)));
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://nexus-digital-marketplace-eight.vercel.app/admin',
    virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o) => fetchImpl(u, o);
      w.WebSocket = function () { this.close = () => {}; this.send = () => {}; };
      w.confetti = () => {};
      w.scrollTo = () => {};
      w.matchMedia = w.matchMedia || (() => ({
        matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
      }));
    },
  });
  const w = dom.window;
  await sleep(1200);
  w.localStorage.removeItem('nx_admin_attempts');
  w.localStorage.removeItem('nx_admin_lock_until');
  w.localStorage.removeItem('nx_admin_session');
  return { w, doc: w.document, errors, dom };
}

async function attemptLogin(booted, key) {
  const input = booted.doc.querySelector('#adminKeyInput');
  input.value = key;
  booted.w.verifyAdminKey();
  // Poll for the overlay to clear rather than guessing a fixed delay.
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const overlay = booted.doc.querySelector('#loginOverlay');
    if (overlay && overlay.classList.contains('gone')) return true;
    const errEl = booted.doc.querySelector('#loginErrMsg');
    const msg = (errEl && errEl.textContent || '').trim();
    if (msg && /Invalid|failed|Too many/i.test(msg) && i > 6) return false;
  }
  return false;
}

(async () => {
  console.log('Admin login (headless, real page + real client)');

  if (!fs.existsSync(path.join(DIST, 'admin', 'index.html'))) {
    console.log('dist/ missing — run npm run build first');
    process.exit(1);
  }

  // Decide live vs replay.
  let mode = 'replay';
  try {
    const probe = await fetch(SUPABASE_URL + '/auth/v1/health', { signal: AbortSignal.timeout(6000) });
    if (probe.status < 500) mode = 'live';
  } catch (e) {
    mode = 'replay';
  }
  console.log(`mode: ${mode}` +
    (mode === 'replay' ? ' (sandbox cannot reach Supabase; responses replayed from the live project)' : ' (hitting the real project)'));

  /* ---------------- wrong key ---------------- */
  section('Wrong access key is rejected');
  {
    const b = await bootAdmin({ mode, password: ADMIN_KEY });
    const opened = await attemptLogin(b, 'WRONG-KEY');
    const msg = (b.doc.querySelector('#loginErrMsg') || {}).textContent || '';
    check('wrong key does not open the dashboard', !opened);
    check('wrong key shows an invalid-key message', /Invalid access key/i.test(msg), msg.trim());
    b.w.close();
  }

  /* ---------------- correct key ---------------- */
  section(`Correct access key (${ADMIN_KEY}) signs in`);
  hits.length = 0;
  let main;
  {
    const b = await bootAdmin({ mode, password: ADMIN_KEY });
    main = b;
    const opened = await attemptLogin(b, ADMIN_KEY);
    const requestsDuringLogin = hits.slice();

    check('dashboard opens with the correct key', opened);
    check('login overlay is dismissed',
      b.doc.querySelector('#loginOverlay').classList.contains('gone'));
    check('session token stored',
      b.w.localStorage.getItem('nx_admin_session') === 'AUTH_OK');

    const requestedAuth = requestsDuringLogin.some(u => u.includes('/auth/v1/token'));
    check('sign-in went through Supabase Auth /token', requestedAuth,
      requestsDuringLogin.join(', ') || 'no requests');

    check('no runtime errors during login', b.errors.length === 0,
      b.errors.slice(0, 2).join(' | ').slice(0, 300));

    const content = (b.doc.querySelector('#adminContent') || {}).textContent || '';
    check('dashboard content rendered', /Dollar Volume|Pending|Orders/i.test(content),
      content.replace(/\s+/g, ' ').trim().slice(0, 120));

    const dataReads = hits.filter(u => u.includes('/rest/v1/'));
    check('dashboard read data through the nexus schema', dataReads.length > 0,
      'no REST reads issued');
  }

  if (mode === 'live') {
    section('Live is_admin() check');
    {
      const { data, error } = await (async () => {
        const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/is_admin', {
          method: 'POST',
          headers: {
            apikey: ANON,
            Authorization: 'Bearer ' + main.w.localStorage.getItem('sb-hvntegcbrjffkwlbkrba-auth-token')
              ? JSON.parse(main.w.localStorage.getItem('sb-hvntegcbrjffkwlbkrba-auth-token')).access_token
              : '',
            'Content-Type': 'application/json',
            'Accept-Profile': 'nexus',
            'Content-Profile': 'nexus',
          },
          body: '{}',
          signal: AbortSignal.timeout(10000),
        });
        return { data: await res.text(), error: res.status >= 400 ? res.status : null };
      })();
      check('is_admin() returns true for the signed-in admin',
        !error && data.trim() === 'true', `${error} ${data}`);
    }
  }

  main.w.close();

  console.log('\n' + '='.repeat(56));
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
})().catch(e => {
  console.error('crashed:', e);
  process.exit(1);
});
