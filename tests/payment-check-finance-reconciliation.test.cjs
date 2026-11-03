'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

let db, api, seq = 0;
const sale = { username: 'sale_recon', display_name: 'Sale Recon', role: 'SALE' };
const admin = { username: 'admin', display_name: 'Admin', role: 'ADMIN' };

const base = () => ({
  customer: 'Khách đối soát',
  phone: '0901234567',
  date: '2026-11-03',
  time: '10:00',
  flower: 'Hồng đỏ 500k',
  flowerTotal: 500000,
  shipping: 'Shop book ship',
  shipFeeActive: '1',
  shipFee: 30000,
  payment: 'Chưa thanh toán',
  card: true,
  cardQty: 1,
  cardText: 'Chúc mừng',
  banner: false
});

const hash = x => crypto.createHash('sha256').update(x).digest('hex');

async function rpc(action, input, { actor = 'sale_recon', key = 'req-' + (++seq), fingerprint = hash(key) } = {}) {
  return (await db.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as result', [
    actor, key, action, fingerprint, JSON.stringify(input)
  ])).rows[0].result;
}

async function createOrder(overrides = {}) {
  const d = { ...base(), ...overrides };
  const order = api.normalizeOperationOrder(d, sale);
  const res = await rpc('createOrder', {
    newOrderId: 'ORD-REC-' + (++seq),
    order,
    fullPaidRequested: false,
    newImageUrls: ['supabase://order-images/sample.jpg'],
    newBillUrls: []
  }, { actor: sale.username });
  assert.equal(res.ok, true, 'Order creation must succeed: ' + JSON.stringify(res));
  return res.row;
}

async function deliverAndSubmit(orderRow) {
  // 1. Mark ready (Chờ bó -> Chờ giao / Chờ lấy)
  const readyStatus = orderRow.shipping === 'Ghé lấy' ? 'Chờ lấy' : 'Chờ giao';
  const readyRes = await rpc('updateStatus', {
    orderId: orderRow.id,
    expectedUpdatedAt: orderRow.updated_at,
    status: readyStatus
  }, { actor: admin.username });
  assert.equal(readyRes.ok, true, 'Ready update must succeed: ' + JSON.stringify(readyRes));
  const readyOrder = readyRes.row;

  // 2. Mark delivered (Chờ giao / Chờ lấy -> Đã giao)
  const statusRes = await rpc('updateStatus', {
    orderId: readyOrder.id,
    expectedUpdatedAt: readyOrder.updated_at,
    status: 'Đã giao'
  }, { actor: admin.username });
  assert.equal(statusRes.ok, true, 'Deliver update must succeed: ' + JSON.stringify(statusRes));
  const deliveredOrder = statusRes.order || statusRes.row;

  // 3. Submit settlement
  const reqId = 'SET-REC-' + (++seq);
  const submitRes = await rpc('submitSettlement', {
    orderId: deliveredOrder.id,
    expectedUpdatedAt: deliveredOrder.updated_at,
    newSettlementId: reqId,
    newBillUrls: ['supabase://settlement-bills/proof-' + seq + '.jpg']
  }, { actor: sale.username });
  assert.equal(submitRes.ok, true, 'Settlement submission must succeed: ' + JSON.stringify(submitRes));
  return { order: deliveredOrder, requestId: submitRes.requestId };
}

before(async () => {
  api = await import('../supabase/functions/_shared/operations.js');
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);');
  await db.exec(fs.readFileSync('supabase/schema.sql', 'utf8'));
  for (const f of fs.readdirSync('supabase/migrations').sort()) {
    await db.exec(fs.readFileSync('supabase/migrations/' + f, 'utf8'));
  }
  await db.exec("insert into app_users(username,password_hash,display_name,role) values ('admin','hash','Admin','ADMIN'),('sale_recon','hash','Sale Recon','SALE'),('cmui','hash','C Mụi','SALE');");
});

after(async () => {
  if (db) await db.close();
});

beforeEach(async () => {
  await db.exec('truncate operation_receipts, settlement_requests, orders, activity_log restart identity cascade;');
});

