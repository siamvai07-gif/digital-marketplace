/**
 * Render tests using the REAL vendored bundles.
 *
 * The other suites deliberately stub the data layer, which is fast but hides
 * integration faults such as a global name collision between the page and the
 * vendor script. That exact bug shipped once and left the storefront blank
 * below the header. This suite loads dist/ with the actual
 * vendor/supabase.js + vendor/nexus-db.js and asserts the page really renders.
 *
 * Run: node tests/render.test.cjs   (requires `npm run build` first)
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

/** Loads a built page with the real vendor scripts inlined. */
function bootReal(page) {
  let html = fs.readFileSync(path.join(DIST, page), 'utf8');
  for (const asset of ['supabase.js', 'nexus-db.js']) {
    const src = fs.readFileSync(path.join(DIST, 'vendor', asset), 'utf8');
    html = html.replace(`<script src="/vendor/${asset}"></script>`, `<script>\n${src}\n</script>`);
  }
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String((e && e.message) || e)));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://nexus-digital-marketplace-eight.vercel.app/' + (page === 'index.html' ? '' : 'admin'),
    virtualConsole: vc,
    beforeParse(w) {
      // Offline worst case: rendering must not depend on the network.
      w.fetch = () => Promise.reject(new Error('offline'));
      w.WebSocket = function () { this.close = () => {}; this.send = () => {}; };
      w.confetti = () => {};
      w.scrollTo = () => {};
      w.matchMedia = w.matchMedia || (() => ({
        matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
      }));
    },
  });
  return { win: dom.window, doc: dom.window.document, errors, dom };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Render with real vendor bundles');

  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('dist/ missing — run npm run build first');
    process.exit(1);
  }

  /* ---------------- storefront ---------------- */
  section('Storefront (dist/index.html)');
  {
    const { win, doc, errors } = bootReal('index.html');
    await sleep(2500);

    check('no runtime errors with the real bundles', errors.length === 0,
      errors.slice(0, 3).join(' | ').slice(0, 400));

    // The reported bug: header/footer rendered but the middle was empty.
    const view = doc.querySelector('#appView');
    check('#appView exists', !!view);
    const text = (view ? view.textContent : '').replace(/\s+/g, ' ').trim();
    check('main content area is not blank', text.length > 500, `length=${text.length}`);
    check('hero copy rendered', /DIGITAL MARKETPLACE/i.test(text));
    check('a product or category is rendered',
      /Free Fire|PUBG|Canva|Telegram|UniPin/i.test(text), text.slice(0, 160));

    check('Supabase data layer initialised', !!(win.NexusDB && win.NexusDB.ready()));
    check('supabase client constructed', !!(win.NexusDB && win.NexusDB.sb()));

    // The global collision that caused the blank page must not return: the
    // adapter must not define any of the names the page declares at top level.
    const adapterGlobals = ['DB', 'cache', 'listeners', 'channels', 'clone', 'notify', 'Ref']
      .filter(k => k in win);
    check('adapter leaks no globals that could collide with the page',
      adapterGlobals.length === 0, 'leaked: ' + adapterGlobals.join(', '));
    check('page script ran to completion (realtime render hooks installed)',
      typeof win.renderApp === 'function' && typeof win.renderTickerBar === 'function');
    win.close();
  }

  /* ---------------- admin ---------------- */
  section('Admin panel (dist/admin/index.html)');
  {
    const { win, doc, errors } = bootReal('admin/index.html');
    await sleep(2500);

    check('no runtime errors with the real bundles', errors.length === 0,
      errors.slice(0, 3).join(' | ').slice(0, 400));

    check('login overlay rendered', !!doc.querySelector('#loginOverlay'));
    const content = doc.querySelector('#adminContent');
    check('#adminContent exists', !!content);
    const text = (content ? content.textContent : '').replace(/\s+/g, ' ').trim();
    check('admin content area is not blank', text.length > 100, `length=${text.length}`);
    check('dashboard stat cards rendered', /Dollar Volume|Pending Add Funds|Total Store Orders/i.test(text));

    check('Supabase data layer initialised', !!(win.NexusDB && win.NexusDB.ready()));
    win.close();
  }

  /* ---------------- vendor integrity ---------------- */
  section('Vendored bundle integrity');
  {
    const sb = fs.readFileSync(path.join(DIST, 'vendor', 'supabase.js'), 'utf8');
    const nx = fs.readFileSync(path.join(DIST, 'vendor', 'nexus-db.js'), 'utf8');

    check('supabase client bundle is self-contained (no code-split chunk loading)',
      !/Automatic publicPath/.test(sb) && !/591\.supabase\.js/.test(sb));
    check('adapter declares no top-level bindings of its own',
      /\(function \(\) \{/.test(nx) && /^\}\)\(\);/m.test(nx.trim()));
    check('adapter exposes the documented API surface',
      ['window.NexusDB', 'DB,', 'ready,', 'auth: authAdapter'].every(t => nx.includes(t)));
    check('both panels reference the vendor scripts by absolute path',
      /src="\/vendor\/supabase\.js"/.test(fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')) &&
      /src="\/vendor\/supabase\.js"/.test(fs.readFileSync(path.join(REPO, 'admin/index.html'), 'utf8')));
  }

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
