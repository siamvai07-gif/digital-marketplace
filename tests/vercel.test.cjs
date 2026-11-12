/**
 * Vercel deployment tests.
 *
 * Replays Vercel's static-hosting routing for this project (files first, then
 * rewrites, then the SPA fallback) and asserts the admin console is reachable at
 * /admin. Vercel's own fallback would otherwise serve the storefront there.
 *
 * Run: node tests/vercel.test.cjs
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function section(t) { console.log('\n' + t); }

function exists(p) { return fs.existsSync(p) && fs.statSync(p).isFile(); }

/**
 * Mirrors Vercel: an exact static file wins, then a configured rewrite, then the
 * directory index, then the SPA catch-all.
 */
function route(url, rewrites) {
  const clean = url.split('?')[0];
  const direct = path.join(DIST, clean);
  if (clean !== '/' && exists(direct)) return { file: clean, via: 'static' };
  for (const r of rewrites) {
    const src = r.source.replace(/\(\.\*\)/g, '.*');
    const re = new RegExp('^' + src.replace(/:[a-zA-Z]+\*/g, '.*').replace(/:[a-zA-Z]+/g, '[^/]+') + '$');
    if (re.test(clean)) return { file: r.destination, via: 'rewrite' };
  }
  if (clean.endsWith('/') && exists(path.join(DIST, clean, 'index.html'))) {
    return { file: path.join(clean, 'index.html'), via: 'dir-index' };
  }
  if (exists(path.join(DIST, 'index.html'))) return { file: '/index.html', via: 'spa-fallback' };
  return { file: null, via: '404' };
}

function main() {
  section('vercel.json');
  const cfgPath = path.join(REPO, 'vercel.json');
  check('vercel.json exists', fs.existsSync(cfgPath));
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { check('vercel.json parses', false, e.message); }
  check('vercel.json parses', !!cfg && Object.keys(cfg).length > 0);

  check('outputDirectory is dist', cfg.outputDirectory === 'dist', cfg.outputDirectory);
  check('buildCommand runs the Vite build', /npm run build/.test(cfg.buildCommand || ''), cfg.buildCommand);
  check('install includes devDependencies',
    /--include=dev/.test(cfg.installCommand || ''), cfg.installCommand);
  check('framework is not pinned to a wrong preset',
    cfg.framework === null || cfg.framework === undefined, String(cfg.framework));

  const rewrites = cfg.rewrites || [];
  check('admin rewrite configured', rewrites.some(r => r.source === '/admin'),
    JSON.stringify(rewrites.map(r => r.source)));

  section('Routing (simulated Vercel)');
  if (!fs.existsSync(DIST)) {
    check('dist build present', false, 'run npm run build first');
  } else {
    const root = route('/', rewrites);
    check('/ serves the storefront', root.file === '/index.html', JSON.stringify(root));

    const admin = route('/admin', rewrites);
    check('/admin serves the admin console, not the storefront',
      admin.file === '/admin/index.html', JSON.stringify(admin));

    const adminSlash = route('/admin/', rewrites);
    check('/admin/ serves the admin console',
      String(adminSlash.file).includes('admin/index.html'), JSON.stringify(adminSlash));

    const adminDeep = route('/admin/orders', rewrites);
    check('/admin/* serves the admin console',
      String(adminDeep.file).includes('admin/index.html'), JSON.stringify(adminDeep));

    const asset = route('/assets/', rewrites);
    check('unknown paths fall back to the storefront',
      asset.file === '/index.html', JSON.stringify(asset));

    // Headers must not cache the HTML entry points.
    const headers = cfg.headers || [];
    const adminHeader = headers.find(h => h.source === '/admin/index.html');
    check('admin HTML is not cached',
      !!adminHeader && adminHeader.headers.some(x => /max-age=0/.test(x.value)));
    check('admin HTML is noindex',
      !!adminHeader && adminHeader.headers.some(x => x.key === 'X-Robots-Tag'));
    const anyHeader = headers.find(h => h.source === '/(.*)');
    check('security headers applied site-wide',
      !!anyHeader && anyHeader.headers.some(x => x.key === 'X-Content-Type-Options'));
  }

  section('Build output');
  if (fs.existsSync(DIST)) {
    const adminHtml = fs.readFileSync(path.join(DIST, 'admin', 'index.html'), 'utf8');
    const storeHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    check('admin build is the admin panel', /NEXUS ADMIN/i.test(adminHtml));
    check('storefront build is the storefront', !/NEXUS ADMIN PORTAL/i.test(storeHtml));
    check('admin key not in admin bundle', !/SIAMVIP/.test(adminHtml));
    check('admin key not in storefront bundle', !/SIAMVIP/.test(storeHtml));
    check('no Firebase SDK referenced',
      !/firebasejs|gstatic\.com\/firebase/.test(storeHtml) && !/firebasejs|gstatic\.com\/firebase/.test(adminHtml));
    check('no Firebase config or references left in the source pages',
      !/firebase/i.test(fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')) &&
      !/firebase/i.test(fs.readFileSync(path.join(REPO, 'admin/index.html'), 'utf8')));
    check('Supabase data layer loaded in storefront',
      /vendor\/nexus-db\.js/.test(storeHtml));
    check('Supabase data layer loaded in admin',
      /vendor\/nexus-db\.js/.test(adminHtml));
    check('Supabase client loaded in both panels',
      /vendor\/supabase\.js/.test(storeHtml) && /vendor\/supabase\.js/.test(adminHtml));
    check('vendor bundles shipped to dist',
      fs.existsSync(path.join(DIST, 'vendor', 'supabase.js')) &&
      fs.existsSync(path.join(DIST, 'vendor', 'nexus-db.js')));
    check('realtime client configured against the Supabase project',
      /hvntegcbrjffkwlbkrba/.test(fs.readFileSync(path.join(DIST, 'vendor', 'nexus-db.js'), 'utf8')));
    check('no localhost URLs in shipped build',
      !/localhost|127\.0\.0\.1/.test(storeHtml) && !/localhost|127\.0\.0\.1/.test(adminHtml));
  }

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

main();
