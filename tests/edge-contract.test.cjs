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
