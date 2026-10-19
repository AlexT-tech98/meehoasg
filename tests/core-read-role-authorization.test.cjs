'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const sourcePath = path.join(__dirname, '../supabase/functions/meehoasg-api-core/index.js');
const source = fs.readFileSync(sourcePath, 'utf8').replace(/^import .*\n/gm, '');
const endpoint = 'https://isolated-authorization.test';
const token = 'a1'.repeat(32);
const tokenHash = createHash('sha256').update(token).digest('hex');
const day = '2026-10-18';
const omittedToken = Symbol('omitted token');

function fixtureOrder(overrides = {}) {
  return {
    id: 'QA-ROLE-ONE', updated_at: '2026-10-18T00:00:00Z',
    customer: 'Isolated authorization fixture', phone: '', address: 'QA address',
    order_date: day, order_time: '09:30:00', flower: 'QA flowers', note: 'QA only',
    sale: 'QA Sale', status: 'Đã giao', shipping: 'Shop book ship',
    flower_total: 600000, payment: 'Cọc 250.000', settled: false,
    full_paid: false, full_paid_total: 0, full_paid_bill_urls: [],
    card: true, card_qty: 2, banner: true, banner_qty: 2,
    charm_fee: 15000, paper_fee: 10000, vat: 60000,
    ship_fee: 25000, ship_confirmed: true, image_urls: [],
    ...overrides
  };
}

