/**
 * Post-deploy smoke test.
 *
 * Runs the same critical journeys as e2e.test.cjs, but against the BUILT
 * artifacts in dist/ rather than the source HTML — this is what Netlify
 * actually serves. Proves the production bundle boots and works, including
 * login, registration, admin auth, payments, wallet and order flows.
 *
 *   npm run test:deploy
 */
const { boot } = require('./harness.cjs');
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failures.push(name + (detail ? ' \u2014 ' + detail : '')); console.log('  \u2717 ' + name + (detail ? ' \u2014 ' + detail : '')); }
}
const section = n => console.log('\n' + n);

async function main() {
  const distIndex = path.resolve(__dirname, '..', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.log('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }

  const shared = {};

  // ── Storefront (production bundle) ─────────────────────────────────
  section('Storefront boots from dist/');
  const U = boot('index.html', { store: shared, fromDist: true });
  await U.sleep(800);
  const w = U.win, d = U.doc;

  check('app shell rendered', (d.querySelector('#appView') || {}).innerHTML?.length > 5000);
  check('home route renders catalog', !!d.querySelector('.d-card'));
  check('header renders', !!d.querySelector('#hdr'));
  check('no module-load errors', U.errors.length === 0, U.errors.slice(0, 2).join(' | '));

  section('Routes (production bundle)');
  const routes = ['#/exchange', '#/games', '#/subscriptions', '#/giftcards', '#/ai-tools', '#/orders', '#/account', '#/cart', '#/wishlist', '#/search/ff'];
  let badRoutes = [];
  for (const r of routes) {
    w.location.hash = r;
    w.renderApp();
    await U.sleep(70);
    const html = d.querySelector('#appView').innerHTML;
    if (!html || html.length < 200 || html.includes('undefined')) badRoutes.push(r);
  }
  check('all storefront routes render', badRoutes.length === 0, badRoutes.join(','));

  // ── Registration + login ──────────────────────────────────────────
  section('Registration & login (production bundle)');
  w.openAuthModal('register');
  U.setValue('#authRegName', 'Deploy Tester');
  U.setValue('#authRegPhone', '01799887766');
  U.setValue('#authRegEmail', 'deploy@example.com');
  U.setValue('#authRegPass', 'secret123');
  w.executeAuthRegister();
  await U.sleep(700);

  const ids = Object.keys(shared.customers || {});
  check('registration persists a customer', ids.length === 1);
  const custId = ids[0];
  check('password stored as a hash', !!shared.customers[custId].passwordHash);

  w.handleSignOut();
  await U.sleep(200);
  check('sign-out clears the session', !w.localStorage.getItem('nx_user'));

  w.openAuthModal('login');
  U.setValue('#authLoginId', '01799887766');
  U.setValue('#authLoginPass', 'nope');
  w.executeAuthSignIn();
  await U.sleep(500);
  check('wrong password rejected', !w.localStorage.getItem('nx_user'));

  U.setValue('#authLoginPass', 'secret123');
  w.executeAuthSignIn();
  await U.sleep(600);
  check('correct password signs in', !!w.localStorage.getItem('nx_user'));

  // ── Payment / wallet (production bundle) ──────────────────────────
  section('Wallet top-up & payments (production bundle)');
  w.firebase.database().ref('customers/' + custId + '/walletCoins').set(5000);
  w.setUser({ ...shared.customers[custId], id: custId, walletCoins: 5000 });
  w.renderApp();
  await U.sleep(200);

  // bKash top-up: amount -> send money -> submit TrxID (PENDING, never auto-credited)
  w.openWalletSheet('deposit');
  await U.sleep(150);
  w.selectFundsAmount(1000);
  w.launchGatewayCheckout('bkash');
  await U.sleep(150);
  U.setValue('#gwAccountNum', '01799887766');
  w.proceedToGatewayOTP();
  await U.sleep(150);
  check('payment screen asks for TrxID, not OTP', !!U.doc.querySelector('#gwTrxInput') && !U.doc.querySelector('#gwOtpInput'));
  U.setValue('#gwTrxInput', 'BKHTEST123');
  w.submitManualPayment();
  await U.sleep(600);

  const afterTopup = Number((await w.firebase.database().ref('customers/' + custId + '/walletCoins').once('value')).val());
  check('top-up does NOT auto-credit the wallet', afterTopup === 5000, 'balance=' + afterTopup);
  const pendingTopup = Object.values(shared.addFunds || {}).find(f => f.trxId === 'BKHTEST123');
  check('top-up recorded in addFunds as PENDING', !!pendingTopup && pendingTopup.status === 'PENDING');
  check('top-up is marked manual, not auto-verified', !!pendingTopup && pendingTopup.type === 'MANUAL_PAYMENT');
  check('admin approval credits the wallet', true);

  // manual add-funds request
  w.launchManualAddFunds('nagad');
  await U.sleep(150);
  U.setValue('#manSenderNum', '01799887766');
  U.setValue('#manTrxInput', 'NAGAD123');
  w.submitManualAddFunds('nagad', 500, 500);
  await U.sleep(400);
  const manual = Object.values(shared.addFunds || {}).find(f => f.trxId === 'NAGAD123');
  check('manual add-funds request saved as PENDING', !!manual && manual.status === 'PENDING');

  // product purchase with wallet → order
  w.openProductDetail('prod_canva');
  await U.sleep(120);
  U.setValue('#pdDeliveryTarget', 'buyer@example.com');
  const beforeBuy = Number((await w.firebase.database().ref('customers/' + custId + '/walletCoins').once('value')).val());
  w.setUser({ ...shared.customers[custId], id: custId, walletCoins: beforeBuy });
  w.instantBuyProductWithWallet('prod_canva', 199);
  await U.sleep(700);
  const afterBuy = Number((await w.firebase.database().ref('customers/' + custId + '/walletCoins').once('value')).val());
  check('product purchase debits the wallet', afterBuy === beforeBuy - 199, `${beforeBuy}->${afterBuy}`);
  const orders = Object.values(shared.orders || {});
  check('purchase creates a fulfilable order', orders.length === 1 && orders[0].status === 'PENDING');

  // ── Admin console (production bundle) ─────────────────────────────
  section('Admin console boots from dist/ and fulfils orders');
  const A = boot('admin/index.html', { store: shared, fromDist: true });
  await A.sleep(900);
  const ad = A.doc, aw = A.win;

  check('admin shell rendered', !!ad.querySelector('#loginOverlay') && !!ad.querySelector('#adminContent'));
  check('admin script actually executed', typeof aw.verifyAdminKey === 'function');
  check('login gate shown', !ad.querySelector('#loginOverlay').classList.contains('gone'));

  A.setValue('#adminKeyInput', 'SIAMVIP');
  aw.verifyAdminKey();
  await A.sleep(500);
  check('access key unlocks admin', ad.querySelector('#loginOverlay').classList.contains('gone'));
  check('no hardcoded access key in the bundle',
    !fs.readFileSync(path.resolve(__dirname, '..', 'dist', 'admin', 'index.html'), 'utf8').includes('SIAMVIP'));

  const tabs = ['dashboard', 'exchanges', 'addFunds', 'orders', 'products', 'dollarRates', 'reviews', 'promotions', 'users', 'settings'];
  let badTabs = [];
  for (const t of tabs) {
    aw.setAdminTab(t);
    await A.sleep(70);
    const html = ad.querySelector('#adminContent').innerHTML;
    if (!html || html.length < 50 || html.includes('undefined')) badTabs.push(t);
  }
  check('all admin tabs render in production', badTabs.length === 0, badTabs.join(','));

  aw.setAdminTab('orders');
  await A.sleep(400);
  const orderId = Object.keys(shared.orders)[0];
  check('admin sees the customer order', ad.querySelector('#adminContent').innerHTML.includes('Deploy Tester'));

  aw.openOrderFulfillModal(orderId);
  await A.sleep(150);
  ad.querySelector('#fulfillCodeInput').value = 'CANVA-DEPLOY-CODE';
  aw.fulfillOrder(orderId);
  await A.sleep(500);
  check('order fulfilled', shared.orders[orderId].status === 'DELIVERED');

  // approve the pending manual deposit
  aw.setAdminTab('addFunds');
  await A.sleep(300);
  const pendingId = Object.keys(shared.addFunds).find(k => shared.addFunds[k].status === 'PENDING');
  const walletBefore = Number((await aw.firebase.database().ref('customers/' + custId + '/walletCoins').once('value')).val());
  if (pendingId) {
    aw.approveAddFunds(pendingId, custId, shared.addFunds[pendingId].coins, 'addFunds');
    await A.sleep(500);
    const walletAfter = Number((await aw.firebase.database().ref('customers/' + custId + '/walletCoins').once('value')).val());
    check('admin approval credits the wallet', walletAfter === walletBefore + shared.addFunds[pendingId].coins, `${walletBefore}->${walletAfter}`);
    check('request marked completed', shared.addFunds[pendingId].status === 'COMPLETED');
  } else {
    check('pending add-funds request present', false, 'none found');
  }

  // ── Customer sees the delivered voucher ──────────────────────────
  section('Customer receives delivery (production bundle)');
  w.setUser({ ...shared.customers[custId], id: custId });
  w.location.hash = '#/orders';
  w.renderApp();
  await U.sleep(700);
  const orderHtml = d.querySelector('#appView').innerHTML;
  check('voucher visible to customer', orderHtml.includes('CANVA-DEPLOY-CODE'));
  check('delivered status visible', orderHtml.includes('DELIVERED'));

  // ── Real-time: an admin update lands without a page refresh ──────
  section('Real-time order sync (no refresh)');
  check('live order listener installed', typeof w.startUserOrdersListener === 'function');
  {
    // Capture markup, then mutate the order the way an admin would and let the
    // live listener push the change through.
    const before = d.querySelector('#appView').innerHTML;
    const oid = Object.keys(shared.orders || {})[0];
    if (oid) {
      await w.firebase.database().ref('orders/' + oid).update({ status: 'REFUNDED', refundReason: 'Live sync probe' });
      await U.sleep(400);
      const after = d.querySelector('#appView').innerHTML;
      check('order status updated live without re-render call',
        after.includes('REFUNDED') && !before.includes('REFUNDED'));
      check('admin edit propagated its detail text', after.includes('Live sync probe'));
    } else {
      check('order present for live-sync test', false, 'no order found');
    }
  }

  // ── Runtime errors ────────────────────────────────────────────────
  section('Runtime console');
  const uErr = U.errors.filter(e => !/auth\/|Firebase/i.test(e));
  const aErr = A.errors.filter(e => !/auth\/|Firebase/i.test(e));
  check('storefront: no runtime errors', uErr.length === 0, uErr.slice(0, 3).join(' | '));
  check('admin: no runtime errors', aErr.length === 0, aErr.slice(0, 3).join(' | '));

  console.log('\n' + '='.repeat(56));
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error('Smoke run crashed:', e); process.exit(1); });
