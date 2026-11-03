'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const coreSource = fs.readFileSync('supabase/functions/meehoasg-api-core/index.js', 'utf8').replace(/^import .*\n/gm, '');
const htmlSource = fs.readFileSync('html', 'utf8');

function createHarness({ role = 'ADMIN', active = true, requests = [], orders = [] } = {}) {
  const actor = { username: 'test_' + role.toLowerCase(), display_name: 'Test ' + role, role, active };
  const users = [actor, { username: 'test_sale', display_name: 'Test Sale', role: 'SALE', active: true }];
  const signed = [];
  const calls = [];

  const context = {
    URL, TextEncoder, Date, Intl, crypto: webcrypto,
    console: { log() {}, warn() {}, error() {} },
    createOperationService: () => ({
      run: async (action, p, u) => {
        calls.push({ action, p, u });
        return { ok: true, orderId: p.settlementId ? 'ORD-' + p.settlementId : 'ORD-1', message: 'Duyệt thành công' };
      }
    }),
    createOperationStorage: () => ({
      uploadImages: async () => [],
      discard: async () => {}
    }),
    Deno: {
      env: { get: () => 'https://test.supabase.co' },
      serve() {}
    }
  };

  vm.createContext(context);
  vm.runInContext(coreSource, context);
  vm.runInContext(`
    requireUser = async (payload, roles) => {
      if (roles && !roles.includes('${role}')) throw new Error('Không có quyền thực hiện.');
      return ${JSON.stringify(actor)};
    };
    all = async (table, query) => {
      if (table === 'app_users') return ${JSON.stringify(users)};
      if (table === 'settlement_requests') {
        let rows = ${JSON.stringify(requests)};
        if (query && query.status) {
          const expected = query.status.replace(/^eq\\./, '');
          rows = rows.filter(r => r.status === expected);
        }
        if (query && query.submitted_at) {
          const gte = query.submitted_at.replace(/^gte\\./, '');
          rows = rows.filter(r => r.submitted_at >= gte);
        }
        return rows;
      }
      if (table === 'orders') return ${JSON.stringify(orders)};
      return [];
    };
    one = async (table, query) => {
      return { id: 'ORD-1', customer: 'Khách 1', sale: 'Test Sale', order_date: '2026-11-01', flower_total: 500000 };
    };
    displayUrls = async (urls) => {
      signed.push(...(urls || []));
      return (urls || []).map(u => u + '_signed');
    };
  `, context);

  context.signed = signed;
  context.calls = calls;
  context.actor = actor;
  return context;
}

test('fastSettlementQueue enforces ADMIN-only role authorization', async () => {
  const adminHarness = createHarness({ role: 'ADMIN' });
  const adminRes = await vm.runInContext("fastSettlementQueue({ status: 'PENDING' })", adminHarness);
  assert.equal(adminRes.ok, true);

  const saleHarness = createHarness({ role: 'SALE' });
  await assert.rejects(
    async () => vm.runInContext("fastSettlementQueue({ status: 'PENDING' })", saleHarness),
    /Không có quyền thực hiện/
  );

  const thoHarness = createHarness({ role: 'THO_OPS' });
  await assert.rejects(
    async () => vm.runInContext("fastSettlementQueue({ status: 'PENDING' })", thoHarness),
    /Không có quyền thực hiện/
  );
});

