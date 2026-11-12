/**
 * Unit tests for the Supabase data adapter (public/vendor/nexus-db.js).
 *
 * Runs the real adapter against a fake PostgREST client that records every
 * write, so we can assert the Firebase -> Postgres path mapping is correct for
 * collection writes, nested paths, queries, and deletes.
 *
 * Run: node tests/adapter.test.cjs
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, want ${e}`);
}
function section(t) { console.log('\n' + t); }

/* ---------------- fake PostgREST ---------------- */
const tables = Object.create(null);
const writes = [];

function builder(table, op) {
  const st = { type: op, payload: null, filters: [], single: null };
  const api = {
    select() { st.type = 'select'; return api; },
    upsert(rows) { st.type = 'upsert'; st.payload = Array.isArray(rows) ? rows : [rows]; return api; },
    delete() { st.type = 'delete'; return api; },
    update(rows) { st.type = 'update'; st.payload = rows; return api; },
    eq(col, val) { st.filters.push([col, val]); return api; },
    single() { st.single = true; return api; },
    then(resolve, reject) { return exec(table, st).then(resolve, reject); },
    catch(fn) { return api.then(undefined, fn); },
  };
  return api;
}

async function exec(table, st) {
  if (!tables[table]) tables[table] = Object.create(null);
  const store = tables[table];
  writes.push({ table, op: st.type, payload: st.payload });

  if (st.type === 'select') {
    let rows = Object.keys(store).map(id => ({ id, data: store[id] }));
    for (const [col, val] of st.filters) {
      rows = rows.filter(r => String(r[col]) === String(val));
    }
    return { data: rows, error: null };
  }
  if (st.type === 'upsert') {
    for (const row of st.payload) store[row.id] = row.data;
    return { data: null, error: null };
  }
  if (st.type === 'delete') {
    for (const [col, val] of st.filters) delete store[val];
    return { data: null, error: null };
  }
  if (st.type === 'update') {
    for (const [col, val] of st.filters) store[val] = { ...(store[val] || {}), ...st.payload };
    return { data: null, error: null };
  }
  return { data: null, error: null };
}

const fakeClient = {
  schema: () => ({ from: t => builder(t, 'select') }),
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
  auth: {
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithPassword: async () => ({ data: { user: { id: 'u1', email: 'a@b.c' }, session: { user: { id: 'u1', email: 'a@b.c' } } }, error: null }),
    signUp: async () => ({ data: { user: { id: 'guest-id', email: 'g@guest' }, session: { user: { id: 'guest-id' } } }, error: null }),
    signOut: async () => ({ error: null }),
  },
  realtime: {},
};

/* ---------------- load the adapter ---------------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'public/vendor/nexus-db.js'), 'utf8');
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Promise,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  Date,
  Error,
  Set,
  Map,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.supabase = { createClient: () => fakeClient };
sandbox.document = { addEventListener() {}, visibilityState: 'visible' };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const { DB } = sandbox.window.NexusDB;

(async () => {
  console.log('Supabase adapter');

  section('Path mapping');
  const p = sandbox.window.NexusDB._parsePath;
  eq('addFunds maps to the lowercased table', p('addFunds/x1').table, 'addfunds');
  eq('dollarRequests maps to dollarrequests', p('dollarRequests/x1').table, 'dollarrequests');
  eq('collection path has no rowId', p('products').rowId, null);
  eq('row path yields rowId', p('orders/abc').rowId, 'abc');
  eq('field path yields segments', p('customers/u1/walletCoins').fieldSegs, ['walletCoins']);

  section('Collection writes');
  await DB.ref('products').update({
    prod_a: { name: 'A', price: 10 },
    prod_b: { name: 'B', price: 20 },
  });
  eq('one row per product, not a single root row',
    Object.keys(tables.products).sort(), ['prod_a', 'prod_b']);
  eq('product payload preserved', tables.products.prod_a, { name: 'A', price: 10 });

  await DB.ref('reviews').set({ rev_1: { name: 'R1' }, rev_2: { name: 'R2' } });
  eq('reviews set() writes both rows', Object.keys(tables.reviews).sort(), ['rev_1', 'rev_2']);

  section('Singleton settings');
  await DB.ref('settings/dollarRates').set({ usdt: { buyRate: 125 } });
  eq('settings section is one row keyed by section name',
    Object.keys(tables.settings), ['dollarRates']);
  await DB.ref('settings/heroVideo').set({ url: 'x' });
  eq('second section becomes its own row',
    Object.keys(tables.settings).sort(), ['dollarRates', 'heroVideo']);
  eq('first section untouched', tables.settings.dollarRates, { usdt: { buyRate: 125 } });

  section('Row and nested field writes');
  await DB.ref('customers/u1').set({ name: 'Cust', walletCoins: 500 });
  eq('row written', tables.customers.u1, { name: 'Cust', walletCoins: 500 });
  await DB.ref('customers/u1/walletCoins').set(900);
  eq('nested field merged, siblings kept',
    tables.customers.u1, { name: 'Cust', walletCoins: 900 });

  section('Lookup index');
  await DB.ref('lookup/email/test@example.com').set({ uid: 'u1' });
  eq('lookup sub-collection keyed by type+identity',
    Object.keys(tables.lookup), ['email:test@example.com']);
  eq('lookup payload', tables.lookup['email:test@example.com'], { uid: 'u1' });

  section('Push');
  const ref = DB.ref('orders').push({ total: 100 });
  check('push invents a key', typeof ref.key === 'string' && ref.key.length > 5, ref.key);
  await ref;
  check('pushed row persisted', !!tables.orders[ref.key], ref.key);
  eq('pushed payload', tables.orders[ref.key], { total: 100 });

  section('Queries');
  const snap = await DB.ref('orders').orderByChild('total').equalTo(100).once('value');
  check('orderByChild + equalTo matches', snap.exists() && Object.keys(snap.val()).length === 1);
  const miss = await DB.ref('orders').orderByChild('total').equalTo(999).once('value');
  check('non-matching query returns empty', !miss.exists());
  const all = await DB.ref('orders').once('value');
  check('unfiltered query returns all rows', Object.keys(all.val()).length === 1);

  section('Deletes');
  await DB.ref('products/prod_a').remove();
  check('row removed', !tables.products.prod_a);
  check('sibling survives', !!tables.products.prod_b);
  const before = writes.length;
  await DB.ref('customers/nobody/nickname').remove();
  check('deleting a field of a missing row writes nothing', writes.length === before);

  section('Reads');
  const prodSnap = await DB.ref('products').once('value');
  eq('collection read shape', Object.keys(prodSnap.val()), ['prod_b']);
  const missing = await DB.ref('products/nope').once('value');
  check('missing row reads as empty', !missing.exists() && missing.val() === null);

  section('Auth adapter');
  const auth = sandbox.window.NexusDB.auth();
  const cred = await auth.signInWithEmailAndPassword('a@b.c', 'pw');
  check('email sign-in maps to a Firebase-shaped user', cred.user.uid === 'u1' && cred.user.email === 'a@b.c');
  const guest = await auth.signInAsGuest();
  check('guest sign-in provisions a real account', !!guest.uid && /@guest\.nexusdigital\.app$/.test(guest.email), guest.email);
  let anonCode = null;
  try { await auth.signInAnonymously(); } catch (e) { anonCode = e.code; }
  check('anonymous auth is explicitly unavailable, not silently faked', anonCode === 'auth/anonymous-disabled');

  console.log('\n' + '='.repeat(56));
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})().catch(e => {
  console.error('crashed:', e);
  process.exit(1);
});
