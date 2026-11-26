'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'supabase/functions/meehoasg-api-core/index.js');
const LEGACY_PATH = path.join(ROOT, 'supabase/functions/meehoasg-api/index.js');
const BACKFILL_SQL_PATH = path.join(ROOT, 'scripts/legacy-deleted-orders-backfill.sql');
const ROLLBACK_SQL_PATH = path.join(ROOT, 'scripts/legacy-deleted-orders-rollback.sql');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function setupDb() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);
  `);
  await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  const files = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', file), 'utf8'));
  }
  await pg.exec(`
    insert into public.app_users(username, display_name, role, password_hash, active) values
      ('admin', 'Admin Test', 'ADMIN', 'hash', true),
      ('sale1', 'Sale Một', 'SALE', 'hash', true),
      ('sale2', 'Sale Hai', 'SALE', 'hash', true),
      ('tho1', 'Thợ Một', 'THO_OPS', 'hash', true),
      ('cmui', 'C Mụi', 'SALE', 'hash', true);
  `);
  return pg;
}

async function mutate(pg, actor, requestId, action, input) {
  const fp = sha256(JSON.stringify({ actor, requestId, action, input }));
  const { rows } = await pg.query(
    'select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res',
    [actor, requestId, action, fp, JSON.stringify(input)]
  );
  return rows[0].res;
}

function makePgAdapter(pg) {
  const queryAll = async (table, query = {}) => {
    if (table === 'app_users') {
      return (await pg.query('select username,display_name,role,active from public.app_users')).rows;
    }
    if (table === 'orders') {
      const clauses = [];
      const params = [];
      if (query.is_deleted === 'is.false') clauses.push('is_deleted = false');
      if (query.is_deleted === 'is.true') clauses.push('is_deleted = true');
      if (query.delete_after_sheet_sync === 'is.false') clauses.push('delete_after_sheet_sync = false');
      if (query.id && query.id.startsWith('in.(')) {
        const ids = query.id.slice(4, -1).split(',').map((s) => s.replaceAll('"', '').trim()).filter(Boolean);
        params.push(ids);
        clauses.push(`id = ANY($${params.length})`);
      }
      if (query.and) {
        const mGte = query.and.match(/order_date\.gte\.([0-9-]+)/);
        const mLte = query.and.match(/order_date\.lte\.([0-9-]+)/);
        if (mGte) { params.push(mGte[1]); clauses.push(`order_date >= $${params.length}`); }
        if (mLte) { params.push(mLte[1]); clauses.push(`order_date <= $${params.length}`); }
      }
      const sql = 'select * from public.orders' + (clauses.length ? ' where ' + clauses.join(' and ') : '') + ' order by order_date asc, order_time asc, id asc';
      return (await pg.query(sql, params)).rows.map((r) => ({
        ...r,
        order_date: r.order_date instanceof Date ? r.order_date.toISOString().slice(0, 10) : String(r.order_date).slice(0, 10)
      }));
    }
    if (table === 'settlement_requests') {
      const clauses = [];
      const params = [];
      if (query.status && query.status.startsWith('eq.')) {
        params.push(query.status.slice(3));
        clauses.push(`status = $${params.length}`);
      }
      if (query.order_id && query.order_id.startsWith('in.(')) {
        const ids = query.order_id.slice(4, -1).split(',').map((s) => s.replaceAll('"', '').trim()).filter(Boolean);
        params.push(ids);
        clauses.push(`order_id = ANY($${params.length})`);
      }
      const sql = 'select * from public.settlement_requests' + (clauses.length ? ' where ' + clauses.join(' and ') : '') + ' order by submitted_at desc';
      return (await pg.query(sql, params)).rows;
    }
    if (table === 'order_deletion_history') {
      return (await pg.query('select * from public.order_deletion_history order by occurred_at desc')).rows;
    }
    if (table === 'kpi_operations') {
      return (await pg.query('select * from public.kpi_operations')).rows;
    }
    if (table === 'flower_cache') {
      return (await pg.query('select * from public.flower_cache')).rows;
    }
    return [];
  };
  const queryOne = async (table, query = {}) => {
    if (table === 'orders' && query.id && query.id.startsWith('eq.')) {
      const rows = (await pg.query('select * from public.orders where id = $1 limit 1', [query.id.slice(3)])).rows;
      return rows[0] || null;
    }
    return null;
  };
  const queryDb = async (target, _q, _m, body) => {
    if (target === 'rpc/mee_search_orders_page') {
      const { rows } = await pg.query(
        'select public.mee_search_orders_page($1,$2,$3,$4,$5,$6,$7) as res',
        [body.p_query || '', body.p_start || null, body.p_end || null, body.p_limit || 80, body.p_offset || 0, body.p_status || null, !!body.p_debt_only]
      );
      return rows[0].res;
    }
    if (target === 'rpc/mee_ops_lookup') {
      const { rows } = await pg.query(
        'select public.mee_ops_lookup($1,$2,$3,$4) as res',
        [body.p_actor, body.p_request_id, body.p_action, body.p_fingerprint]
      );
      return rows[0].res;
    }
    if (target === 'rpc/mee_ops_mutate') {
      const { rows } = await pg.query(
        'select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res',
        [body.p_actor, body.p_request_id, body.p_action, body.p_fingerprint, JSON.stringify(body.p_input)]
      );
      return rows[0].res;
    }
    return [];
  };
  return { queryAll, queryOne, queryDb };
}

function loadOperationsFactory() {
  const opsModSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/operations.js'), 'utf8')
    .replace(/export\s+function\s+/g, 'function ')
    .replace(/export\s+const\s+/g, 'const ');
  const modCtx = { URL, console };
  vm.createContext(modCtx);
  return vm.runInContext(`(() => {\n${opsModSrc}\nreturn { createOperationService, normalizeOperationOrder };\n})()`, modCtx);
}

function loadCoreHarness(pg, user) {
  const src = fs.readFileSync(CORE_PATH, 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/Deno\.serve\([\s\S]*$/, '');
  const { createOperationService } = loadOperationsFactory();
  const { queryAll, queryOne, queryDb } = makePgAdapter(pg);
  const ctx = {
    Deno: { env: { get: (k) => (k === 'SUPABASE_URL' ? 'http://local.test' : k === 'SUPABASE_SERVICE_ROLE_KEY' ? 'svc' : '') } },
    crypto: crypto.webcrypto,
    URL, TextEncoder, Intl, Date, console,
    fetch: async () => ({ ok: true, status: 200, text: async () => '[]', json: async () => ({}) }),
    createOperationStorage: () => ({ uploadImages: async () => [], discard: async () => {} }),
    createOperationService: (opts) => createOperationService({ ...opts, db: queryDb, one: queryOne }),
    createR2Media: () => null
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.requireUser = async (_payload, roles) => {
    if (roles && !roles.includes(user.role)) throw new Error('Không có quyền thực hiện.');
    return user;
  };
  ctx.displayUrls = async (u) => u || [];
  ctx.displayPreviewUrls = async (u) => u || [];
  ctx.signedImageUrl = async (u) => u;
  ctx.all = queryAll;
  ctx.one = queryOne;
  ctx.db = queryDb;
  return ctx;
}

function loadLegacyHarness(pg, user) {
  const src = fs.readFileSync(LEGACY_PATH, 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/Deno\.serve\([\s\S]*$/, '');
  const { createOperationService } = loadOperationsFactory();
  const { queryAll, queryOne, queryDb } = makePgAdapter(pg);
  const ctx = {
    Deno: { env: { get: (k) => (k === 'SUPABASE_URL' ? 'http://local.test' : k === 'SUPABASE_SERVICE_ROLE_KEY' ? 'svc' : '') } },
    crypto: crypto.webcrypto,
    URL, TextEncoder, Intl, Date, console,
    fetch: async () => ({ ok: true, status: 200, text: async () => '[]', json: async () => ({}) }),
    createOperationStorage: () => ({ uploadImages: async () => [], discard: async () => {} }),
    createOperationService: (opts) => createOperationService({ ...opts, db: queryDb, one: queryOne })
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.requireUser = async (_payload, roles) => {
    if (roles && !roles.includes(user.role)) throw new Error('Không có quyền thực hiện.');
    return user;
  };
  ctx.billDisplayUrls = async (u) => u || [];
  ctx.visibleOrder = async (row) => row;
  ctx.all = queryAll;
  ctx.one = queryOne;
  ctx.db = queryDb;
  return ctx;
}

const stdOrder = (over = {}) => ({
  customer: 'Khách Kiểm Thử', phone: '0909111222', order_date: '2026-11-26', order_time: '10:00',
  flower: 'Bó hồng đỏ Ecuador', note: 'Giao đúng giờ', tag_note_free: 'Happy Birthday',
  order_source: 'Zalo', shipping: 'Ghé lấy', address: '123 Lê Lợi',
  flower_total: 500000, payment: 'Chưa thanh toán', sale: 'sale1',
  card: false, card_qty: 0, card_text: '', banner: false, banner_qty: 0, banner_text: '',
  charm_fee: 0, charm_text: '', paper_fee: 0, paper_text: '', vat: 0,
  ship_fee: 0, ship_confirmed: false, image_urls: ['supabase://order-images/sample.jpg'],
  ...over
});

test('Final Order Deletion Policy Override: full 7-state x 3-role matrix, operational exclusion, Payment Check guard, restore parity & fallback API parity', async () => {
  const pg = await setupDb();
  try {
    const adminUser = { username: 'admin', display_name: 'Admin Test', role: 'ADMIN', active: true };
    const sale1User = { username: 'sale1', display_name: 'Sale Một', role: 'SALE', active: true };
    const sale2User = { username: 'sale2', display_name: 'Sale Hai', role: 'SALE', active: true };
    const tho1User = { username: 'tho1', display_name: 'Thợ Một', role: 'THO_OPS', active: true };
    const cmuiUser = { username: 'cmui', display_name: 'C Mụi', role: 'SALE', active: true };

    const adminCore = loadCoreHarness(pg, adminUser);
    const sale1Core = loadCoreHarness(pg, sale1User);
    const tho1Core = loadCoreHarness(pg, tho1User);
    const adminLegacy = loadLegacyHarness(pg, adminUser);
    const sale1Legacy = loadLegacyHarness(pg, sale1User);

    // Seed all 8 cases across the 7 required payment states (+ WALK_IN cash & transfer + THO_OPS own order)
    // 1. Unpaid (sale1, 400k)
    const oUnpaid = await mutate(pg, 'sale1', 'fd-c1', 'createOrder', {
      newOrderId: 'FD-UNPAID', order: stdOrder({ flower_total: 400000, payment: 'Chưa thanh toán', sale: 'sale1', order_source: 'Threads' })
    });
    // 2. Deposit (sale1, 600k, cọc 200k)
    const oDeposit = await mutate(pg, 'sale1', 'fd-c2', 'createOrder', {
      newOrderId: 'FD-DEPOSIT', order: stdOrder({ flower_total: 600000, payment: 'Đã cọc 200000 đ', sale: 'sale1', order_source: 'TikTok' })
    });
    // 3. Full flower paid (tho1 own order, 500k)
    const oFlowerPaid = await mutate(pg, 'admin', 'fd-c3', 'createOrder', {
      newOrderId: 'FD-FLOWER-PAID', order: stdOrder({ flower_total: 500000, payment: 'Đã thanh toán đủ tiền hoa', sale: 'tho1', order_source: 'Page/IG' })
    });
    // 4. Full Paid (sale1, 900k)
    const oFullPaid = await mutate(pg, 'sale1', 'fd-c4', 'createOrder', {
      newOrderId: 'FD-FULLPAID',
      order: stdOrder({ flower_total: 900000, sale: 'sale1', order_source: 'Zalo' }),
      fullPaidRequested: true,
      newBillUrls: ['supabase://settlement-bills/fp1.jpg']
    });
    // 5. Pending Payment Check (sale1, 700k)
    const oPending = await mutate(pg, 'sale1', 'fd-c5', 'createOrder', {
      newOrderId: 'FD-PENDING', order: stdOrder({ flower_total: 700000, payment: 'Chưa thanh toán', sale: 'sale1', order_source: 'Google Map' })
    });
    await pg.query("update public.orders set status = 'Đã giao' where id = 'FD-PENDING'");
    const pendFresh = (await pg.query("select updated_at from public.orders where id = 'FD-PENDING'")).rows[0];
    const subPend = await mutate(pg, 'sale1', 'fd-sub-pend', 'submitSettlement', {
      orderId: 'FD-PENDING', expectedUpdatedAt: pendFresh.updated_at, newSettlementId: 'SET-FD-PEND', newBillUrls: ['supabase://settlement-bills/p1.jpg']
    });
    assert.equal(subPend.ok, true);

    // 6. Settled (sale1, 800k)
    const oSettled = await mutate(pg, 'sale1', 'fd-c6', 'createOrder', {
      newOrderId: 'FD-SETTLED', order: stdOrder({ flower_total: 800000, payment: 'Đã thanh toán 800000 đ', sale: 'sale1', order_source: 'Zalo' })
    });
    await pg.query("update public.orders set status = 'Đã giao' where id = 'FD-SETTLED'");
    const setFresh = (await pg.query("select updated_at from public.orders where id = 'FD-SETTLED'")).rows[0];
    const subSet = await mutate(pg, 'sale1', 'fd-sub-set', 'submitSettlement', {
      orderId: 'FD-SETTLED', expectedUpdatedAt: setFresh.updated_at, newSettlementId: 'SET-FD-SET', newBillUrls: ['supabase://settlement-bills/s1.jpg']
    });
    assert.equal(subSet.ok, true);
    const appSet = await mutate(pg, 'admin', 'fd-app-set', 'reviewSettlement', { settlementId: 'SET-FD-SET', decision: 'APPROVED' });
    assert.equal(appSet.ok, true);

    // 7a. Walk-in CASH (cmui, 350k) & 7b. Walk-in TRANSFER (cmui, 450k)
    const oWiCash = await mutate(pg, 'sale1', 'fd-c7a', 'createOrder', {
      newOrderId: 'FD-WI-CASH', order: { order_type: 'WALK_IN', order_date: '2026-11-26', order_time: '11:00', flower_total: 350000, walk_in_payment_method: 'CASH' }
    });
    const oWiTr = await mutate(pg, 'sale1', 'fd-c7b', 'createOrder', {
      newOrderId: 'FD-WI-TR', order: { order_type: 'WALK_IN', order_date: '2026-11-26', order_time: '11:15', flower_total: 450000, walk_in_payment_method: 'TRANSFER' }
    });

    // Baseline metrics BEFORE any delete
    const dashBefore = await adminCore.fastDashboard({ start: '2026-11-26', end: '2026-11-26' });
    const kpiBefore = await adminCore.fastKpi({ month: '2026-11' });
    const debtBefore = await adminCore.fastDebt({ start: '2026-11-26', end: '2026-11-26' });
    const pqBefore = await adminCore.fastSettlementQueue({ status: 'PENDING', allPending: true });
    const fpBefore = await adminCore.fullPaidReport({ month: '2026-11' });
    const legacyPqBefore = await adminLegacy.settlementQueue({ status: 'PENDING', allPending: true }, adminUser);

    assert.equal(dashBefore.summary.orders, 8);
    assert.equal(dashBefore.summary.grossRevenue, 4700000); // 400+600+500+900+700+800+350+450
    assert.equal(dashBefore.summary.settledRevenue, 1700000); // FullPaid 900 + Settled 800
    assert.equal(dashBefore.summary.walkInOrders, 2);
    assert.equal(dashBefore.summary.walkInRevenue, 800000);
    assert.equal(dashBefore.summary.cms, 1700000 * 0.08);
    assert.equal(kpiBefore.items.find((x) => x.username === 'sale1').revenue, 1700000);
    assert.equal(debtBefore.deletedWithPaymentAudit, undefined);
    assert.equal(pqBefore.total, 1);
    assert.equal(pqBefore.items[0].orderId, 'FD-PENDING');
    assert.equal(legacyPqBefore.total, 1);
    assert.equal(fpBefore.summary.active, 1);

    // Check Core & Legacy decorate `canDelete` parity:
    // sale1 owns FD-FULLPAID & FD-SETTLED & FD-PENDING -> canDelete=true, canEdit=false on locked!
    const fpOrderCore = (await sale1Core.fastOrder({ orderId: 'FD-SETTLED' })).order;
    const fpOrderLegacy = (await sale1Legacy.getOrder({ orderId: 'FD-SETTLED' }, sale1User)).order;
    assert.equal(fpOrderCore.canDelete, true);
    assert.equal(fpOrderCore.canEdit, false);
    assert.equal(fpOrderCore.locked, true);
    assert.equal(fpOrderLegacy.canDelete, true);
    assert.equal(fpOrderLegacy.canEdit, false);
    assert.equal(fpOrderLegacy.locked, true);

    // Non-owner MUST be blocked for ALL 8 orders (sale2/tho1 on sale1's orders, sale1 on tho1 & cmui orders)
    const nonOwnerMatrix = [
      ['FD-UNPAID', 'sale2'], ['FD-DEPOSIT', 'tho1'], ['FD-FLOWER-PAID', 'sale1'],
      ['FD-FULLPAID', 'sale2'], ['FD-PENDING', 'tho1'], ['FD-SETTLED', 'sale2'],
      ['FD-WI-CASH', 'sale1'], ['FD-WI-TR', 'tho1']
    ];
    for (const [id, actor] of nonOwnerMatrix) {
      const fresh = (await pg.query('select updated_at from public.orders where id = $1', [id])).rows[0];
      const denied = await mutate(pg, actor, 'fd-deny-' + id + '-' + actor, 'deleteOrder', {
        orderId: id, expectedUpdatedAt: fresh.updated_at, reason: 'Thử xóa đơn người khác', reasonCode: 'CUSTOMER_CANCELLED'
      });
      assert.equal(denied.ok, false, actor + ' must be denied deleting ' + id);
      assert.equal(denied.code, 'NOT_OWNER');
    }

    // Financial locks on non-delete mutations (updateOrder / saveShipFee / updateStatus) MUST remain intact!
    for (const id of ['FD-PENDING', 'FD-SETTLED']) {
      const fresh = (await pg.query('select * from public.orders where id = $1', [id])).rows[0];
      const editDenied = await mutate(pg, 'admin', 'fd-lock-edit-' + id, 'updateOrder', {
        orderId: id, expectedUpdatedAt: fresh.updated_at, order: stdOrder({ note: 'Cố sửa' })
      });
      assert.equal(editDenied.code, 'ORDER_LOCKED', 'Edit lock must remain unchanged for ' + id);
    }

    // Now delete ALL 8 orders via their rightful owners / Admin (testing owner delete across EVERY payment state!)
    const deletePlan = [
      ['FD-UNPAID', 'sale1'],
      ['FD-DEPOSIT', 'sale1'],
      ['FD-FLOWER-PAID', 'tho1'],
      ['FD-FULLPAID', 'sale1'],
      ['FD-PENDING', 'sale1'],
      ['FD-SETTLED', 'sale1'],
      ['FD-WI-CASH', 'cmui'],
      ['FD-WI-TR', 'admin'] // Admin deletes another user's order (cmui's WALK_IN TRANSFER)
    ];
    for (const [id, actor] of deletePlan) {
      const fresh = (await pg.query('select updated_at from public.orders where id = $1', [id])).rows[0];
      // Verify empty reason rejected
      const noReason = await mutate(pg, actor, 'fd-noreason-' + id, 'deleteOrder', {
        orderId: id, expectedUpdatedAt: fresh.updated_at, reason: '', reasonCode: 'OTHER'
      });
      assert.equal(noReason.code, 'DELETE_REASON_REQUIRED');

      const del = await mutate(pg, actor, 'fd-del-' + id, 'deleteOrder', {
        orderId: id, expectedUpdatedAt: fresh.updated_at, reason: 'Xóa kiểm thử ' + id, reasonCode: 'CUSTOMER_CANCELLED'
      });
      assert.equal(del.ok, true, actor + ' must succeed deleting ' + id);
      assert.equal(del.row.is_deleted, true);
    }

    // Verify COMPLETE operational exclusion across EVERY Core API & Fallback API module!
    const searchAfter = (await pg.query("select public.mee_search_orders_page('', '2026-11-26', '2026-11-26', 80, 0, null, false) as res")).rows[0].res;
    assert.equal(searchAfter.total, 0);
    const prodAfter = await adminCore.fastProduction({ date: '2026-11-26' });
    assert.equal(prodAfter.orders.length, 0);
    const invAfter = await adminCore.flowerInventory({ start: '2026-11-26', end: '2026-11-26' });
    assert.equal(invAfter.totalOrders, 0);
    const dashAfter = await adminCore.fastDashboard({ start: '2026-11-26', end: '2026-11-26' });
    assert.equal(dashAfter.summary.orders, 0);
    assert.equal(dashAfter.summary.grossRevenue, 0);
    assert.equal(dashAfter.summary.settledRevenue, 0);
    assert.equal(dashAfter.summary.unsettledRevenue, 0);
    assert.equal(dashAfter.summary.walkInOrders, 0);
    assert.equal(dashAfter.summary.walkInRevenue, 0);
    assert.equal(dashAfter.summary.debt, 0);
    assert.equal(dashAfter.summary.cms, 0);
    assert.equal(dashAfter.salesDaily.length, 0);
    const debtAfter = await adminCore.fastDebt({ start: '2026-11-26', end: '2026-11-26' });
    assert.equal(debtAfter.items.length, 0);
    assert.equal(debtAfter.summary.debt, 0);
    assert.equal(debtAfter.deletedWithPaymentAudit, undefined);
    const pqAfter = await adminCore.fastSettlementQueue({ status: 'PENDING', allPending: true });
    assert.equal(pqAfter.total, 0);
    assert.equal(pqAfter.items.length, 0);
    const kpiAfter = await adminCore.fastKpi({ month: '2026-11' });
    assert.equal(kpiAfter.items.length, 0);
    const fpAfter = await adminCore.fullPaidReport({ month: '2026-11' });
    assert.equal(fpAfter.summary.active, 0);
    assert.equal(fpAfter.items.length, 0);

    // Fallback API parity checks
    const legacyDashAfter = await adminLegacy.dashboard({ start: '2026-11-26', end: '2026-11-26' }, adminUser);
    assert.equal(legacyDashAfter.summary.orders, 0);
    assert.equal(legacyDashAfter.summary.revenue, 0);
    const legacyDebtAfter = await adminLegacy.getDebt({ start: '2026-11-26', end: '2026-11-26' }, adminUser);
    assert.equal(legacyDebtAfter.items.length, 0);
    assert.equal(legacyDebtAfter.deletedWithPaymentAudit, undefined);
    const legacyPqAfter = await adminLegacy.settlementQueue({ status: 'PENDING', allPending: true }, adminUser);
    assert.equal(legacyPqAfter.total, 0);
    assert.equal(legacyPqAfter.items.length, 0);
    const legacyKpiAfter = await adminLegacy.getKpi({ month: '2026-11' }, adminUser);
    assert.equal(legacyKpiAfter.items.length, 0);

    // Payment Check MUST refuse reviewing (APPROVE or REJECT) a settlement request for a trashed order!
    for (const decision of ['APPROVED', 'REJECTED']) {
      const revBlocked = await mutate(pg, 'admin', 'fd-rev-blocked-' + decision, 'reviewSettlement', {
        settlementId: 'SET-FD-PEND', decision, reason: 'Thử duyệt đơn trong Thùng rác'
      });
      assert.equal(revBlocked.ok, false);
      assert.equal(revBlocked.code, 'ORDER_DELETED');
    }
    const bulkBlocked = await adminCore.reviewSettlementsBulkCore({ requestIds: ['SET-FD-PEND'], mutationRequestId: 'fd-bulk-1' }, adminUser);
    assert.equal(bulkBlocked.approved, 0);
    assert.equal(bulkBlocked.failed, 1);

    // Trash access: ADMIN sees all 8 orders with preserved data/images/bills/history; SALE & THO_OPS denied!
    await assert.rejects(() => sale1Core.getDeletedOrders({}), /Không có quyền/);
    await assert.rejects(() => tho1Core.getDeletedOrders({}), /Không có quyền/);
    const trash = await adminCore.getDeletedOrders({});
    assert.equal(trash.total, 8);
    const fpTrash = trash.items.find((x) => x.id === 'FD-FULLPAID');
    assert.equal(fpTrash.fullPaid, true);
    assert.equal(fpTrash.fullPaidTotal, 900000);
    assert.equal(fpTrash.fullPaidBillUrls.length, 1);
    assert.equal(fpTrash.driveUrls.length, 1);
    const setTrash = trash.items.find((x) => x.id === 'FD-SETTLED');
    assert.equal(setTrash.settled, true);

    // Non-Admin restore denied; ADMIN restores all 8 orders cleanly -> exact pre-delete totals restored with ZERO double counting!
    const saleRestoreDeny = await mutate(pg, 'sale1', 'fd-res-deny-s', 'restoreOrder', {
      orderId: 'FD-SETTLED', expectedUpdatedAt: setTrash.updatedAt, reason: 'Thử khôi phục'
    });
    assert.equal(saleRestoreDeny.code, 'NOT_OWNER');
    const thoRestoreDeny = await mutate(pg, 'tho1', 'fd-res-deny-t', 'restoreOrder', {
      orderId: 'FD-FLOWER-PAID', expectedUpdatedAt: trash.items.find((x) => x.id === 'FD-FLOWER-PAID').updatedAt, reason: 'Thử khôi phục'
    });
    assert.equal(thoRestoreDeny.code, 'NOT_OWNER');

    for (const [id] of deletePlan) {
      const fresh = (await pg.query('select updated_at from public.orders where id = $1', [id])).rows[0];
      const res = await mutate(pg, 'admin', 'fd-restore-' + id, 'restoreOrder', {
        orderId: id, expectedUpdatedAt: fresh.updated_at, reason: 'Khôi phục kiểm thử ' + id
      });
      assert.equal(res.ok, true);
      assert.equal(res.row.id, id);
      assert.equal(res.row.is_deleted, false);
      assert.equal(res.row.restored_by, 'admin');
    }

    // Verify exact pre-delete metrics restored with ZERO double counting and ZERO extra settlement requests!
    const dashRestored = await adminCore.fastDashboard({ start: '2026-11-26', end: '2026-11-26' });
    const kpiRestored = await adminCore.fastKpi({ month: '2026-11' });
    const pqRestored = await adminCore.fastSettlementQueue({ status: 'PENDING', allPending: true });
    const fpRestored = await adminCore.fullPaidReport({ month: '2026-11' });
    const totalSetReqs = (await pg.query('select count(*)::int as c from public.settlement_requests')).rows[0].c;

    assert.equal(dashRestored.summary.orders, dashBefore.summary.orders);
    assert.equal(dashRestored.summary.grossRevenue, dashBefore.summary.grossRevenue);
    assert.equal(dashRestored.summary.settledRevenue, dashBefore.summary.settledRevenue);
    assert.equal(dashRestored.summary.walkInRevenue, dashBefore.summary.walkInRevenue);
    assert.equal(dashRestored.summary.cms, dashBefore.summary.cms);
    assert.equal(kpiRestored.items.find((x) => x.username === 'sale1').revenue, 1700000);
    assert.equal(pqRestored.total, 1);
    assert.equal(pqRestored.items[0].orderId, 'FD-PENDING');
    assert.equal(fpRestored.summary.active, 1);
    assert.equal(totalSetReqs, 2, 'Restore must never auto-create duplicate settlement requests');

    // Verify original lock on restored FD-SETTLED is still intact!
    const restoredSet = (await pg.query("select updated_at from public.orders where id = 'FD-SETTLED'")).rows[0];
    const stillLocked = await mutate(pg, 'admin', 'fd-still-locked', 'updateOrder', {
      orderId: 'FD-SETTLED', expectedUpdatedAt: restoredSet.updated_at, order: stdOrder({ note: 'Sửa sau khôi phục' })
    });
    assert.equal(stillLocked.code, 'ORDER_LOCKED');

    // Verify deleteOrder via Fallback API (meehoasg-api/index.js) works identically!
    const freshUnpaid = (await pg.query("select updated_at from public.orders where id = 'FD-UNPAID'")).rows[0];
    const isoTs = freshUnpaid.updated_at instanceof Date ? freshUnpaid.updated_at.toISOString() : String(freshUnpaid.updated_at);
    const fallbackDel = await sale1Legacy.deleteOrder({
      orderId: 'FD-UNPAID', expectedUpdatedAt: isoTs, reason: 'Xóa qua fallback API', reasonCode: 'CUSTOMER_CANCELLED', requestId: 'fd-fb-del-1'
    }, sale1User);
    assert.equal(fallbackDel.ok, true, JSON.stringify(fallbackDel));
    const checkAfterFb = (await pg.query("select is_deleted from public.orders where id = 'FD-UNPAID'")).rows[0];
    assert.equal(checkAfterFb.is_deleted, true);
  } finally {
    await pg.close();
  }
});

test('Section V: 21-order Production-shape legacy conversion (2 unpaid, 17 deposit/flower-paid, 2 Full Paid = 10,371,000 VND) is idempotent, non-double-subtracting, and reversible', async () => {
  const pg = await setupDb();
  try {
    const adminUser = { username: 'admin', display_name: 'Admin Test', role: 'ADMIN', active: true };
    const adminCore = loadCoreHarness(pg, adminUser);

    // 1 active reference order (1,000,000 VND Full Paid)
    await pg.exec(`
      insert into public.orders(id, customer, order_date, order_time, flower, note, shipping, flower_total, payment, sale, status, settled, full_paid, full_paid_total, full_paid_bill_urls, image_urls, delete_after_sheet_sync, is_deleted)
      values ('ACTIVE-REF-1', 'Khách Active', '2026-11-26', '09:00', 'Bó hồng', '', 'Ghé lấy', 1000000, 'Đã thanh toán toàn bộ đơn', 'sale1', 'Đã giao', false, true, 1000000, '["supabase://settlement-bills/a.jpg"]'::jsonb, '["supabase://order-images/a.jpg"]'::jsonb, false, false);
    `);

    // Seed exact Production shape: 21 legacy deleted orders with full evidence totaling 10,371,000 VND:
    // - 2 unpaid (400,000 + 471,000 = 871,000)
    // - 17 deposit / flower-paid (17 * 500,000 = 8,500,000)
    // - 2 Full Paid (500,000 + 500,000 = 1,000,000)
    // Total = 871,000 + 8,500,000 + 1,000,000 = 10,371,000 VND
    // Plus 1 keyword-only row (no system evidence) that MUST remain untouched!
    const rows = [
      "('LEG-21-U1', '[ĐÃ XÓA] Khách U1', '2026-11-26', '09:10', 'Hoa U1', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 400000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, true, 'admin', '2026-11-26T01:00:00Z')",
      "('LEG-21-U2', '[ĐÃ XÓA] Khách U2', '2026-11-26', '09:20', 'Hoa U2', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 471000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, true, 'admin', '2026-11-26T01:05:00Z')",
      "('LEG-21-FP1', '[ĐÃ XÓA] Khách FP1', '2026-11-26', '09:30', 'Hoa FP1', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 500000, 'Đã thanh toán toàn bộ đơn', 'sale1', 'Đã giao', false, true, 500000, '[\"supabase://settlement-bills/fp1.jpg\"]'::jsonb, '[\"supabase://order-images/fp1.jpg\"]'::jsonb, true, 'admin', '2026-11-26T01:10:00Z')",
      "('LEG-21-FP2', '[ĐÃ XÓA] Khách FP2', '2026-11-26', '09:40', 'Hoa FP2', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 500000, 'Đã thanh toán toàn bộ đơn', 'sale2', 'Đã giao', false, true, 500000, '[\"supabase://settlement-bills/fp2.jpg\"]'::jsonb, '[\"supabase://order-images/fp2.jpg\"]'::jsonb, true, 'admin', '2026-11-26T01:15:00Z')",
      "('LEG-21-KW-ONLY', '[ĐÃ XÓA] Không có bằng chứng', '2026-11-26', '09:50', 'Hoa KW', 'Bình thường', 'Ghé lấy', 300000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, false, null, null)"
    ];
    for (let i = 1; i <= 17; i++) {
      rows.push(`('LEG-21-P${i}', '[ĐÃ XÓA] Khách P${i}', '2026-11-26', '10:${String(i).padStart(2, '0')}', 'Hoa P${i}', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 500000, 'Đã cọc 250000 đ', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, true, 'admin', '2026-11-26T02:00:00Z')`);
    }
    await pg.exec(`
      insert into public.orders(id, customer, order_date, order_time, flower, note, shipping, flower_total, payment, sale, status, settled, full_paid, full_paid_total, full_paid_bill_urls, image_urls, delete_after_sheet_sync, delete_requested_by, delete_requested_at)
      values ${rows.join(',\n')};
    `);

    // Check total value of the 21 confirmed legacy orders = 10,371,000
    const sum21 = (await pg.query("select count(*)::int as c, sum(flower_total)::numeric as s from public.orders where id like 'LEG-21-%' and id <> 'LEG-21-KW-ONLY'")).rows[0];
    assert.equal(sum21.c, 21);
    assert.equal(Number(sum21.s), 10371000);

    // Dashboard & KPI BEFORE backfill (note: delete_after_sheet_sync=true rows are ALREADY excluded!)
    const dashBefore = await adminCore.fastDashboard({ start: '2026-11-26', end: '2026-11-26' });
    const kpiBefore = await adminCore.fastKpi({ month: '2026-11' });
    assert.equal(dashBefore.summary.orders, 2); // ACTIVE-REF-1 + LEG-21-KW-ONLY
    assert.equal(dashBefore.summary.grossRevenue, 1300000);
    assert.equal(kpiBefore.items.find((x) => x.username === 'sale1').revenue, 1000000);

    // Run backfill migration (1st time)
    const backfillSql = fs.readFileSync(BACKFILL_SQL_PATH, 'utf8');
    await pg.exec(backfillSql);

    const moved = (await pg.query("select count(*)::int as c from public.orders where is_deleted = true")).rows[0].c;
    assert.equal(moved, 21, 'All 21 confirmed legacy deleted orders moved to Trash');
    const kwStillActive = (await pg.query("select is_deleted from public.orders where id = 'LEG-21-KW-ONLY'")).rows[0].is_deleted;
    assert.equal(kwStillActive, false, 'Keyword-only row without system evidence untouched');

    // Verify Dashboard & KPI AFTER backfill: ZERO double subtraction, ZERO reappearance!
    const dashAfter = await adminCore.fastDashboard({ start: '2026-11-26', end: '2026-11-26' });
    const kpiAfter = await adminCore.fastKpi({ month: '2026-11' });
    assert.equal(dashAfter.summary.orders, dashBefore.summary.orders);
    assert.equal(dashAfter.summary.grossRevenue, dashBefore.summary.grossRevenue);
    assert.equal(kpiAfter.items.find((x) => x.username === 'sale1').revenue, 1000000);

    // Verify Trash displays all 21 migrated orders with preserved Full Paid/deposit fields and backup snapshot
    const trash = await adminCore.getDeletedOrders({ pageSize: 50 });
    assert.equal(trash.total, 21);
    const fp1 = trash.items.find((x) => x.id === 'LEG-21-FP1');
    assert.equal(fp1.fullPaid, true);
    assert.equal(fp1.fullPaidTotal, 500000);
    assert.equal(fp1.customer, 'Khách FP1');

    // Run backfill migration a 2nd & 3rd time -> 100% idempotent!
    await pg.exec(backfillSql);
    await pg.exec(backfillSql);
    const histCount = (await pg.query("select count(*)::int as c from public.order_deletion_history where reason_code = 'LEGACY_MIGRATION'")).rows[0].c;
    const backupCount = (await pg.query('select count(*)::int as c from public.legacy_deleted_orders_backup')).rows[0].c;
    assert.equal(histCount, 21, 'Idempotent re-run creates zero duplicate history rows');
    assert.equal(backupCount, 21, 'Backup retains exact 21 original rows');

    // Verify compatible rollback restores all 21 orders cleanly!
    await pg.exec(fs.readFileSync(ROLLBACK_SQL_PATH, 'utf8'));
    const afterRbDeleted = (await pg.query("select count(*)::int as c from public.orders where is_deleted = true")).rows[0].c;
    const afterRbFlags = (await pg.query("select count(*)::int as c from public.orders where delete_after_sheet_sync = true")).rows[0].c;
    const afterRbHist = (await pg.query("select count(*)::int as c from public.order_deletion_history where reason_code = 'LEGACY_MIGRATION'")).rows[0].c;
    assert.equal(afterRbDeleted, 0);
    assert.equal(afterRbFlags, 21, 'Original delete_after_sheet_sync flags restored so old deleted orders still do NOT reappear');
    assert.equal(afterRbHist, 0);
  } finally {
    await pg.close();
  }
});
