/**
 * Supabase data layer for NEXUS.
 *
 * The application was written against the Firebase v8 Realtime Database API
 * (DB.ref('orders').push(...), .on('value'), .transaction() ...). Rather than
 * rewrite ~90 call sites and risk breaking behaviour, this module implements
 * that same small API on top of Supabase Postgres + Realtime.
 *
 * Storage model: every top-level collection is a table in the `nexus` schema
 * with a uniform shape — (id text primary key, data jsonb, updated_at).
 * A Firebase path maps to a row whose key is the path minus the collection:
 *
 *   'orders'                     -> collection nexus.orders
 *   'orders/abc'                 -> row id 'abc'
 *   'customers/uid1/walletCoins' -> row uid1, field data.walletCoins
 *
 * This keeps arbitrary nested paths working without schema migrations.
 */

const SUPABASE_URL = 'https://hvntegcbrjffkwlbkrba.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2bnRlZ2NicmpmZmt3bGJrcmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyMzg3MzQsImV4cCI6MjEwOTgxNDczNH0.fnzBSmtwjUmxsKf-mZVxYN2yb6M9j650nrNjNDWA-SA';

// Firebase path segment -> table name (all lowercase in Postgres).
const TABLE_MAP = {
  customers: 'customers',
  orders: 'orders',
  products: 'products',
  reviews: 'reviews',
  addFunds: 'addfunds',
  addfunds: 'addfunds',
  deposits: 'deposits',
  cashouts: 'cashouts',
  dollarRequests: 'dollarrequests',
  dollarrequests: 'dollarrequests',
  transactions: 'transactions',
  settings: 'settings',
  lookup: 'lookup',
};

function tableFor(segment) {
  return TABLE_MAP[segment] || String(segment || '').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

let _client = null;
function sb() {
  if (_client) return _client;
  if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }
  return _client;
}

function ready() { return !!sb(); }

// Deep clone so callers can never mutate the shared cache.
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

/* ------------------------------------------------------------------ */
/* Row cache                                                           */
/* ------------------------------------------------------------------ */

// cache[table][rowId] = data object
const cache = Object.create(null);
// listeners[table] = [ {cb, errCb} ]
const listeners = Object.create(null);
const channels = Object.create(null);

function tableCache(t) {
  if (!cache[t]) cache[t] = Object.create(null);
  return cache[t];
}

function snapshotFor(path) {
  const { table, rowId, fieldSegs } = parsePath(path);
  const rows = tableCache(table);
  let node;
  if (rowId == null) {
    node = {};
    for (const id of Object.keys(rows)) {
      // `settings` is a key/value container: a row's id is the section name and
      // its data IS the value, so it must not gain a spurious id wrapper.
      node[id] = clone(rows[id]);
    }
  } else {
    const row = rows[rowId];
    if (row === undefined) node = null;
    else if (fieldSegs.length === 0) node = clone(row);
    else {
      node = clone(row);
      let cur = node;
      for (let i = 0; i < fieldSegs.length - 1; i++) {
        if (cur == null || typeof cur !== 'object') { cur = null; break; }
        cur = cur[fieldSegs[i]];
      }
      const last = fieldSegs[fieldSegs.length - 1];
      node = cur == null || typeof cur !== 'object' ? null : cur[last];
      if (node === undefined) node = null;
    }
  }
  return {
    val: () => clone(node),
    exists: () => node !== null && node !== undefined,
  };
}

function parsePath(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  const table = tableFor(parts[0] || '');

  // `lookup` is an index addressed as lookup/<email|phone>/<identity>. Each
  // identity is its own row, keyed `type:identity` so the two namespaces can
  // never collide.
  if (table === 'lookup' && parts.length > 2 && /^(email|phone)$/.test(parts[1])) {
    const rowId = parts[1] + ':' + parts.slice(2).join('/');
    return { table, rowId, fieldSegs: [], parts };
  }

  const rowId = parts.length > 1 ? parts[1] : null;
  const fieldSegs = parts.slice(2);
  return { table, rowId, fieldSegs, parts };
}

