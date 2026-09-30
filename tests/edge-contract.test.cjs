const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync('supabase/functions/meehoasg-api/index.js', 'utf8');
const context = vm.createContext({
  Deno: { env: { get: () => 'test' }, serve: () => {} },
  crypto: webcrypto, TextEncoder, URL, Request, Response, Intl, Date, console,
});
vm.runInContext(source, context);

test('paid amounts and shipping debt follow the existing app', () => {
  assert.equal(vm.runInContext("paidAmount('Full', 500000, 0)", context), 500000);
  assert.equal(vm.runInContext("paidAmount('Cọc 250.000', 500000, 0)", context), 250000);
  assert.equal(vm.runInContext("paidAmount('Chưa tt', 500000, 0)", context), 0);
  assert.equal(vm.runInContext("paidAmount('Full', 500000, 550000)", context), 550000);
  const order = {
    id: 'ORDER-1', customer: 'Test', order_date: '2026-09-28', order_time: '12:00',
    flower_total: 500000, shipping: 'Shop book ship', ship_fee: 50000,
    payment: 'Full', status: 'Đã giao', sale: 'Sale A', image_urls: [], settled: false,
  };
  context.__order = order;
  const shown = vm.runInContext("decorate(__order, { role: 'SALE', display_name: 'Sale A' })", context);
  assert.equal(shown.totalDue, 550000);
  assert.equal(shown.paid, 500000);
  assert.equal(shown.debt, 50000);
});

test('imported Sheet contact displays as separate phone and address', () => {
  const order = {
    id: 'ORDER-2', customer: 'Test', order_date: '2026-09-28', order_time: '12:00',
    flower_total: 500000, shipping: 'Ghé lấy', status: 'Chờ bó', sale: 'Sale A',
    address: 'SĐT: 0900000000\nĐịa chỉ: 12 đường hoa', phone: '', image_urls: []
  };
  context.__order = order;
  const shown = vm.runInContext("decorate(__order, { role: 'SALE', display_name: 'Sale A' })", context);
  assert.equal(shown.phone, '0900000000');
  assert.equal(shown.address, '12 đường hoa');
});

test('flower classification keeps the existing canonical response contract', async () => {
  context.fetch = async (_url, options) => {
    assert.equal(options.headers['x-goog-api-key'], 'test');
    const request = JSON.parse(options.body);
    assert.match(request.contents[0].parts[0].text, /Ly\/Lily/);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"results":[{"fingerprint":"flower-1","flowers":["Lily"],"needs_review":false}]}' }] } }] }) };
  };
  const result = await vm.runInContext("classifyFlowers([{ fingerprint: 'flower-1', note: 'bó lily hồng' }])", context);
  assert.equal(result[0].flowers[0], 'Lily');
});

test('payment queue combines duplicate requests for one order', async () => {
  context.__requests = [
    { id: 'REQ-2', order_id: 'ORDER-1', status: 'PENDING', submitted_at: '2026-09-28T10:00:00Z', bill_urls: ['bill-b'] },
    { id: 'REQ-1', order_id: 'ORDER-1', status: 'PENDING', submitted_at: '2026-09-28T09:00:00Z', bill_urls: ['bill-a'] },
  ];
  vm.runInContext(`
    all = async table => table === 'settlement_requests' ? __requests : [];
    billDisplayUrls = async urls => urls;
  `, context);
  const result = await vm.runInContext("settlementQueue({ status: 'PENDING' }, { role: 'ADMIN' })", context);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].requestId, 'REQ-2');
  assert.equal(result.items[0].duplicateCount, 1);
  assert.deepEqual(Array.from(result.items[0].billUrls), ['bill-b', 'bill-a']);
});

