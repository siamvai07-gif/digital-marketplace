/**
 * Video hero: file upload + player selection.
 *
 * Loads the REAL built pages with the real Supabase client, signs in as the
 * admin, opens "Gateways & Settings", and exercises the uploader and the
 * preview/storefront rendering.
 *
 * Run: node tests/hero-video.test.cjs   (requires `npm run build` first)
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
const ACCESS_TOKEN = [
  b64url({ alg: 'ES256', typ: 'JWT' }),
  b64url({
    iss: 'https://hvntegcbrjffkwlbkrba.supabase.co/auth/v1',
    sub: '74890dfc-ff2a-4c1f-8475-36de17ed6527',
    aud: 'authenticated', exp: NOW + 3600, iat: NOW,
    email: 'admin@nexusdigital.app', role: 'authenticated',
  }),
  'sig',
].join('.');

const USER = {
  id: '74890dfc-ff2a-4c1f-8475-36de17ed6527', aud: 'authenticated', role: 'authenticated',
  email: 'admin@nexusdigital.app', email_confirmed_at: '2026-11-12T13:50:07Z',
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
};
const SESSION = {
  access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 3600,
  expires_at: NOW + 3600, refresh_token: 'r', user: USER,
};

/** Captured upload requests, so we can assert the real XHR path was used. */
const uploads = [];

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const SEED = {
  products: [], orders: [], customers: [], addfunds: [], deposits: [],
  cashouts: [], dollarrequests: [], transactions: [], reviews: [], lookup: [],
  settings: [{
    id: 'heroVideo',
    data: {
      enabled: true, source: 'youtube',
      youtubeUrl: 'https://www.youtube.com/watch?v=ysz5S6PUM-U', videoId: 'ysz5S6PUM-U',
      videoUrl: '',
    },
  }],
};

function makeFetch() {
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/token')) return jsonResponse(SESSION);
    if (u.includes('/auth/v1/user')) return jsonResponse(USER);
    if (u.includes('/auth/v1/logout')) return jsonResponse({});
    if (u.includes('/storage/v1/object/hero-videos/')) return jsonResponse({ Key: 'ok' }, 200);
    if (u.includes('/rest/v1/')) {
      const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
      if (table in SEED) return jsonResponse(SEED[table]);
      return jsonResponse([], 200);
    }
    return jsonResponse({}, 200);
  };
}

/** Minimal XHR good enough for the uploader (jsdom's lacks upload). */
function installXhr(w) {
  class FakeXHR {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this._headers = {}; }
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    send(body) {
      uploads.push({ url: this._url, headers: this._headers, size: body && body.size });
      const total = (body && body.size) || 100;
      // emit partial progress so the bar is genuinely exercised
      setTimeout(() => this.upload.onprogress && this.upload.onprogress({ lengthComputable: true, loaded: total / 2, total }), 10);
      setTimeout(() => {
        this.status = 200;
        this.responseText = JSON.stringify({ Key: 'hero-videos/ok' });
        if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: total, total });
        this.onload && this.onload();
      }, 40);
    }
  }
  w.XMLHttpRequest = FakeXHR;
}

function boot(page, { presetSettings } = {}) {
  let html = fs.readFileSync(path.join(DIST, page), 'utf8');
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
    url: 'https://nexus-digital-marketplace-eight.vercel.app/' + (page === 'index.html' ? '' : 'admin'),
    virtualConsole: vc,
    beforeParse(w) {
      Object.assign(SEED.settings[0].data, presetSettings || {});
      w.fetch = makeFetch();
      w.WebSocket = function () { this.close = () => {}; this.send = () => {}; };
      w.confetti = () => {};
      w.scrollTo = () => {};
      w.matchMedia = w.matchMedia || (() => ({
        matches: false, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
      }));
      installXhr(w);
    },
  });
  return { win: dom.window, doc: dom.window.document, errors, dom };
}

