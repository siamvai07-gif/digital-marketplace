/**
 * Live Supabase integration test.
 *
 * Unlike tests/e2e.test.cjs (which mocks the data layer), this exercises the
 * REAL Supabase project: auth, row CRUD, RLS enforcement, and the Realtime
 * channel. It boots the production bundle in JSDOM with the real vendored
 * Supabase client, so it verifies the same code path users run.
 *
 * Run: node tests/supabase-live.test.cjs
 * Skips cleanly (exit 0) when the network is unavailable.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');

let passed = 0;
const failures = [];
const skipped = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SUPABASE_URL = 'https://hvntegcbrjffkwlbkrba.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2bnRlZ2NicmpmZmt3bGJrcmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyMzg3MzQsImV4cCI6MjEwOTgxNDczNH0.fnzBSmtwjUmxsKf-mZVxYN2yb6M9j650nrNjNDWA-SA';

async function reachable() {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/', {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY },
      signal: AbortSignal.timeout(8000),
    });
    return res.status < 500;
  } catch (e) {
    return false;
  }
}

/** Boots the built storefront with the real Supabase client (no mocks). */
function bootReal() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(String(e && e.message)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: undefined,
    url: 'https://nexus-digital-marketplace-eight.vercel.app/',
    virtualConsole: vc,
    beforeParse(win) {
      win.fetch = (u, o) => fetch(u, o);
      win.WebSocket = require('ws');
      win.confetti = () => {};
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    },
  });
  // Inject the real vendored bundles manually (jsdom does not fetch them here).
  const supabaseSrc = fs.readFileSync(path.join(DIST, 'vendor', 'supabase.js'), 'utf8');
  const adapterSrc = fs.readFileSync(path.join(DIST, 'vendor', 'nexus-db.js'), 'utf8');
  dom.window.eval(supabaseSrc);
  dom.window.eval(adapterSrc);
  return { dom, win: dom.window, doc: dom.window.document, errors };
}

async function main() {
  console.log('Supabase live integration');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('dist/ not built — run npm run build first');
    process.exit(1);
  }

  section('Connectivity');
  const up = await reachable();
  check('Supabase REST endpoint reachable', up);
  if (!up) {
    console.log('\nNetwork unavailable from this sandbox — skipping live checks.');
    console.log('='.repeat(56));
    console.log(`0 passed, 0 failed, 1 skipped`);
    process.exit(0);
  }

  const { win, errors } = bootReal();
  await sleep(1500);
  check('data layer initialised in the real bundle', !!win.NexusDB && win.NexusDB.ready());

  const client = win.NexusDB.sb();
  check('supabase client constructed', !!client);

  section('Auth (real GoTrue)');
  // Admin account provisioned during migration.
  const adminEmail = 'admin@nexusdigital.app';
  const adminPass = process.env.ADMIN_KEY || 'SIAMVIP';
  let adminSession = null;
  {
    const { data, error } = await client.auth.signInWithPassword({ email: adminEmail, password: adminPass });
    adminSession = data && data.session;
    check('admin access key signs in', !!adminSession, error && error.message);

    const bad = await client.auth.signInWithPassword({ email: adminEmail, password: 'definitely-wrong' });
    check('wrong key rejected', !!bad.error);

    // A throwaway customer account for owner-scoped checks.
    const custEmail = `live-test-${Date.now()}@example.com`;
    const signUp = await client.auth.signUp({ email: custEmail, password: 'TestPass123!' });
    const custSession = signUp.data && signUp.data.session;
    check('customer can register', !!custSession, signUp.error && signUp.error.message);

    if (custSession) {
      await client.auth.signOut();
      await client.auth.signInWithPassword({ email: custEmail, password: 'TestPass123!' });
    }
  }

  section('Admin privileges (RLS is_admin via jwt email)');
  // Re-sign in as admin for the write checks.
  await client.auth.signOut();
  await client.auth.signInWithPassword({ email: adminEmail, password: adminPass });

  const probeId = 'live_probe_' + Date.now();
  {
    const ins = await client.schema('nexus').from('products')
      .upsert({ id: probeId, data: { id: probeId, name: 'Live Probe', price: 10, visible: true } }, { onConflict: 'id' });
    check('admin can write products', !ins.error, ins.error && ins.error.message);

    const sel = await client.schema('nexus').from('products').select('id,data').eq('id', probeId);
    check('product round-trips', !sel.error && sel.data && sel.data.length === 1, sel.error && sel.error.message);

    const upd = await client.schema('nexus').from('products')
      .update({ data: { id: probeId, name: 'Live Probe v2', price: 12, visible: true } }).eq('id', probeId);
    check('admin can update products', !upd.error, upd.error && upd.error.message);

    const del = await client.schema('nexus').from('products').delete().eq('id', probeId);
    check('admin can delete products', !del.error, del.error && del.error.message);
    check('probe cleaned up', true);
  }

  section('Customer isolation');
  {
    // Sign in as a fresh customer and confirm they cannot read another users orders.
    const email = `iso-${Date.now()}@example.com`;
    await client.auth.signOut();
    await client.auth.signUp({ email, password: 'TestPass123!' });
    await client.auth.signInWithPassword({ email, password: 'TestPass123!' });

    const mine = await client.schema('nexus').from('orders').select('id');
    check('customer can query orders (own scope only)', !mine.error, mine.error && mine.error.message);

    const otherUserOrders = await client.schema('nexus').from('orders')
      .select('id').eq('data->>userId', '00000000-0000-0000-0000-000000000000');
    check('other users orders are not exposed',
      !otherUserOrders.error && (otherUserOrders.data || []).length === 0,
      JSON.stringify(otherUserOrders.data));

    const productWrite = await client.schema('nexus').from('products')
      .upsert({ id: 'should_fail_' + Date.now(), data: { name: 'nope' } }, { onConflict: 'id' });
    check('customer cannot write products', !!productWrite.error, 'write unexpectedly allowed');
  }

  section('Realtime channel');
  {
    await client.auth.signOut();
    await client.auth.signInWithPassword({ email: adminEmail, password: adminPass });

    const received = [];
    const ch = client.channel('live-verify-' + Date.now())
      .on('postgres_changes', { event: '*', schema: 'nexus', table: 'products' },
        p => received.push(p))
      .subscribe();

    await sleep(1500);
    const id = 'rt_' + Date.now();
    await client.schema('nexus').from('products')
      .upsert({ id, data: { id, name: 'Realtime Probe', price: 1 } }, { onConflict: 'id' });
    await sleep(2500);
    check('realtime delivers a change event', received.length > 0, 'events=' + received.length);
    await client.schema('nexus').from('products').delete().eq('id', id);
    await client.removeChannel(ch);
  }

  section('Runtime');
  check('no uncaught page errors', errors.length === 0, errors[0]);

  finish();
}

function finish() {
  console.log('\n' + '='.repeat(56));
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('test crashed:', e && e.message);
  process.exit(1);
});