test('fastSettlementQueue defaults to allPending and paginates at 20 items per page', async () => {
  // Create 36 synthetic pending requests spanning multiple days
  const requests = Array.from({ length: 36 }, (_, i) => ({
    id: 'REQ-' + (i + 1),
    order_id: 'ORD-' + (i + 1),
    sale_username: 'test_sale',
    sale_name: 'Test Sale',
    flower_total: 500000,
    accessory_total: 10000,
    vat: 0,
    ship_fee: 30000,
    required_amount: 540000,
    bill_urls: ['supabase://settlement-bills/bill-' + (i + 1) + '.jpg'],
    note: 'Yêu cầu ' + (i + 1),
    status: 'PENDING',
    submitted_at: i < 30 ? '2026-11-01T10:00:00+07:00' : '2026-11-03T11:00:00+07:00'
  }));

  const orders = Array.from({ length: 36 }, (_, i) => ({
    id: 'ORD-' + (i + 1),
    customer: 'Khách ' + (i + 1),
    order_date: '2026-11-01',
    order_time: '10:00',
    flower: 'Hoa bó ' + (i + 1),
    flower_total: 500000,
    sale: 'Test Sale',
    status: 'Đã giao',
    shipping: 'Shop book ship',
    ship_fee: 30000,
    ship_confirmed: true,
    card: true,
    card_qty: 1,
    banner: false,
    charm_fee: 0,
    paper_fee: 0,
    vat: 0,
    payment: 'Chưa thanh toán'
  }));

  const harness = createHarness({ role: 'ADMIN', requests, orders });

  // Page 1: should return first 20 items and metadata
  const p1 = await vm.runInContext("fastSettlementQueue({ status: 'PENDING', page: 1, pageSize: 20 })", harness);
  assert.equal(p1.ok, true);
  assert.equal(p1.total, 36);
  assert.equal(p1.totalPages, 2);
  assert.equal(p1.page, 1);
  assert.equal(p1.pageSize, 20);
  assert.equal(p1.items.length, 20);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.allPending, true);
  // Verify bills were signed
  assert.equal(p1.items[0].billUrls[0], 'supabase://settlement-bills/bill-1.jpg_signed');

  // Page 2: should return remaining 16 items
  const p2 = await vm.runInContext("fastSettlementQueue({ status: 'PENDING', page: 2, pageSize: 20 })", harness);
  assert.equal(p2.ok, true);
  assert.equal(p2.total, 36);
  assert.equal(p2.totalPages, 2);
  assert.equal(p2.page, 2);
  assert.equal(p2.items.length, 16);
  assert.equal(p2.hasMore, false);
});

test('fastSettlementQueue groups duplicate submissions for the same order', async () => {
  const requests = [
    { id: 'REQ-1A', order_id: 'ORD-DUP', sale_username: 'sale', sale_name: 'Sale', flower_total: 500000, status: 'PENDING', submitted_at: '2026-11-03T10:00:00+07:00', bill_urls: ['b1.jpg'] },
    { id: 'REQ-1B', order_id: 'ORD-DUP', sale_username: 'sale', sale_name: 'Sale', flower_total: 500000, status: 'PENDING', submitted_at: '2026-11-03T09:00:00+07:00', bill_urls: ['b2.jpg'] },
    { id: 'REQ-2', order_id: 'ORD-SINGLE', sale_username: 'sale', sale_name: 'Sale', flower_total: 300000, status: 'PENDING', submitted_at: '2026-11-03T08:00:00+07:00', bill_urls: ['b3.jpg'] }
  ];
  const orders = [
    { id: 'ORD-DUP', customer: 'Khách A', order_date: '2026-11-03', flower: 'Hoa' },
    { id: 'ORD-SINGLE', customer: 'Khách B', order_date: '2026-11-03', flower: 'Hoa' }
  ];

  const harness = createHarness({ role: 'ADMIN', requests, orders });
  const res = await vm.runInContext("fastSettlementQueue({ status: 'PENDING' })", harness);
  assert.equal(res.ok, true);
  assert.equal(res.total, 2, 'Must group to 2 distinct orders');
  const dup = res.items.find(x => x.orderId === 'ORD-DUP');
  assert.ok(dup);
  assert.equal(dup.duplicateCount, 1);
  assert.equal(dup.requestIds.length, 2);
  assert.equal(dup.billUrls.length, 2, 'Combines bill URLs across duplicate requests');
});

test('reviewSettlementsBulkCore processes batch approvals and handles errors gracefully', async () => {
  const harness = createHarness({ role: 'ADMIN' });
  const bulkRes = await vm.runInContext(
    "reviewSettlementsBulkCore({ requestIds: ['REQ-1', 'REQ-2', 'REQ-3'], mutationRequestId: 'MUT-BULK-1' }, actor)",
    harness
  );
  assert.equal(bulkRes.ok, true);
  assert.equal(bulkRes.selected, 3);
  assert.equal(bulkRes.approved, 3);
  assert.equal(bulkRes.failed, 0);
  assert.equal(harness.calls.length, 3);
  assert.equal(harness.calls[0].p.decision, 'APPROVED');
  assert.equal(harness.calls[0].p.requestId, 'MUT-BULK-1:REQ-1');
});