function notify(table) {
  const subs = listeners[table];
  if (!subs || !subs.length) return;
  for (const sub of subs.slice()) {
    try { sub.cb(snapshotFor(table + (sub.path ? '/' + sub.path : ''))); }
    catch (e) { /* listener threw; keep others alive */ }
  }
}

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

function attachChannel(table) {
  if (channels[table]) return;
  const client = sb();
  if (!client) return;
  const ch = client
    .channel('nexus-' + table)
    .on('postgres_changes', { event: '*', schema: 'nexus', table }, payload => {
      const rows = tableCache(table);
      if (payload.eventType === 'DELETE') {
        delete rows[payload.old.id];
      } else if (payload.new && payload.new.id != null) {
        rows[payload.new.id] = payload.new.data || {};
      }
      notify(table);
    })
    .subscribe();
  channels[table] = ch;
}

/* ------------------------------------------------------------------ */
/* Fetch / write                                                       */
/* ------------------------------------------------------------------ */

async function fetchTable(table, { force = false } = {}) {
  const client = sb();
  if (!client) throw new Error('supabase unavailable');
  const { data, error } = await client.schema('nexus').from(table).select('id,data');
  if (error) throw error;
  const rows = Object.create(null);
  (data || []).forEach(r => { rows[r.id] = r.data || {}; });
  cache[table] = rows;
  attachChannel(table);
  return rows;
}

// Detects whether a write is confined to a known set of scalar leaf fields,
// which lets us update those keys instead of replacing the whole row.
const SCALAR = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function isScalarMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (!keys.length) return false;
  return keys.every(k => SCALAR(obj[k]) || (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]) && isScalarMap(obj[k])));
}

