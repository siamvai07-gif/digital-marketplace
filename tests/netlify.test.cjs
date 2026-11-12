/**
 * Netlify deployment verification.
 *
 * Parses the REAL netlify.toml, inspects the REAL production build in dist/,
 * and replays Netlify's routing/header engine to prove every deployed URL
 * resolves. Run after `npm run build`:
 *
 *   npm run test:deploy
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failures.push(name + (detail ? ' \u2014 ' + detail : '')); console.log('  \u2717 ' + name + (detail ? ' \u2014 ' + detail : '')); }
}
const section = n => console.log('\n' + n);

// ── Minimal TOML reader for the subset used by netlify.toml ──────────────────
function parseNetlifyToml(text) {
  const out = { build: {}, redirects: [], headers: [] };
  const blocks = text.split(/(?=\n\[)/);
  for (const block of blocks) {
    const headerMatch = block.match(/^\s*\[\[?([a-zA-Z0-9._]+)\]\]?/);
    if (!headerMatch) continue;
    const kind = headerMatch[1];
    const body = block.slice(block.indexOf('\n'));
    // Accept both `key = "value"` and bare `key = value` (TOML integers/bools).
    const str = k => {
      const m = body.match(new RegExp('^\\s*' + k + '\\s*=\\s*(?:"([^"]*)"|([^\\s#]+))', 'm'));
      return m ? (m[1] !== undefined ? m[1] : m[2]) : undefined;
    };

    if (kind === 'redirects') {
      out.redirects.push({ from: str('from'), to: str('to'), status: Number(str('status') || 301) });
    } else if (kind === 'headers') {
      const values = {};
      const valsMatch = body.match(/\[headers\.values\]([\s\S]*)$/);
      if (valsMatch) {
        for (const line of valsMatch[1].split('\n')) {
          const m = line.match(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"/);
          if (m) values[m[1]] = m[2];
        }
      }
      out.headers.push({ for: str('for'), values });
    } else if (kind === 'build.environment') {
      for (const line of body.split('\n')) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*"([^"]*)"/);
        if (m) out.build.env = { ...(out.build.env || {}), [m[1]]: m[2] };
      }
    } else if (kind === 'build') {
      out.build.command = str('command');
      out.build.publish = str('publish');
    }
  }
  return out;
}

// Netlify glob: "*" spans slashes; static files are served before rules apply.
function matchRule(pattern, url) {
  if (!pattern.includes('*')) return pattern === url ? {} : null;
  const [pre, post] = pattern.split('*');
  if (!url.startsWith(pre) || !url.endsWith(post || '')) return null;
  if (url.length < pre.length + (post || '').length) return null;
  return { splat: url.slice(pre.length, url.length - (post || '').length) };
}

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function resolve(urlPath) {
  const cfg = parseNetlifyToml(fs.readFileSync(path.join(REPO, 'netlify.toml'), 'utf8'));
  const clean = urlPath.split('?')[0];
  // 1. static asset takes precedence
  for (const c of [clean, clean.replace(/\/$/, '') + '/index.html', clean + '.html']) {
    const f = path.join(DIST, c);
    if (isFile(f)) return { type: 'static', file: path.relative(DIST, f), status: 200 };
  }
  // 2. first matching rule wins
  for (const r of cfg.redirects) {
    if (matchRule(r.from, clean) !== null) {
      const f = path.join(DIST, r.to);
      if (!isFile(f)) return { type: 'broken', rule: r.from, status: 404 };
      return { type: 'rewrite', rule: r.from, file: path.relative(DIST, r.to), status: r.status };
    }
  }
  return { type: '404', status: 404 };
}

function headerValuesFor(urlPath) {
  const cfg = parseNetlifyToml(fs.readFileSync(path.join(REPO, 'netlify.toml'), 'utf8'));
  // Most specific match wins; Netlify applies merged values, later rules override.
  let merged = {};
  let bestLen = -1;
  for (const h of cfg.headers) {
    const m = matchRule(h.for, urlPath);
    if (m === null) continue;
    const len = h.for.replace('*', '').length;
    if (len > bestLen) { bestLen = len; merged = { ...h.values }; }
    else if (len === bestLen) { merged = { ...merged, ...h.values }; }
  }
  return merged;
}

function main() {
  const tomlPath = path.join(REPO, 'netlify.toml');
  const toml = fs.readFileSync(tomlPath, 'utf8');
  const cfg = parseNetlifyToml(toml);

  section('netlify.toml validity');
  check('netlify.toml exists', fs.existsSync(tomlPath));
  check('every [[redirects]] declares from/to/status',
    cfg.redirects.length > 0 && cfg.redirects.every(r => r.from && r.to && r.status),
    JSON.stringify(cfg.redirects));
  check('every [[headers]] declares a for pattern',
    cfg.headers.length > 0 && cfg.headers.every(h => !!h.for));

  section('Build settings');
  check('publish directory is dist', cfg.build.publish === 'dist', cfg.build.publish);
  check('build command runs the production build', /npm run build/.test(cfg.build.command || ''), cfg.build.command);
  check('build command gates on type-check', /npm run lint/.test(cfg.build.command || ''));
  const nodeVer = (cfg.build.env || {}).NODE_VERSION;
  check('NODE_VERSION pinned for Vite 8 (>=22.12)', nodeVer === '22', nodeVer);
  check('NPM_FLAGS installs devDependencies',
    /--include=dev/.test((cfg.build.env || {}).NPM_FLAGS || ''), (cfg.build.env || {}).NPM_FLAGS);
  check('no serverless/functions dir required',
    !/\[functions\]/.test(toml) && !fs.existsSync(path.join(REPO, 'netlify', 'functions')));

  section('Production build present');
  check('dist/ exists (run `npm run build` first)', fs.existsSync(DIST));
  const indexPath = path.join(DIST, 'index.html');
  const adminPath = path.join(DIST, 'admin', 'index.html');
  check('storefront built', isFile(indexPath));
  check('admin console built', isFile(adminPath));
  if (!isFile(indexPath) || !isFile(adminPath)) return finish();

  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  const adminHtml = fs.readFileSync(adminPath, 'utf8');

  section('No dev-only configuration in production output');
  for (const [label, html] of [['storefront', indexHtml], ['admin', adminHtml]]) {
    check(label + ': no localhost URLs', !/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(html));
    check(label + ': no @vite/client / HMR injection', !/@vite\/client|@react-refresh/.test(html));
    check(label + ': no /src/ dev entries', !/src="\/src\//.test(html));
  }

  section('Assets resolve');
  // pull every root-relative asset the shipped HTML asks for
  const refs = new Set();
  for (const html of [indexHtml, adminHtml]) {
    // attribute references
    for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) refs.add(m[1]);
    // JS string literals (default catalog, image pickers, seed data)
    for (const m of html.matchAll(/['"](\/assets\/[^'"\s]+)['"]/g)) refs.add(m[1]);
  }
  let missing = [];
  for (const ref of refs) {
    if (!isFile(path.join(DIST, ref.slice(1)))) missing.push(ref);
  }
  check(`all ${refs.size} referenced local assets exist in dist`, missing.length === 0, missing.join(', '));

  section('Legacy prototypes removed (credential leak)');
  check('no abandoned admin prototype published',
    !isFile(path.join(DIST, 'assets/aistudio/admin_933a1e1c.html')));
  check('no abandoned storefront prototype published',
    !isFile(path.join(DIST, 'assets/aistudio/user_71a316be.html')));
  const publishedHtml = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) publishedHtml.push(p);
    }
  })(DIST);
  check('only the two intended HTML entry points are published',
    publishedHtml.length === 2, publishedHtml.map(p => path.relative(DIST, p)).join(', '));
  const leakedKey = publishedHtml.filter(p => fs.readFileSync(p, 'utf8').includes('SIAMVIP'));
  check('admin access key never appears in shipped HTML', leakedKey.length === 0,
    leakedKey.map(p => path.relative(DIST, p)).join(', '));

  section('SPA / admin routing');
  const cases = [
    ['/', 200], ['/index.html', 200], ['/admin', 200], ['/admin/', 200], ['/admin/index.html', 200],
    ['/admin/settings', 200], ['/admin/anything/deep', 200], ['/admin?tab=users', 200],
    ['/exchange', 200], ['/games', 200], ['/orders', 200], ['/account', 200], ['/deep/unknown/route', 200],
  ];
  for (const [url, expected] of cases) {
    const r = resolve(url);
    check(`GET ${url} -> ${expected}`, r.status === expected, JSON.stringify(r));
  }
  check('/admin resolves to the ADMIN shell', resolve('/admin').file.endsWith('admin/index.html'));
  check('/admin/ resolves to the ADMIN shell', resolve('/admin/').file.endsWith('admin/index.html'));
  check('/admin/settings resolves to the ADMIN shell', resolve('/admin/settings').file.endsWith('admin/index.html'));
  check('/exchange resolves to the STOREFRONT shell', resolve('/exchange').file.endsWith('index.html') && !resolve('/exchange').file.includes('admin'));
  check('/order typo does not leak into admin', !resolve('/adminx').file.includes('admin'));

  section('Assets are not swallowed by the SPA catch-all');
  const asset = resolve('/assets/aistudio/UID_TOPUP_dd448c6f.png');
  check('png served as a static file', asset.type === 'static', JSON.stringify(asset));
  check('png not rewritten to HTML', !asset.file.endsWith('.html'), asset.file);

  section('_redirects published and in sync');
  const redirPath = path.join(DIST, '_redirects');
  check('_redirects copied into dist', isFile(redirPath));
  if (isFile(redirPath)) {
    const lines = fs.readFileSync(redirPath, 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const parsed = lines.map(l => l.split(/\s+/));
    const expected = cfg.redirects.map(r => [r.from, r.to, String(r.status)]);
    check('_redirects matches netlify.toml rules',
      JSON.stringify(parsed) === JSON.stringify(expected),
      `file=${JSON.stringify(parsed)} toml=${JSON.stringify(expected)}`);
    check('catch-all is last', parsed[parsed.length - 1][0] === '/*');
  }

  section('Caching & security headers');
  const assetHeaders = headerValuesFor('/assets/aistudio/UID_TOPUP_dd448c6f.png');
  // No content-hashed bundles exist in this build, so images must NOT be
  // `immutable` — replacing one has to reach returning visitors.
  check('images cached but still refreshable',
    /max-age=/.test(assetHeaders['Cache-Control'] || '') &&
    !/immutable/.test(assetHeaders['Cache-Control'] || '') &&
    /stale-while-revalidate/.test(assetHeaders['Cache-Control'] || ''),
    JSON.stringify(assetHeaders));
  const rootHeaders = headerValuesFor('/');
  check('X-Content-Type-Options: nosniff', rootHeaders['X-Content-Type-Options'] === 'nosniff');
  check('X-Frame-Options set (and not DENY, so preview works)',
    rootHeaders['X-Frame-Options'] === 'SAMEORIGIN', rootHeaders['X-Frame-Options']);
  check('Referrer-Policy set', !!rootHeaders['Referrer-Policy']);
  check('Permissions-Policy set', !!rootHeaders['Permissions-Policy']);
  const htmlHeaders = headerValuesFor('/index.html');
  check('HTML entry revalidates each deploy',
    /must-revalidate|no-cache|max-age=0/.test(htmlHeaders['Cache-Control'] || ''), htmlHeaders['Cache-Control']);
  const adminHeaders = headerValuesFor('/admin');
  check('/admin is noindex', /noindex/.test(adminHeaders['X-Robots-Tag'] || ''), JSON.stringify(adminHeaders));

  section('Backend / environment');
  check('no Express dependency at runtime (static deploy)',
    !/server\.ts/.test(indexHtml + adminHtml) && !fs.existsSync(path.join(DIST, 'server.js')));
  check('.env.example documented and non-secret',
    !/GEMINI_API_KEY="MY_/.test(fs.readFileSync(path.join(REPO, '.env.example'), 'utf8')));
  check('no .env file committed', !fs.existsSync(path.join(REPO, '.env')));

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