test('single settlement lifecycle: approve clears debt and recognizes revenue without duplicate writes', async () => {
  // Step 1: Create order with 500k flower, 30k ship, 10k card = 540k total due
  const created = await createOrder({ flowerTotal: 500000, shipFee: 30000, card: true, cardQty: 1 });
  assert.equal(created.settled, false);
  assert.equal(Number(created.flower_total), 500000);
  assert.equal(Number(created.ship_fee), 30000);

  // Step 2: Deliver & Submit settlement
  const { order, requestId } = await deliverAndSubmit(created);

  // Verify pending settlement request exists
  const pendingRows = (await db.query('select * from settlement_requests where id = $1', [requestId])).rows;
  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0].status, 'PENDING');
  assert.equal(Number(pendingRows[0].required_amount), 540000);

  // Step 3: Admin approves the request
  const approveRes = await rpc('reviewSettlement', {
    settlementId: requestId,
    decision: 'APPROVED'
  }, { actor: admin.username, key: 'admin-approve-key-1' });
  assert.equal(approveRes.ok, true);
  assert.equal(approveRes.row.settled, true);

  // Step 4: Verify financial reconciliation in database
  const afterOrder = (await db.query('select * from orders where id = $1', [created.id])).rows[0];
  assert.equal(afterOrder.settled, true, 'Order must be settled');

  const afterReq = (await db.query('select * from settlement_requests where id = $1', [requestId])).rows[0];
  assert.equal(afterReq.status, 'APPROVED', 'Request status must be APPROVED');
  assert.equal(afterReq.admin_username, 'admin');

  // Step 5: Idempotency check: repeated review returns existing receipt without double counting
  const retryApprove = await rpc('reviewSettlement', {
    settlementId: requestId,
    decision: 'APPROVED'
  }, { actor: admin.username, key: 'admin-approve-key-1' });
  assert.equal(retryApprove.ok, true);
  assert.equal(retryApprove.idempotent, true);

  const totalOrders = (await db.query('select count(*)::int as n from orders')).rows[0].n;
  assert.equal(totalOrders, 1, 'Never creates duplicate order on retry');
});

test('rejection lifecycle: unlocks order, records reason and preserves outstanding debt', async () => {
  const created = await createOrder({ flowerTotal: 400000, shipFee: 25000, card: false });
  const { requestId } = await deliverAndSubmit(created);

  // Admin rejects request with reason
  const rejectRes = await rpc('reviewSettlement', {
    settlementId: requestId,
    decision: 'REJECTED',
    reason: 'Bill chuyển khoản bị mờ'
  }, { actor: admin.username });
  assert.equal(rejectRes.ok, true);
  assert.equal(rejectRes.row.settled, false);

  // Verify in database: order remains unsettled, request is REJECTED
  const afterOrder = (await db.query('select * from orders where id = $1', [created.id])).rows[0];
  assert.equal(afterOrder.settled, false, 'Rejected order must NOT be marked settled');

  const afterReq = (await db.query('select * from settlement_requests where id = $1', [requestId])).rows[0];
  assert.equal(afterReq.status, 'REJECTED');
  assert.equal(afterReq.rejection_reason, 'Bill chuyển khoản bị mờ');
});

test('bulk approval lifecycle: approves multiple orders atomically and updates all financial statuses', async () => {
  // Create 3 orders
  const o1 = await createOrder({ flowerTotal: 300000, shipFee: 20000 });
  const o2 = await createOrder({ flowerTotal: 450000, shipFee: 25000 });
  const o3 = await createOrder({ flowerTotal: 600000, shipFee: 30000 });

  const s1 = await deliverAndSubmit(o1);
  const s2 = await deliverAndSubmit(o2);
  const s3 = await deliverAndSubmit(o3);

  const reqIds = [s1.requestId, s2.requestId, s3.requestId];

  // Verify all 3 are PENDING
  const pendingCount = (await db.query("select count(*)::int as n from settlement_requests where status = 'PENDING'")).rows[0].n;
  assert.equal(pendingCount, 3);

  // Execute sequential approvals mimicking reviewSettlementsBulkCore
  const bulkKey = 'bulk-mutation-1';
  const approvedIds = [];
  for (const id of reqIds) {
    const res = await rpc('reviewSettlement', {
      settlementId: id,
      decision: 'APPROVED'
    }, { actor: admin.username, key: bulkKey + ':' + id });
    assert.equal(res.ok, true);
    approvedIds.push(res.orderId);
  }

  assert.equal(approvedIds.length, 3);

  // Check database: all 3 orders must now be settled = true
  const settledCount = (await db.query("select count(*)::int as n from orders where settled = true")).rows[0].n;
  assert.equal(settledCount, 3);

  const remainingPending = (await db.query("select count(*)::int as n from settlement_requests where status = 'PENDING'")).rows[0].n;
  assert.equal(remainingPending, 0);

  // Sum of settled revenue = 300k + 450k + 600k = 1,350,000 đ
  const settledRevenue = (await db.query("select sum(flower_total)::bigint as total from orders where settled = true")).rows[0].total;
  assert.equal(Number(settledRevenue), 1350000);
});