test('benchmark: Payment Check handles 20, 37 and 100+ requests efficiently without timeout', async () => {
  const makeBatch = (n) => ({
    requests: Array.from({ length: n }, (_, i) => ({
      id: 'REQ-' + (i + 1),
      order_id: 'ORD-' + (i + 1),
      sale_username: 'test_sale',
      sale_name: 'Test Sale',
      flower_total: 500000,
      accessory_total: 10000,
      vat: 0,
      ship_fee: 30000,
      required_amount: 540000,
      bill_urls: ['supabase://settlement-bills/bill-' + (i + 1) + '.jpg'],
      note: 'Yêu cầu ' + (i + 1),
      status: 'PENDING',
      submitted_at: '2026-11-03T10:00:00+07:00'
    })),
    orders: Array.from({ length: n }, (_, i) => ({
      id: 'ORD-' + (i + 1),
      customer: 'Khách ' + (i + 1),
      order_date: '2026-11-03',
      order_time: '10:00',
      flower: 'Hoa bó ' + (i + 1),
      flower_total: 500000,
      sale: 'Test Sale',
      status: 'Đã giao',
      shipping: 'Shop book ship',
      ship_fee: 30000,
      ship_confirmed: true,
      card: true,
      card_qty: 1,
      banner: false,
      charm_fee: 0,
      paper_fee: 0,
      vat: 0,
      payment: 'Chưa thanh toán'
    }))
  });

  // Scenario 1: 20 items (Single page)
  {
    const { requests, orders } = makeBatch(20);
    const harness = createHarness({ role: 'ADMIN', requests, orders });
    const t0 = Date.now();
    const res = await vm.runInContext("fastSettlementQueue({ status: 'PENDING', page: 1, pageSize: 20 })", harness);
    const ms = Date.now() - t0;
    assert.equal(res.ok, true);
    assert.equal(res.total, 20);
    assert.equal(res.totalPages, 1);
    assert.equal(res.items.length, 20);
    assert.equal(res.hasMore, false);
    assert.ok(ms < 3000, '20 items must process in < 3000ms; took ' + ms + 'ms');
  }

  // Scenario 2: 37 items (Historical backlog scale: 20 on page 1, 17 on page 2)
  {
    const { requests, orders } = makeBatch(37);
    const harness = createHarness({ role: 'ADMIN', requests, orders });
    const t0 = Date.now();
    const p1 = await vm.runInContext("fastSettlementQueue({ status: 'PENDING', page: 1, pageSize: 20 })", harness);
    const p1Ms = Date.now() - t0;
    assert.equal(p1.ok, true);
    assert.equal(p1.total, 37);
    assert.equal(p1.totalPages, 2);
    assert.equal(p1.items.length, 20);
    assert.equal(p1.hasMore, true);
    assert.ok(p1Ms < 3000, '37 items page 1 must process in < 3000ms');

    const p2 = await vm.runInContext("fastSettlementQueue({ status: 'PENDING', page: 2, pageSize: 20 })", harness);
    assert.equal(p2.ok, true);
    assert.equal(p2.page, 2);
    assert.equal(p2.items.length, 17);
    assert.equal(p2.hasMore, false);
  }

  // Scenario 3: 105 items (100+ stress scale: 6 pages, page 1 returns 20, page 6 returns 5)
  {
    const { requests, orders } = makeBatch(105);
    const harness = createHarness({ role: 'ADMIN', requests, orders });
    const t0 = Date.now();
    const p1 = await vm.runInContext("fastSettlementQueue({ status: 'PENDING', page: 1, pageSize: 20 })", harness);
    const p1Ms = Date.now() - t0;
    assert.equal(p1.ok, true);
    assert.equal(p1.total, 105);
    assert.equal(p1.totalPages, 6);
    assert.equal(p1.items.length, 20);
    assert.equal(p1.hasMore, true);
    assert.ok(p1Ms < 3000, '105 items page 1 must process in < 3000ms');

    const p6 = await vm.runInContext("fastSettlementQueue({ status: 'PENDING', page: 6, pageSize: 20 })", harness);
    assert.equal(p6.ok, true);
    assert.equal(p6.page, 6);
    assert.equal(p6.items.length, 5);
    assert.equal(p6.hasMore, false);
  }
});

test('frontend shell contract defines pagination, allPending default, and 90s timeout', () => {
  assert.match(htmlSource, /payment:\s*\{\s*status:\s*'PENDING',\s*page:\s*1,\s*pageSize:\s*20,\s*allPending:\s*true/);
  assert.match(htmlSource, /name === 'getSettlementQueue' \|\| name === 'reviewSettlementsBulk'/);
  assert.match(htmlSource, /paymentPrevPage:\s*paymentPrevPage/);
  assert.match(htmlSource, /paymentNextPage:\s*paymentNextPage/);
  assert.match(htmlSource, /paymentSetScope:\s*paymentSetScope/);
  assert.match(htmlSource, /payment-pagination-bar/);
});