const MP4 = 'https://hvntegcbrjffkwlbkrba.supabase.co/storage/v1/object/public/hero-videos/hero-abc-test.mp4';
const WEBM = 'https://hvntegcbrjffkwlbkrba.supabase.co/storage/v1/object/public/hero-videos/hero-xyz-test.webm';

(async () => {
  console.log('Video hero: upload + playback');

  /* ---------------- URL classification ---------------- */
  section('Source detection (shared by both panels)');
  {
    const { win } = boot('index.html');
    await sleep(900);
    const w = win;
    check('mp4 is a direct video', w.isDirectVideoUrl(MP4) === true);
    check('webm is a direct video', w.isDirectVideoUrl(WEBM) === true);
    check('query string does not break detection',
      w.isDirectVideoUrl(MP4 + '?v=2') === true);
    check('youtube watch URL is NOT a direct video',
      w.isDirectVideoUrl('https://www.youtube.com/watch?v=ysz5S6PUM-U') === false);
    check('youtu.be is NOT a direct video',
      w.isDirectVideoUrl('https://youtu.be/ysz5S6PUM-U') === false);

    const yt = w.resolveHeroVideo({ source: 'youtube', youtubeUrl: 'https://youtu.be/abc12345678' });
    check('youtube source resolves to a youtube player', yt.kind === 'youtube' && yt.id === 'abc12345678');
    const up = w.resolveHeroVideo({ source: 'upload', videoUrl: MP4 });
    check('upload source resolves to a native player', up.kind === 'video' && up.url === MP4);
    const none = w.resolveHeroVideo({ source: 'upload', videoUrl: '' });
    check('upload source with no file resolves to none', none.kind === 'none');
    const stray = w.resolveHeroVideo({ source: 'upload', videoUrl: 'https://example.com/page' });
    check('upload source pointing at a non-video URL resolves to none', stray.kind === 'none');
    w.close();
  }

  /* ---------------- storefront rendering ---------------- */
  section('Storefront hero rendering');
  {
    const { win, doc, errors } = boot('index.html', {
      presetSettings: { source: 'upload', videoUrl: MP4 },
    });
    await sleep(1800);

    const vid = doc.querySelector('.video-hero-bg video');
    check('storefront renders a <video> for an uploaded file', !!vid,
      doc.querySelector('.video-hero-bg') ? doc.querySelector('.video-hero-bg').innerHTML.slice(0, 120) : 'no hero bg');
    if (vid) {
      check('video src is the uploaded file', vid.getAttribute('src') === MP4, vid.getAttribute('src'));
      check('video is autoplay', vid.hasAttribute('autoplay'));
      check('video is muted (required for autoplay)', vid.hasAttribute('muted'));
      check('video is loop', vid.hasAttribute('loop'));
      check('video is playsinline', vid.hasAttribute('playsinline'));
    }
    check('storefront does NOT also render a YouTube iframe',
      !doc.querySelector('.video-hero-bg iframe'));
    check('no runtime errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 200));
    win.close();
  }

  section('Storefront falls back to YouTube when configured');
  {
    const { win, doc } = boot('index.html', {
      presetSettings: { source: 'youtube', youtubeUrl: 'https://www.youtube.com/watch?v=ysz5S6PUM-U', videoUrl: MP4 },
    });
    await sleep(1800);
    const iframe = doc.querySelector('.video-hero-bg iframe');
    check('youtube selected renders an iframe', !!iframe);
    if (iframe) check('iframe points at the video', /ysz5S6PUM-U/.test(iframe.getAttribute('src')));
    check('youtube selection does not render a <video>', !doc.querySelector('.video-hero-bg video'));
    win.close();
  }

  /* ---------------- admin panel ---------------- */
  section('Admin: settings section and uploader');
  const admin = boot('admin/index.html');
  await sleep(1200);
  const A = { w: admin.win, doc: admin.doc, errors: admin.errors };
  {
    // sign in so the session exists for the upload
    A.w.localStorage.removeItem('nx_admin_attempts');
    A.w.localStorage.removeItem('nx_admin_lock_until');
    A.doc.querySelector('#adminKeyInput').value = 'SIAMVIP';
    A.w.verifyAdminKey();
    for (let i = 0; i < 40 && !A.doc.querySelector('#loginOverlay').classList.contains('gone'); i++) await sleep(100);

    A.w.setAdminTab('settings');
    await sleep(600);

    const srcSel = A.doc.querySelector('#heroSource');
    check('source selector present', !!srcSel);
    check('upload option available', !!A.doc.querySelector('#heroSource option[value="upload"]'));
    check('youtube option retained', !!A.doc.querySelector('#heroSource option[value="youtube"]'));

    const fileInput = A.doc.querySelector('#heroVideoFile');
    check('file input present', !!fileInput);
    check('file input accepts mp4/webm/mov',
      /video\/mp4/.test(fileInput.getAttribute('accept')) && /video\/webm/.test(fileInput.getAttribute('accept')),
      fileInput.getAttribute('accept'));

    check('progress bar present', !!A.doc.querySelector('#heroUploadBar'));
    check('error area present', !!A.doc.querySelector('#heroUploadError'));

    /* --- reject an oversized file --- */
    const big = new A.w.File([new Uint8Array(10)], 'big.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
    await A.w.uploadHeroVideoFile(big);
    await sleep(200);
    const errEl = A.doc.querySelector('#heroUploadError');
    check('oversized file rejected', errEl.style.display === 'block' && /50MB/.test(errEl.textContent),
      errEl.textContent);

    /* --- reject a non-video extension --- */
    const bad = new A.w.File(['x'], 'notes.txt', { type: 'text/plain' });
    await A.w.uploadHeroVideoFile(bad);
    await sleep(200);
    check('non-video file rejected', /Unsupported file type/.test(errEl.textContent), errEl.textContent);

    /* --- successful upload --- */
    uploads.length = 0;
    const good = new A.w.File([new Uint8Array(1024)], 'hero clip.mp4', { type: 'video/mp4' });
    await A.w.uploadHeroVideoFile(good);
    await sleep(400);

    check('upload issued a request to the hero-videos bucket',
      uploads.length === 1 && /\/storage\/v1\/object\/hero-videos\//.test(uploads[0].url),
      JSON.stringify(uploads.map(u => u.url)));
    check('upload sent the admin bearer token',
      uploads[0] && /^Bearer /.test(uploads[0].headers['Authorization'] || ''));
    check('upload sent the anon apikey', !!(uploads[0] && uploads[0].headers['apikey']));
    check('filename was sanitised (no spaces)',
      uploads[0] && !/ /.test(uploads[0].url), uploads[0] && uploads[0].url);

    const urlInput = A.doc.querySelector('#heroVideoUrl');
    check('public URL written back into the field',
      /\/storage\/v1\/object\/public\/hero-videos\/hero-/.test(urlInput.value || ''), urlInput.value);
    check('source switched to upload', A.doc.querySelector('#heroSource').value === 'upload');

    const previewVid = A.doc.querySelector('#heroPreviewVideo');
    check('preview renders a <video> after upload', !!previewVid);
    check('preview video is muted/autoplay/loop',
      previewVid && previewVid.hasAttribute('muted') && previewVid.hasAttribute('autoplay') && previewVid.hasAttribute('loop'));
    check('preview reports the uploaded-file source',
      /uploaded video file/i.test((A.doc.querySelector('#heroPreviewMeta') || {}).textContent || ''));

    /* --- switching back to YouTube swaps the preview --- */
    A.doc.querySelector('#heroSource').value = 'youtube';
    A.w.onHeroSourceChange();
    await sleep(150);
    check('switching to YouTube swaps preview to an iframe',
      !!A.doc.querySelector('#heroPreviewIframe') && !A.doc.querySelector('#heroPreviewVideo'));

    check('no runtime errors in admin', A.errors.length === 0,
      A.errors.slice(0, 2).join(' | ').slice(0, 200));
  }
  A.w.close();

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
