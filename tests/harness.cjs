/**
 * Shared jsdom + Firebase RTDB mock harness.
 *
 * Boots index.html (storefront) or admin/index.html in JSDOM with a fake
 * Firebase v8 Realtime Database so every user/admin workflow can be executed
 * headlessly. Pass a store object to share one database between pages.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '..');

const FIREBASE_MOCK = String.raw`
(function(){
  function Snap(v){this._v=v;}
  Snap.prototype.exists=function(){return this._v!==null&&this._v!==undefined;};
  Snap.prototype.val=function(){return this._v===undefined?null:this._v;};
  function Ref(path){this.path=path;this.key=String(path).split('/').pop();}
  const STORE=window.__FB_STORE=window.__SHARED_DB__||{};
  function get(p){const parts=String(p).split('/').filter(Boolean);let cur=STORE;for(const k of parts){if(cur==null||typeof cur!=='object')return null;cur=cur[k];}return cur===undefined?null:cur;}
  function set(p,v){const parts=String(p).split('/').filter(Boolean);let cur=STORE;for(let i=0;i<parts.length-1;i++){if(typeof cur[parts[i]]!=='object'||cur[parts[i]]===null)cur[parts[i]]={};cur=cur[parts[i]];}cur[parts[parts.length-1]]=v;}
  function del(p){const parts=String(p).split('/').filter(Boolean);let cur=STORE;for(let i=0;i<parts.length-1;i++){if(typeof cur[parts[i]]!=='object')return;cur=cur[parts[i]];}delete cur[parts[parts.length-1]];}
  const listeners=[];
  function notify(p){listeners.forEach(function(l){ if(l.path===p||String(l.path).startsWith(p+'/')||p.startsWith(String(l.path)+'/')||String(l.path)===''){ l.cb(new Snap(get(l.path))); } });}
  Ref.prototype.on=function(ev,cb){listeners.push({path:this.path,cb:cb});var self=this;setTimeout(function(){cb(new Snap(get(self.path)))},0);return cb;};
  Ref.prototype.off=function(){};
  Ref.prototype.once=function(ev,cb,errCb){var self=this;var p=Promise.resolve(new Snap(get(self.path)));if(typeof cb==='function'){p.then(cb).catch(function(e){if(errCb)errCb(e);});}return p;};
  Ref.prototype.set=function(v){set(this.path,v);notify(this.path);return Promise.resolve();};
  Ref.prototype.update=function(v){var base=get(this.path)||{};set(this.path,Object.assign({},base,v));notify(this.path);return Promise.resolve();};
  Ref.prototype.remove=function(){del(this.path);notify(this.path);return Promise.resolve();};
  Ref.prototype.then=function(a,b){return Promise.resolve().then(a,b);};
  Ref.prototype.catch=function(b){return Promise.resolve().catch(b);};
  Ref.prototype.push=function(v){var k='k'+Math.random().toString(36).slice(2,10);set(this.path+'/'+k,v);notify(this.path);var r=new Ref(this.path+'/'+k);r.key=k;return r;};
  Ref.prototype.child=function(c){return new Ref(this.path+'/'+c);};
  Ref.prototype.transaction=function(fn,cb){var cur=get(this.path);var next=fn(cur);if(next===undefined){if(cb)cb(null,false,new Snap(cur));return Promise.resolve({committed:false});}set(this.path,next);notify(this.path);if(cb)cb(null,true,new Snap(next));return Promise.resolve({committed:true});};
  Ref.prototype.orderByChild=function(){return this;};
  Ref.prototype.equalTo=function(){return this;};
  Ref.prototype.limitToLast=function(){return this;};
  Ref.prototype.limitToFirst=function(){return this;};
  Ref.prototype.startAt=function(){return this;};
  var authObj={currentUser:null,onAuthStateChanged:function(cb){setTimeout(function(){cb(null)},0);},
    signInWithEmailAndPassword:function(){return Promise.reject(Object.assign(new Error('auth/unavailable'),{code:'auth/network-request-failed'}));},
    createUserWithEmailAndPassword:function(){return Promise.reject(Object.assign(new Error('auth/unavailable'),{code:'auth/operation-not-allowed'}));},
    signOut:function(){return Promise.resolve();}};
  window.firebase={initializeApp:function(){},database:function(){return {ref:function(p){return new Ref(p||'root');}};},auth:function(){return authObj;}};
  window.confetti=window.confetti||function(){};
  window.matchMedia=window.matchMedia||function(){return {matches:false,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){}};};
})();
`;

/**
 * @param {'index.html'|'admin/index.html'} file
 * @param {object} opts { store, url }
 */
function boot(file, opts = {}) {
  const store = opts.store || {};
  let html = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  html = html.replace(/<head>/i, '<head><script>' + FIREBASE_MOCK + '</script>');
  // Strip real CDN scripts; the mock replaces them.
  html = html.replace(/<script src="https:\/\/www\.gstatic[^"]*"><\/script>/g, '');
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr[^"]*"><\/script>/g, '');

  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    if (!/Not implemented|scrollTo|navigation/i.test(e.message)) errors.push('[jsdomError] ' + e.message);
  });
  vc.on('error', (...a) => errors.push('[console.error] ' + a.join(' ')));
  vc.on('warn', (...a) => {
    const s = a.join(' ');
    if (!/Firebase|auth\//i.test(s)) errors.push('[console.warn] ' + s);
  });

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: opts.url || ('https://nexus.test/' + (file.startsWith('admin') ? 'admin/' : '')),
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.__SHARED_DB__ = store;
      // Deterministic browser behaviours the UI depends on.
      win.alert = () => {};
      win.confirm = () => true;
      win.prompt = () => opts.promptValue || 'TEST-PROMPT';
      win.scrollTo = () => {};
    },
  });

  const win = dom.window;
  const doc = win.document;
  win.addEventListener('error', e => errors.push('[window.onerror] ' + (e.error && e.error.stack || e.message)));

  const setValue = (selector, value) => {
    const el = doc.querySelector(selector);
    if (!el) throw new Error('missing element ' + selector);
    el.value = value;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  const click = selector => {
    const el = typeof selector === 'string' ? doc.querySelector(selector) : selector;
    if (!el) throw new Error('missing element ' + selector);
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  };
  const toasts = () => [...doc.querySelectorAll('#toasts .toast-msg, #adminToasts .adm-toast')].map(t => t.textContent.trim());
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  return { dom, win, doc, store: win.__FB_STORE, errors, setValue, click, toasts, sleep };
}

module.exports = { boot, FIREBASE_MOCK, REPO_ROOT };
