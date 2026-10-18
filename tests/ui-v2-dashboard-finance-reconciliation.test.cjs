const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('html', 'utf8');
const from = html.indexOf('function renderPatchedPage()');
const to = html.indexOf('async function refreshOrderEntity(', from);
assert.ok(from >= 0 && to > from, 'canonical order updater is present');
const source = html.slice(from, to);

function harness(page) {
  const calls = [];
  const S = {
    page,
    data: { dashboard: {summary: {
      orders: 1, grossRevenue: 500000, revenue: 500000,
      settledRevenue: 0, unsettledRevenue: 500000,
      cms: 0, debt: 500000
    }, salesDaily: [{sale: 'Pu', settledRevenue: 0, unsettledRevenue: 500000}]},
    orders: {} },
    orders: new Map(),
    dirty: new Set(),
    viewAt: {}
  };
  const sandbox = {
    S,
    rememberOrders: items => items.forEach(o => S.orders.set(o.id, o)),
    orderById: id => S.orders.get(id),
    patchProductionOrder: () => calls.push('production-patch'),
    patchOrdersOrder: () => calls.push('orders-patch'),
    patchDebtOrder: () => calls.push('debt-patch'),
    loadDashboard: force => calls.push('dashboard-fetch:' + force),
    renderDashboard: () => calls.push('dashboard-render'),
    renderProduction: () => calls.push('production-render'),
    renderOrders: () => calls.push('orders-render'),
    renderDebt: () => calls.push('debt-render'),
    renderPayment: () => calls.push('payment-render'),
    Date
  };
  const functions = vm.runInNewContext(source + ';({applyCanonicalOrder,renderPatchedPage})', sandbox);
  return {S, calls, ...functions};
}

test('an unpaid order mutation does not increase settled revenue/commission in cached Dashboard', () => {
  const x = harness('dashboard');
  const unpaid = {id:'QA-NEW', flowerTotal: 2000000, paymentVerified:false, fullPaid:false, settled:false};
  x.applyCanonicalOrder(unpaid, null);
  assert.equal(x.S.data.dashboard.summary.cms, 0);
  assert.equal(x.S.data.dashboard.summary.settledRevenue, 0);
  assert.equal(x.S.data.dashboard.summary.unsettledRevenue, 500000);
  assert.equal(x.S.data.dashboard.salesDaily[0].settledRevenue, 0);
  assert.equal(x.S.dirty.has('getDashboardSummary'), true);
  assert.deepEqual(x.calls.filter(x=>x.startsWith('dashboard-')), ['dashboard-fetch:true']);
});

test('after changing Full Paid / owner / delivery status, Dashboard is re-read on next visit', () => {
  const x = harness('orders');
  const before = {id:'QA-1', flowerTotal:500000, fullPaid:false, settled:false, saleUsername:'pu', status:'Chờ bó'};
  const after = {...before, fullPaid:true, paymentVerified:true, status:'Đã giao', saleUsername:'qa_sale'};
  x.applyCanonicalOrder(after, before);
  assert.equal(x.S.dirty.has('getDashboardSummary'),true);
  assert.equal(x.S.viewAt.getDashboardSummary, undefined);
  assert.equal(x.calls.includes('orders-render'),true);
  assert.equal(x.calls.some(x=>x.startsWith('dashboard-')),false);
  x.S.page = 'dashboard';
  x.renderPatchedPage();
  assert.equal(x.calls.at(-1),'dashboard-fetch:true');
  assert.equal(x.S.data.dashboard.summary.settledRevenue,0);
});

test('deferred bulk status updates batch a single authoritative Dashboard refresh', () => {
  const x = harness('dashboard');
  for (let i=0;i<4;i++) x.applyCanonicalOrder({id:'QA-'+i,status:'Đã bó',flowerTotal:500000},null,true);
  assert.equal(x.calls.filter(x=>x.startsWith('dashboard-')).length,0);
  x.renderPatchedPage();
  assert.equal(x.calls.filter(x=>x.startsWith('dashboard-')).length,1);
  assert.equal(x.S.dirty.has('getDashboardSummary'),true);
});

test('remove retired partial Dashboard financial updater instead of layering a hotfix', () => {
  assert.doesNotMatch(html,/function dashboardApplyStats\(/);
  assert.doesNotMatch(html,/function patchDashboardOrder\(/);
  assert.match(source,/S\.dirty\.add\('getDashboardSummary'\)/);
});
