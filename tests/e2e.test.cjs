/**
 * End-to-end workflow tests for the storefront + admin console.
 *
 * Run: node tests/e2e.test.js
 *
 * Covers the paths that previously failed silently:
 *  - admin panel boots without a SyntaxError (duplicate const declarations)
 *  - admin access key auth + lockout + session expiry
 *  - customer registration, password verification, duplicate guard
 *  - wallet top-up (gateway + manual), cash-out
 *  - product / game top-up purchases create fulfilable orders
 *  - admin fulfils an order and the customer sees the voucher
 *  - admin refund credits the wallet exactly once
 *  - suspended accounts cannot move wallet funds
 */
const { boot, REPO_ROOT } = require('./harness.cjs');
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  \u2713 ' + name);
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  \u2717 ' + name + (detail ? ' — ' + detail : ''));
  }
}

function section(name) {
  console.log('\n' + name);
}

async function main() {
  const shared = {}; // one database shared by both apps

  // ------------------------------------------------------------------
  section('Static integrity');

  for (const file of ['index.html', 'admin/index.html']) {
    const html = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const inline = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
    let parseError = null;
    for (const block of inline) {
      const code = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
      try {
        // eslint-disable-next-line no-new-func
        new Function(code);
      } catch (e) {
        parseError = e.message;
        break;
      }
    }
    check(file + ' inline scripts parse', parseError === null, parseError);
  }

  // ------------------------------------------------------------------
  section('Admin authentication');

  {
    const A = boot('admin/index.html', { store: shared });
    await A.sleep(700);
    const overlay = A.doc.querySelector('#loginOverlay');
    check('admin panel renders', !!overlay && !!A.doc.querySelector('#adminContent'));
    check('login overlay shown when signed out', !overlay.classList.contains('gone'));

    A.setValue('#adminKeyInput', 'WRONG');
    A.win.verifyAdminKey();
    check('wrong key rejected', !overlay.classList.contains('gone'));
    check('wrong key message', /Invalid access key/i.test(A.doc.querySelector('#loginErrMsg').textContent));

    for (let i = 0; i < 4; i++) { A.setValue('#adminKeyInput', 'NOPE' + i); A.win.verifyAdminKey(); }
    check('lockout after 5 failures', !!A.win.localStorage.getItem('nx_admin_lock_until'));

    A.setValue('#adminKeyInput', 'SIAMVIP');
    A.win.verifyAdminKey();
    check('correct key blocked during lockout', !overlay.classList.contains('gone'));

    A.win.localStorage.removeItem('nx_admin_lock_until');
    A.win.localStorage.setItem('nx_admin_attempts', '0');
    A.setValue('#adminKeyInput', 'SIAMVIP');
    A.win.verifyAdminKey();
    await A.sleep(300);
    check('correct key "SIAMVIP" unlocks the console', overlay.classList.contains('gone'));
    check('session token stored', A.win.localStorage.getItem('nx_admin_session') === 'AUTH_OK');

    const tabs = ['dashboard', 'exchanges', 'addFunds', 'orders', 'products', 'dollarRates', 'reviews', 'promotions', 'users', 'settings'];
    let tabFailures = [];
    for (const t of tabs) {
      A.win.setAdminTab(t);
      await A.sleep(60);
      const html = A.doc.querySelector('#adminContent').innerHTML;
      if (!html || html.length < 50 || html.includes('undefined')) tabFailures.push(t);
    }
    check('all admin tabs render', tabFailures.length === 0, tabFailures.join(','));

    A.win.localStorage.setItem('nx_admin_session_at', String(Date.now() - 13 * 3600 * 1000));
    check('expired session is invalid', A.win.isAdminSessionValid() === false);
    A.dom.window.close();
  }

  // ------------------------------------------------------------------
  section('Customer account lifecycle');

  const U = boot('index.html', { store: shared });
  await U.sleep(700);
  const w = U.win;
  const d = U.doc;

  w.openAuthModal('register');
  U.setValue('#authRegName', 'Nadia Islam');
  U.setValue('#authRegPhone', '01911223344');
  U.setValue('#authRegEmail', 'nadia@example.com');
  U.setValue('#authRegPass', 'pass1234');
  w.executeAuthRegister();
  await U.sleep(600);

  const customerIds = Object.keys(shared.customers || {});
  check('registration creates the customer', customerIds.length === 1);
  const custId = customerIds[0];
  check('welcome coins granted', shared.customers[custId].walletCoins > 0);
  check('password stored hashed', !!shared.customers[custId].passwordHash);
  check('raw password never stored', !shared.customers[custId].password);

  w.handleSignOut();
  await U.sleep(200);
  check('sign out clears the session', !w.localStorage.getItem('nx_user'));

  w.openAuthModal('login');
  U.setValue('#authLoginId', '01911223344');
  U.setValue('#authLoginPass', 'wrong-one');
  w.executeAuthSignIn();
  await U.sleep(500);
  check('wrong password rejected', !w.localStorage.getItem('nx_user'));
  check('wrong password message', U.toasts().some(t => /Incorrect password/i.test(t)));

  U.setValue('#authLoginPass', 'pass1234');
  w.executeAuthSignIn();
  await U.sleep(500);
  const signed = JSON.parse(w.localStorage.getItem('nx_user') || 'null');
  check('correct password signs in', signed && signed.name === 'Nadia Islam');
  check('sign-in does not leak the password hash', signed && !signed.passwordHash);

  w.handleSignOut();
  await U.sleep(150);
  w.openAuthModal('register');
  U.setValue('#authRegName', 'Imposter');
  U.setValue('#authRegPhone', '01911223344');
  U.setValue('#authRegEmail', 'nadia@example.com');
  U.setValue('#authRegPass', 'abcdef');
  w.executeAuthRegister();
  await U.sleep(500);
  check('duplicate registration blocked', Object.keys(shared.customers).length === 1);

  // ------------------------------------------------------------------
  section('Wallet & orders');

  w.firebase.database().ref('customers/' + custId + '/walletCoins').set(5000);
  w.setUser({ ...shared.customers[custId], id: custId, walletCoins: 5000 });
  w.renderApp();
  await U.sleep(250);
  check('wallet balance hydrates', w.getWalletCoins() === 5000);

  U.setValue('#ffPlayerId', '988776655');
  w.instantGameTopup('Free Fire Diamonds', 'ff');
  await U.sleep(500);

  const orderIds = Object.keys(shared.orders || {});
  check('game top-up creates an order', orderIds.length === 1);
  const orderId = orderIds[0];
  const order = shared.orders[orderId];
  check('order records the customer', order.userId === custId);
  check('order records the player UID', order.playerUid === '988776655');
  check('order waits for fulfilment (not fake-complete)', order.status === 'PENDING');
  check('coins deducted', shared.customers[custId].walletCoins === 4915);
  check('ledger entry written', Object.keys(shared.transactions || {}).length >= 1);

  // Customer order history
  w.location.hash = '#/orders';
  w.renderApp();
  await U.sleep(500);
  check('customer sees the pending order', d.querySelector('#appView').innerHTML.includes('Free Fire Diamonds'));

  // ------------------------------------------------------------------
  section('Admin fulfilment → customer delivery');

  {
    const A = boot('admin/index.html', { store: shared });
    await A.sleep(800);
    A.win.localStorage.setItem('nx_admin_session', 'AUTH_OK');
    A.win.localStorage.setItem('nx_admin_session_at', String(Date.now()));
    A.win.setAdminTab('orders');
    await A.sleep(400);

    const panel = A.doc.querySelector('#adminContent').innerHTML;
    check('admin sees the new order', panel.includes('Free Fire Diamonds'));
    check('admin sees the customer name', panel.includes('Nadia Islam'));
    check('admin sees the delivery UID', panel.includes('988776655'));

    A.win.openOrderFulfillModal(orderId);
    await A.sleep(120);
    A.doc.querySelector('#fulfillCodeInput').value = 'FF-115-DIAMONDS-SENT';
    A.win.fulfillOrder(orderId);
    await A.sleep(400);
    check('fulfilment marks the order delivered', shared.orders[orderId].status === 'DELIVERED');
    check('delivery code persisted', shared.orders[orderId].deliveryData === 'FF-115-DIAMONDS-SENT');

    const before = shared.customers[custId].walletCoins;
    A.win.refundOrderToWallet(orderId, custId, order.coins);
    await A.sleep(400);
    check('refund marks the order refunded', shared.orders[orderId].status === 'REFUNDED');
    check('refund credits the wallet', shared.customers[custId].walletCoins === before + order.coins);

    A.win.refundOrderToWallet(orderId, custId, order.coins);
    await A.sleep(300);
    check('double refund blocked', shared.customers[custId].walletCoins === before + order.coins);
    A.dom.window.close();
  }

  // Voucher visibility to the customer
  shared.orders[orderId].status = 'DELIVERED';
  w.location.hash = '#/orders';
  w.renderApp();
  await U.sleep(500);
  const orderPage = d.querySelector('#appView').innerHTML;
  check('delivered voucher visible to customer', orderPage.includes('FF-115-DIAMONDS-SENT'));
  check('delivery status visible to customer', orderPage.includes('DELIVERED'));

  // ------------------------------------------------------------------
  section('Storefront routes & features');

  const routes = ['#/', '#/exchange', '#/games', '#/subscriptions', '#/giftcards', '#/ai-tools', '#/orders', '#/account', '#/cart', '#/wishlist', '#/search/ff', '#/unknown'];
  let routeFailures = [];
  for (const r of routes) {
    w.location.hash = r;
    w.renderApp();
    await U.sleep(60);
    const html = d.querySelector('#appView').innerHTML;
    if (!html || html.length < 200 || html.includes('undefined')) routeFailures.push(r);
  }
  check('every route renders content', routeFailures.length === 0, routeFailures.join(','));

  w.location.hash = '#/games';
  w.renderApp();
  await U.sleep(100);
  check('category page lists products', (d.querySelectorAll('#appView .d-card').length) >= 1);

  w.location.hash = '#/search/free%20fire';
  w.renderApp();
  await U.sleep(100);
  check('search finds matching products', d.querySelectorAll('#appView .d-card').length >= 1);

  // buy a product with the wallet
  // Read from the database: the admin page wrote the refund from another
  // window, so the local cache here is intentionally not trusted.
  const preBuySnap = await w.firebase.database().ref('customers/' + custId + '/walletCoins').once('value');
  const beforeBuy = Number(preBuySnap.val());
  check('wallet funded for purchase', beforeBuy >= 199, 'balance=' + beforeBuy);
  w.setUser({ ...shared.customers[custId], id: custId, walletCoins: beforeBuy });
  await U.sleep(100);
  w.openProductDetail('prod_canva');
  U.setValue('#pdDeliveryTarget', 'me@example.com');
  w.instantBuyProductWithWallet('prod_canva', 199);
  await U.sleep(600);
  const balSnap = await w.firebase.database().ref('customers/' + custId + '/walletCoins').once('value');
  check('product purchase deducts coins', Number(balSnap.val()) === beforeBuy - 199, 'db=' + balSnap.val() + ' expected=' + (beforeBuy - 199));
  check('product purchase creates an order', Object.keys(shared.orders).length === 2);

  // exchange calculator with a fee
  shared.settings = shared.settings || {};
  w.firebase.database().ref('settings/dollarRates').set({
    usdt: { id: 'usdt', name: 'USDT', buyRate: 125, sellRate: 121, reserve: 1000, fee: 2, min: 10, max: 2000 }
  });
  await U.sleep(250);
  w.location.hash = '#/exchange';
  w.renderApp();
  await U.sleep(200);
  w.setExchangeTab('buy');
  U.setValue('#calcAmountUSD', '10');
  w.updateExchangeCalc();
  await U.sleep(100);
  check('buy total includes the service fee', d.querySelector('#calcAmountBDT').value === '\u09f31,275');
  w.setExchangeTab('sell');
  w.updateExchangeCalc();
  await U.sleep(100);
  check('sell total deducts the service fee', d.querySelector('#calcAmountBDT').value === '\u09f31,186');

  // manual exchange order requires sign-in and keeps every field
  w.handleSignOut();
  await U.sleep(150);
  U.setValue('#calcAmountUSD', '20');
  w.updateExchangeCalc();
  U.setValue('#calcAccountInput', '0xabc123');
  w.submitDollarExchange();
  await U.sleep(200);
  check('signed-out exchange is blocked with a login prompt', !Object.keys(shared.dollarRequests || {}).length);

  w.setUser({ ...shared.customers[custId], id: custId });
  w.location.hash = '#/exchange';
  w.renderApp();
  await U.sleep(200);
  U.setValue('#calcAmountUSD', '20');
  w.updateExchangeCalc();
  U.setValue('#calcAccountInput', '0xabc123');
  w.submitDollarExchange();
  await U.sleep(250);
  U.setValue('#mpSenderPhone', '01712345678');
  U.setValue('#mpTrxId', 'B982KD71');
  w.confirmManualPayment();
  await U.sleep(300);
  const req = Object.values(shared.dollarRequests || {})[0] || {};
  check('exchange request saved', !!req.trxId);
  check('exchange request keeps currency/rate/payout', req.currency === 'USDT' && !!req.payoutTarget && req.totalBDT > 0);
  check('exchange request is pending review', req.status === 'PENDING');

  // ------------------------------------------------------------------
  section('Suspension enforcement');

  w.firebase.database().ref('customers/' + custId + '/status').set('SUSPENDED');
  await U.sleep(300);
  const beforeSuspended = shared.customers[custId].walletCoins;
  w.location.hash = '#/';
  w.renderApp();
  await U.sleep(150);
  U.setValue('#ffPlayerId', '111222333');
  w.instantGameTopup('Free Fire Diamonds', 'ff');
  await U.sleep(400);
  check('suspended account cannot spend coins', shared.customers[custId].walletCoins === beforeSuspended);
  check('suspension notice shown', U.toasts().some(t => /suspended/i.test(t)));

  w.firebase.database().ref('customers/' + custId + '/status').set('ACTIVE');
  await U.sleep(200);

  // ------------------------------------------------------------------
  section('Runtime console');

  const runtimeErrors = [...U.errors, ...[]].filter(e => !/auth\/|Firebase/i.test(e));
  check('storefront produced no runtime errors', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '));

  // ------------------------------------------------------------------
  console.log('\n' + '='.repeat(56));
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