function harness({ role = 'ADMIN', active = true, session = 'valid', order = fixtureOrder() } = {}) {
  let handler;
  const calls = [];
  const forbidden = [];
  const actor = { username: 'qa_' + role.toLowerCase(), display_name: 'QA ' + role, role, active };
  const directory = [actor, { username: 'qa_sale', display_name: 'QA Sale', role: 'SALE', active: true }];
  function refuse(reason) {
    forbidden.push(reason);
    throw new Error(reason);
  }
  const context = {
    URL, TextEncoder, Request, Response, Date, Intl, crypto: webcrypto,
    console: { error() {}, warn() {}, log() {} },
    // Imported operation factories are irrelevant to these reads. Any accidental
    // operation/storage execution must fail; authentication itself is never stubbed.
    createOperationStorage: () => ({
      uploadImages: async () => refuse('Unexpected image upload'),
      discard: async () => refuse('Unexpected image discard')
    }),
    createOperationService: () => ({ run: async () => refuse('Unexpected business mutation') }),
    Deno: {
      env: { get: key => ({ SUPABASE_URL: endpoint, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' })[key] },
      serve: callback => { handler = callback; }
    },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input));
      const method = options.method || 'GET';
      const table = url.pathname.replace(/^\/rest\/v1\//, '');
      const filteredUser = table === 'app_users' && url.searchParams.has('username');
      calls.push({ table, method, directory: table === 'app_users' && !filteredUser });
      if (url.origin !== endpoint || !url.pathname.startsWith('/rest/v1/')) return refuse('Unexpected network destination');
      if (method !== 'GET' || options.body !== undefined) return refuse('Unexpected network mutation');
      if (options.headers?.Authorization !== 'Bearer synthetic-service-key') return refuse('Unexpected DB credentials');
      let result;
      if (table === 'app_sessions') {
        assert.equal(url.searchParams.get('token_hash'), 'eq.' + tokenHash, 'Real requireUser must hash and filter the supplied token');
        assert.equal(url.searchParams.get('limit'), '1');
        result = session === 'missing' ? [] : [{
          username: actor.username,
          expires_at: new Date(Date.now() + (session === 'expired' ? -86400000 : 86400000)).toISOString()
        }];
      } else if (filteredUser) {
        assert.equal(url.searchParams.get('username'), 'eq.' + actor.username, 'Real requireUser must look up the authenticated session owner');
        assert.equal(url.searchParams.get('limit'), '1');
        result = [actor];
      } else if (table === 'app_users') {
        assert.equal(url.searchParams.get('select'), 'username,display_name,role,active');
        result = directory;
      } else if (table === 'orders') {
        assert.match(url.searchParams.get('and') || '', /order_date\.gte\.2026-10-18,order_date\.lte\.2026-10-18/);
        result = [order];
      } else if (table === 'settlement_requests') {
        assert.match(url.searchParams.get('order_id') || '', /QA-ROLE-ONE/);
        result = [];
      } else {
        return refuse('Unexpected database table');
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  assert.equal(typeof handler, 'function', 'Actual source must install its HTTP handler');
  return {
    calls,
    async request(name, suppliedToken = token) {
      const payload = { start: day, end: day, date: day, ...(suppliedToken === omittedToken ? {} : { token: suppliedToken }) };
      const response = await handler(new Request(endpoint + '/functions/v1/meehoasg-api-core', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://ops.meehoasg.com' },
        body: JSON.stringify({ name, payload })
      }));
      assert.equal(response.status, 200, 'Core returns its established JSON envelope for read/auth results');
      assert.deepEqual(forbidden, [], 'No unexpected network call or mutation may execute');
      return response.json();
    }
  };
}

function assertNoBusinessRead(h) {
  assert.equal(h.calls.some(call => call.table === 'orders' || call.table === 'settlement_requests' || call.directory), false,
    'Denied requests must stop before fetching orders, settlements, or the full user directory');
}

function assertDenied(result, h) {
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTH_REQUIRED');
  assert.match(result.message, /Không có quyền|Phiên đăng nhập|Tài khoản đã bị khóa/);
  const financeFields = new Set(['summary', 'orders', 'items', 'initial', 'attention', 'attentionGroups', 'salesDaily',
    'revenue', 'grossRevenue', 'settledRevenue', 'unsettledRevenue', 'debt', 'cms', 'flowerTotal', 'paid', 'totalDue']);
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(financeFields.has(key), false, 'Denied response must not expose business or finance field ' + key);
      inspect(child);
    }
  };
  inspect(result);
  assertNoBusinessRead(h);
}

for (const role of ['SALE', 'THO_OPS']) {
  test('Dashboard HTTP read denies active ' + role + ' before loading finance or directory', async () => {
    const h = harness({ role });
    assertDenied(await h.request('getDashboardSummary'), h);
    assert.deepEqual(h.calls.map(call => call.table), ['app_sessions', 'app_users']);
  });
}

test('Production HTTP read denies active SALE before loading orders or directory', async () => {
  const h = harness({ role: 'SALE' });
  assertDenied(await h.request('getProductionOrders'), h);
  assert.deepEqual(h.calls.map(call => call.table), ['app_sessions', 'app_users']);
});

for (const verified of [false, true]) {
  test('ADMIN Dashboard preserves ' + (verified ? 'Full Paid' : 'unverified') + ' finance calculations', async () => {
    const h = harness({ order: fixtureOrder({ full_paid: verified, full_paid_total: verified ? 800000 : 0 }) });
    const result = await h.request('getDashboardSummary');
    assert.equal(result.ok, true);
    assert.equal(result.summary.orders, 1);
    assert.equal(result.summary.revenue, 600000);
    assert.equal(result.summary.grossRevenue, 600000);
    assert.equal(result.summary.settledRevenue, verified ? 600000 : 0);
    assert.equal(result.summary.unsettledRevenue, verified ? 0 : 600000);
    assert.equal(result.summary.cms, verified ? 48000 : 0);
    assert.equal(result.summary.debt, verified ? 0 : 550000);
    assert.equal(result.summary.unsettled, verified ? 0 : 1);
    assert.equal(result.revenueRule, 'PAYMENT_VERIFIED');
    assert.equal(result.salesDaily.length, 1);
    assert.equal(result.salesDaily[0].saleUsername, 'qa_sale');
    assert.equal(result.salesDaily[0].grossRevenue, 600000);
    assert.equal(result.salesDaily[0].revenue, verified ? 600000 : 0);
    assert.equal(result.hourlyCounts.reduce((sum, row) => sum + row.count, result.hourlyUnknown), 1);
    assert.ok(h.calls.some(call => call.table === 'orders'));
    assert.ok(h.calls.some(call => call.table === 'settlement_requests'));
    assert.ok(h.calls.some(call => call.directory));
    assert.equal(result._perf.legacyFallback, false);
  });
}

for (const role of ['ADMIN', 'THO_OPS']) {
  test('Production HTTP read permits active ' + role + ' with unchanged order finance', async () => {
    const h = harness({ role });
    const result = await h.request('getProductionOrders');
    assert.equal(result.ok, true);
    assert.equal(result.orders.length, 1);
    const order = result.orders[0];
    assert.equal(order.id, 'QA-ROLE-ONE');
    assert.equal(order.flowerTotal, 600000);
    assert.equal(order.accessoryTotal, 115000);
    assert.equal(order.totalDue, 800000);
    assert.equal(order.paid, 250000);
    assert.equal(order.debt, 550000);
    assert.equal(order.canOperate, true);
    assert.equal(result._perf.legacyFallback, false);
  });
}

for (const name of ['getDashboardSummary', 'getProductionOrders']) {
  test(name + ' rejects anonymous or malformed tokens without any DB query', async () => {
    for (const invalid of [omittedToken, '', 'not-a-session', 'a'.repeat(63), 'g'.repeat(64), null]) {
      const h = harness();
      assertDenied(await h.request(name, invalid), h);
      assert.deepEqual(h.calls, []);
    }
  });

  for (const session of ['missing', 'expired']) {
    test(name + ' rejects a ' + session + ' session without loading users or finance', async () => {
      const h = harness({ session });
      assertDenied(await h.request(name), h);
      assert.deepEqual(h.calls.map(call => call.table), ['app_sessions']);
    });
  }
}

for (const [name, role] of [
  ['getDashboardSummary', 'ADMIN'],
  ['getDashboardSummary', 'THO_OPS'],
  ['getProductionOrders', 'ADMIN'],
  ['getProductionOrders', 'THO_OPS']
]) {
  test(name + ' rejects inactive ' + role + ' before loading business data', async () => {
    const h = harness({ role, active: false });
    assertDenied(await h.request(name), h);
    assert.deepEqual(h.calls.map(call => call.table), ['app_sessions', 'app_users']);
  });
}
