/**
 * Reproduces the live page in JSDOM using the REAL vendored Supabase bundles
 * (not the test mocks), so render-time failures surface the way a browser sees
 * them. Prints console errors and the resulting #appView content.
 *
 * Run: node scripts/repro-render.cjs [index.html|admin/index.html]
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const page = process.argv[2] || 'index.html';

let html = fs.readFileSync(path.join(DIST, page), 'utf8');
const sbSrc = fs.readFileSync(path.join(DIST, 'vendor', 'supabase.js'), 'utf8');
const nxSrc = fs.readFileSync(path.join(DIST, 'vendor', 'nexus-db.js'), 'utf8');
html = html.replace('<script src="/vendor/supabase.js"></script>', `<script>${sbSrc}</script>`);
html = html.replace('<script src="/vendor/nexus-db.js"></script>', `<script>${nxSrc}</script>`);

const errs = [];
const warns = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errs.push('jsdomError: ' + ((e && e.stack) || e)));
vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => warns.push('console.warn: ' + a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://nexus-digital-marketplace-eight.vercel.app/' + (page === 'index.html' ? '' : 'admin'),
  virtualConsole: vc,
  beforeParse(w) {
    // Offline, like a blocked network: this is the worst case for rendering.
    w.fetch = () => Promise.reject(new Error('offline'));
    w.WebSocket = function () { this.close = () => {}; this.send = () => {}; };
    w.confetti = () => {};
    w.matchMedia = w.matchMedia || (() => ({
      matches: false, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
    }));
    w.scrollTo = () => {};
  },
});

const w = dom.window;
setTimeout(() => {
  const view = w.document.querySelector('#appView') || w.document.querySelector('#adminContent');
  const text = (view ? view.textContent : '').replace(/\s+/g, ' ').trim();
  console.log(`=== ${page} ===`);
  console.log(`errors: ${errs.length}`);
  errs.slice(0, 8).forEach(e => console.log('  ' + e.replace(/\n/g, '\n  ').slice(0, 900)));
  console.log(`warnings: ${warns.length}`);
  warns.slice(0, 6).forEach(e => console.log('  ' + e.slice(0, 300)));
  console.log('NexusDB ready:', !!(w.NexusDB && w.NexusDB.ready && w.NexusDB.ready()));
  console.log('content length:', text.length);
  console.log('content:', text.slice(0, 300));
  process.exit(0);
}, 3000);