function mergeDeep(base, patch) {
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

// Sets `value` at the path. Nested paths create/merge the containing row.
function setAtPath(path, value) {
  const { table, rowId, fieldSegs } = parsePath(path);
  const rows = tableCache(table);
  const id = rowId == null ? 'root' : rowId;

  let next;
  if (fieldSegs.length === 0) {
    // Collection-level write: the value is a map of rowId -> row data, so each
    // key becomes its own row. A singleton table (settings sections) still has a
    // rowId, so it never lands here.
    if (rowId == null) return writeCollection(table, value, { merge: false });
    next = value == null ? {} : clone(value);
  } else {
    const base = rows[id] || {};
    const patch = {};
    let cur = patch;
    fieldSegs.forEach((seg, i) => {
      if (i === fieldSegs.length - 1) cur[seg] = value == null ? null : clone(value);
      else { cur[seg] = {}; cur = cur[seg]; }
    });
    next = mergeDeep(base, patch);
  }

  rows[id] = next;
  const client = sb();
  if (!client) return Promise.resolve();
  return client.schema('nexus').from(table)
    .upsert({ id, data: next }, { onConflict: 'id' })
    .then(({ error }) => {
      if (error) throw error;
      notify(table);
    });
}

// Writes many rows at once, keeping the local cache in step.
function writeCollection(table, value, { merge }) {
  const client = sb();
  const rows = tableCache(table);
  const entries = value && typeof value === 'object' ? Object.entries(value) : [];
  const payload = entries.map(([id, data]) => {
    const rowData = merge ? mergeDeep(rows[id] || {}, data || {}) : clone(data || {});
    rows[id] = rowData;
    return { id, data: rowData };
  });
  if (!client || !payload.length) return Promise.resolve();
  return client.schema('nexus').from(table)
    .upsert(payload, { onConflict: 'id' })
    .then(({ error }) => {
      if (error) throw error;
      notify(table);
    });
}

function updateAtPath(path, patch) {
  const { table, rowId, fieldSegs } = parsePath(path);
  const rows = tableCache(table);
  const id = rowId == null ? 'root' : rowId;
  const base = rows[id] || {};

  let next;
  if (fieldSegs.length === 0) {
    if (rowId == null) return writeCollection(table, patch, { merge: true });
    next = mergeDeep(base, patch);
  } else {
    const wrap = {};
    let cur = wrap;
    fieldSegs.forEach((seg, i) => {
      if (i === fieldSegs.length - 1) cur[seg] = mergeDeep((base[seg] || {}), patch);
      else { cur[seg] = {}; cur = cur[seg]; }
    });
    next = mergeDeep(base, wrap);
  }

  rows[id] = next;
  const client = sb();
  if (!client) return Promise.resolve();
  return client.schema('nexus').from(table)
    .upsert({ id, data: next }, { onConflict: 'id' })
    .then(({ error }) => {
      if (error) throw error;
      notify(table);
    });
}

function removeAtPath(path) {
  const { table, rowId, fieldSegs } = parsePath(path);
  const rows = tableCache(table);
  const id = rowId == null ? 'root' : rowId;
  const client = sb();

  if (fieldSegs.length === 0) {
    delete rows[id];
    if (!client) return Promise.resolve();
    return client.schema('nexus').from(table).delete().eq('id', id)
      .then(({ error }) => { if (error) throw error; notify(table); });
  }

  if (!rows[id]) return Promise.resolve();
  const base = rows[id] || {};
  const next = clone(base);
  let cur = next;
  for (let i = 0; i < fieldSegs.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return Promise.resolve();
    cur = cur[fieldSegs[i]];
  }
  if (cur && typeof cur === 'object') delete cur[fieldSegs[fieldSegs.length - 1]];
  rows[id] = next;
  if (!client) return Promise.resolve();
  return client.schema('nexus').from(table)
    .upsert({ id, data: next }, { onConflict: 'id' })
    .then(({ error }) => { if (error) throw error; notify(table); });
}

function pushAtPath(path, value) {
  const { table, rowId } = parsePath(path);
  // push always targets a collection; an unexpected deeper path is ignored.
  const id = '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const payload = value == null ? {} : clone(value);
  const rows = tableCache(table);
  rows[id] = payload;
  const client = sb();
  const done = client
    ? client.schema('nexus').from(table).upsert({ id, data: payload }, { onConflict: 'id' })
        .then(({ error }) => { if (error) throw error; notify(table); })
    : Promise.resolve();
  const ref = new Ref(path + '/' + id);
  ref.key = id;
  // Mirror the Firebase contract: the returned reference is thenable and
  // resolves when the write lands, so `.then()` and `.catch()` both work.
  ref.then = (a, b) => done.then(a, b);
  ref.catch = b => done.catch(b);
  return ref;
}

/* ------------------------------------------------------------------ */
/* Ref                                                                 */
/* ------------------------------------------------------------------ */

function Ref(path) {
  this.path = String(path || '').replace(/^\/+|\/+$/g, '');
  this.key = this.path.split('/').pop() || null;
  this._query = null;
}

Ref.prototype.child = function (seg) {
  const r = new Ref(this.path ? this.path + '/' + seg : String(seg));
  r.key = String(seg);
  r._query = this._query;
  return r;
};

Ref.prototype.once = function (event, cb, errCb) {
  const self = this;
  const p = (async () => {
    const { table } = parsePath(self.path);
    // Always read fresh so a page load reflects other clients' writes.
    await fetchTable(table);
    return applyQuery(snapshotFor(self.path), self._query);
  })();
  const out = p.then(snap => { if (typeof cb === 'function') cb(snap); return snap; });
  if (typeof errCb === 'function') out.catch(errCb);
  return out;
};

Ref.prototype.on = function (event, cb, errCb) {
  const self = this;
  const { table, rowId, fieldSegs } = parsePath(self.path);
  if (!listeners[table]) listeners[table] = [];
  const sub = { cb, errCb, path: [rowId, ...fieldSegs].filter(Boolean).join('/') };
  listeners[table].push(sub);
  // Deliver cached data immediately, then keep it fresh.
  fetchTable(table)
    .then(() => cb(snapshotFor(self.path)))
    .catch(e => { if (errCb) errCb(e); });
  attachChannel(table);
  return cb;
};

Ref.prototype.off = function () {
  const { table, rowId, fieldSegs } = parsePath(this.path);
  const want = [rowId, ...fieldSegs].filter(Boolean).join('/');
  if (!listeners[table]) return;
  listeners[table] = listeners[table].filter(s => s.path !== want);
};

// Firebase query support. Every read is a full-table fetch plus a client-side
// filter, which is what the app does everywhere else anyway.
Ref.prototype.orderByChild = function (child) {
  this._query = Object.assign({}, this._query, { child });
  return this;
};
Ref.prototype.equalTo = function (value) {
  this._query = Object.assign({}, this._query, { equal: value });
  return this;
};
Ref.prototype.limitToLast = function (n) {
  this._query = Object.assign({}, this._query, { last: n });
  return this;
};
Ref.prototype.limitToFirst = function (n) {
  this._query = Object.assign({}, this._query, { first: n });
  return this;
};

// Narrows an already-resolved snapshot to the rows matching the query.
function applyQuery(snap, query) {
  const raw = snap.val();
  if (!query || !raw || typeof raw !== 'object') return snap;
  let entries = Object.keys(raw).map(k => [k, raw[k]]);
  if (query.child) {
    const id = String(query.child).replace(/^\//, '');
    entries = entries.filter(([, v]) => {
      let cur = v;
      for (const seg of id.split('/')) {
        if (cur == null || typeof cur !== 'object') return false;
        cur = cur[seg];
      }
      return cur !== undefined;
    });
    if (Object.prototype.hasOwnProperty.call(query, 'equal')) {
      entries = entries.filter(([, v]) => {
        let cur = v;
        for (const seg of id.split('/')) {
          if (cur == null || typeof cur !== 'object') return false;
          cur = cur[seg];
        }
        return String(cur) === String(query.equal);
      });
    }
  }
  if (query.last != null) entries = entries.slice(-query.last);
  if (query.first != null) entries = entries.slice(0, query.first);
  const out = {};
  entries.forEach(([k, v]) => { out[k] = v; });
  return { val: () => clone(out), exists: () => entries.length > 0 };
}

Ref.prototype.set = function (value) { return setAtPath(this.path, value); };
Ref.prototype.update = function (patch) { return updateAtPath(this.path, patch); };
Ref.prototype.remove = function () { return removeAtPath(this.path); };
Ref.prototype.push = function (value) { return pushAtPath(this.path, value); };

Ref.prototype.transaction = function (fn, onComplete, applyLocally) {
  const self = this;
  const { table, rowId, fieldSegs } = parsePath(this.path);
  const p = (async () => {
    await fetchTable(table);
    const snap = snapshotFor(self.path);
    const current = snap.val();
    let next = fn(current);
    if (next === undefined) {
      if (onComplete) onComplete(null, false, snap);
      return { committed: false };
    }
    if (fieldSegs.length === 0) await setAtPath(self.path, next);
    else await setAtPath(self.path, next);
    if (onComplete) onComplete(null, true, snapshotFor(self.path));
    return { committed: true };
  })();
  p.catch(e => { if (onComplete) onComplete(e, false, null); });
  return p;
};

/* ------------------------------------------------------------------ */
/* Auth (Supabase GoTrue)                                              */
/* ------------------------------------------------------------------ */

// Firebase-auth-shaped adapter so the existing call sites keep working.
function authAdapter() {
  const client = sb();
  if (!client) return null;
  const listenersAuth = [];
  let lastUser = null;

  client.auth.onAuthStateChange((event, session) => {
    const u = session && session.user
      ? { uid: session.user.id, email: session.user.email, displayName: (session.user.user_metadata || {}).name || '' }
      : null;
    lastUser = u;
    listenersAuth.forEach(cb => { try { cb(u); } catch (e) { /* ignore */ } });
  });

  return {
    get currentUser() { return lastUser; },
    onAuthStateChanged(cb) {
      listenersAuth.push(cb);
      client.auth.getSession().then(({ data }) => {
        const s = data && data.session;
        cb(s && s.user ? { uid: s.user.id, email: s.user.email, displayName: (s.user.user_metadata || {}).name || '' } : null);
      });
      return () => { const i = listenersAuth.indexOf(cb); if (i >= 0) listenersAuth.splice(i, 1); };
    },
    // No anonymous sessions: Supabase RLS is keyed on the authenticated uid.
    signInAnonymously() { return Promise.reject(Object.assign(new Error('anonymous disabled'), { code: 'auth/anonymous-disabled' })); },
    signInWithEmailAndPassword(email, password) {
      return client.auth.signInWithPassword({ email, password }).then(({ data, error }) => {
        if (error) throw Object.assign(new Error(error.message), { code: mapAuthError(error) });
        return { user: { uid: data.user.id, email: data.user.email } };
      });
    },
    createUserWithEmailAndPassword(email, password) {
      return client.auth.signUp({ email, password }).then(({ data, error }) => {
        if (error) throw Object.assign(new Error(error.message), { code: mapAuthError(error) });
        return { user: { uid: data.user && data.user.id, email } };
      });
    },
    // Guest mode: provision a real throwaway account so the session satisfies RLS.
    // Anonymous auth is disabled on this project, and a synthetic local id could
    // never pass `auth.uid()` checks.
    signInAsGuest() {
      const email = 'guest_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '@guest.nexusdigital.app';
      const password = Math.random().toString(36).slice(2) + 'G' + Date.now().toString(36);
      return client.auth.signUp({ email, password }).then(({ data, error }) => {
        if (error) throw Object.assign(new Error(error.message), { code: mapAuthError(error) });
        const u = data && data.user;
        if (!u) throw Object.assign(new Error('guest signup returned no user'), { code: 'auth/unknown' });
        localStorage.setItem('nx_guest_cred', JSON.stringify({ email, password }));
        return { uid: u.id, email };
      });
    },
    signOut() { return client.auth.signOut().then(() => undefined); },
  };
}

// Supabase GoTrue reports "Invalid login credentials" for both a wrong password
// and a non-existent account (that ambiguity is deliberate, to stop account
// enumeration). A duplicated signup says "User already registered", which is the
// only reliable signal that the account exists - the callers use it to decide
// whether a first-run admin account still needs creating.
function mapAuthError(err) {
  const m = String((err && err.message) || '').toLowerCase();
  const code = String((err && (err.code || err.error_code)) || '').toLowerCase();
  if (m.includes('already registered') || m.includes('already been registered') ||
      code.includes('user_already_exists') || code.includes('email_exists')) {
    return 'auth/email-already-in-use';
  }
  if (m.includes('invalid login') || m.includes('invalid credentials') ||
      code.includes('invalid_credentials')) {
    return 'auth/wrong-password';
  }
  if (m.includes('user not found') || code.includes('user_not_found')) return 'auth/user-not-found';
  if (m.includes('rate limit') || m.includes('too many') || code.includes('over_request_rate_limit')) {
    return 'auth/too-many-requests';
  }
  if (m.includes('anonymous') || code.includes('anonymous')) return 'auth/anonymous-disabled';
  return 'auth/unknown';
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const DB = {
  ref(path) { return new Ref(path); },
  goOnline() {},
  goOffline() {},
};

window.NexusDB = {
  DB,
  ready,
  sb,
  auth: authAdapter,
  _cache: cache,
  _fetchTable: fetchTable,
  _parsePath: parsePath,
  _mapAuthErrorForTest: mapAuthError,
};