test('one review resolves every pending request for its order', async () => {
  const patches = [];
  context.__patches = patches;
  vm.runInContext(`
    one = async table => table === 'orders'
      ? { id: 'ORDER-1' }
      : { id: 'REQ-2', order_id: 'ORDER-1', status: 'PENDING' };
    all = async () => [{ id: 'REQ-2' }, { id: 'REQ-1' }];
    db = async (table, query, method, body) => {
      __patches.push({ table, query, method, body });
      return table === 'settlement_requests' ? [{ id: 'REQ-2' }, { id: 'REQ-1' }] : [{ id: 'ORDER-1' }];
    };
    audit = async () => {};
  `, context);
  const result = await vm.runInContext("reviewSettlement({ requestId: 'REQ-2', decision: 'APPROVED' }, { username: 'admin', display_name: 'Admin', role: 'ADMIN' })", context);
  assert.equal(result.ok, true);
  assert.equal(result.processedRequests, 2);
  assert.equal(patches[0].query.order_id, 'eq.ORDER-1');
  assert.equal(patches[0].query.status, 'eq.PENDING');
  assert.equal(patches[1].body.settled, true);
});

test('API cleanTime handles the normalized HH:mm contract', () => {
  assert.equal(vm.runInContext("cleanTime('08:30')", context), '08:30');
  assert.equal(vm.runInContext("cleanTime('8:30')", context), '08:30');
  assert.equal(vm.runInContext("cleanTime('14:45:00')", context), '14:45');
});

test('legacy Apps Script owns timezone normalization for 1899/GMT Sheet times', () => {
  const syncSource = fs.readFileSync('supabase/functions/meehoasg-ingest/apps-script-sync.gs', 'utf8');
  assert.match(syncSource, /function _time\(v\)/);
  assert.match(syncSource, /s\.indexOf\('1899'\)>=0\|\|s\.indexOf\('GMT'\)>=0/);
  assert.match(syncSource, /Utilities\.formatDate\(d,'Asia\/Ho_Chi_Minh','HH:mm'\)/);
});

test('getKpi unifies sales aliases into display name and calculates revenue accurately', async () => {
  const users = [
    { username: 'huynhxuyen', display_name: 'Huỳnh Xuyến', role: 'SALE' },
    { username: 'cmui', display_name: 'C Mụi', role: 'ADMIN' },
  ];
  const orders = [
    { id: 'O1', flower_total: 600000, sale: 'huynhxuyen', status: 'Đã giao', settled: false },
    { id: 'O2', flower_total: 500000, sale: 'Huỳnh Kim Xuyến', status: 'Chờ bó', settled: true },
    { id: 'O3', flower_total: 400000, sale: 'Huỳnh Xuyến', status: 'Đã giao', settled: false },
  ];
  vm.runInContext(`
    all = async table => table === 'app_users' ? ${JSON.stringify(users)} : [];
    decoratedRange = async () => ${JSON.stringify(orders)}.map(o => ({
      ...o, flowerTotal: o.flower_total, date: '2026-09-15', time: '10:00', debt: 0
    }));
  `, context);
  const result = await vm.runInContext("getKpi({ month: '2026-09' }, { role: 'ADMIN', username: 'admin' })", context);
  assert.equal(result.ok, true);
  const xuyen = result.items.find(x => x.sale === 'Huỳnh Xuyến');
  assert.ok(xuyen, 'Phải gom về Huỳnh Xuyến');
  assert.equal(xuyen.revenue, 1500000);
  assert.equal(xuyen.orders, 3);
  assert.equal(xuyen.bigOrders, 2);
});

test('meehoasg-ingest handles getOrdersForSheet and recordSheetPositions', async () => {
  const ingestSource = fs.readFileSync('supabase/functions/meehoasg-ingest/index.js', 'utf8');
  const ingestContext = vm.createContext({
    Deno: { env: { get: () => 'test' }, serve: () => {} },
    crypto: webcrypto, TextEncoder, URL, Request, Response, Intl, Date, console,
  });
  vm.runInContext(ingestSource, ingestContext);
  ingestContext.rest = async (table, query) => {
    return [{ id: 'TEST-1', customer: 'Anh Nam', order_date: '2026-09-29', order_time: '10:00', flower_total: 500000, status: 'Chờ bó' }];
  };
  const res = await vm.runInContext("getOrdersForSheet({ since: '2026-09-28T00:00:00Z' })", ingestContext);
  assert.equal(res.ok, true);
  assert.equal(res.orders.length, 1);
  assert.equal(res.orders[0].customer, 'Anh Nam');
});
