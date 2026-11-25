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
const LEGACY_API_PATH = path.join(ROOT, 'supabase/functions/meehoasg-api/index.js');
const DRY_RUN_SQL_PATH = path.join(ROOT, 'scripts/legacy-deleted-orders-dry-run.sql');
const BACKFILL_SQL_PATH = path.join(ROOT, 'scripts/legacy-deleted-orders-backfill.sql');
const ROLLBACK_SQL_PATH = path.join(ROOT, 'scripts/legacy-deleted-orders-rollback.sql');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function getMigrationFiles(filterFn) {
  const dir = path.join(ROOT, 'supabase/migrations');
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return filterFn ? all.filter(filterFn) : all;
}

async function setupDb({ upToBaseline = false } = {}) {
  const pg = new PGlite();
  await pg.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);
  `);
  await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  const files = getMigrationFiles(upToBaseline ? (f) => !f.startsWith('20261125') : null);
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

function loadCoreHarness(pg, user) {
  const src = fs.readFileSync(CORE_PATH, 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/Deno\.serve\([\s\S]*$/, '');
  const ctx = {
    Deno: { env: { get: (k) => (k === 'SUPABASE_URL' ? 'http://local.test' : k === 'SUPABASE_SERVICE_ROLE_KEY' ? 'svc' : '') } },
    crypto: crypto.webcrypto,
    URL,
    TextEncoder,
    Intl,
    Date,
    console,
    fetch: async () => ({ ok: true, status: 200, text: async () => '[]', json: async () => ({}) }),
    createOperationStorage: () => ({ uploadImages: async () => [], discard: async () => {} }),
    createOperationService: () => ({ run: async () => ({ ok: true }) }),
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

  ctx.all = async (table, query = {}) => {
    if (table === 'app_users') {
      return (await pg.query('select username,display_name,role,active from public.app_users')).rows;
    }
    if (table === 'orders') {
      const clauses = [];
      const params = [];
      if (query.is_deleted === 'is.false') clauses.push('is_deleted = false');
      if (query.is_deleted === 'is.true') clauses.push('is_deleted = true');
      if (query.delete_after_sheet_sync === 'is.false') clauses.push('delete_after_sheet_sync = false');
      if (query.and) {
        const mGte = query.and.match(/order_date\.gte\.([0-9-]+)/);
        const mLte = query.and.match(/order_date\.lte\.([0-9-]+)/);
        if (mGte) { params.push(mGte[1]); clauses.push(`order_date >= $${params.length}`); }
        if (mLte) { params.push(mLte[1]); clauses.push(`order_date <= $${params.length}`); }
      }
      if (query.id && query.id.startsWith('in.(')) {
        const ids = query.id.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean);
        params.push(ids);
        clauses.push(`id = any($${params.length})`);
      }
      const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
      const rows = (await pg.query(`select * from public.orders ${where} order by order_date asc, order_time asc`, params)).rows;
      return rows.map((r) => ({
        ...r,
        order_date: r.order_date instanceof Date ? r.order_date.toISOString().slice(0, 10) : String(r.order_date || ''),
        updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
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
        const ids = query.order_id.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean);
        params.push(ids);
        clauses.push(`order_id = any($${params.length})`);
      }
      const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
      return (await pg.query(`select * from public.settlement_requests ${where} order by submitted_at desc`, params)).rows;
    }
    if (table === 'kpi_operations') {
      return (await pg.query('select * from public.kpi_operations')).rows;
    }
    if (table === 'order_deletion_history') {
      return (await pg.query('select * from public.order_deletion_history order by occurred_at desc')).rows;
    }
    return [];
  };

  ctx.one = async (table, query = {}) => {
    if (table === 'orders' && query.id && query.id.startsWith('eq.')) {
      return (await pg.query('select * from public.orders where id = $1', [query.id.slice(3)])).rows[0] || null;
    }
    return null;
  };

  return ctx;
}

test('POLICY-01 & POLICY-02: Walk-in Cash vs Transfer verification, bill-later Payment Check, Dashboard & C Mụi KPI without double counting', async () => {
  const pg = await setupDb();
  try {
    // 1. sale1 creates a Walk-in CASH order (550k >= 500k -> counts as bigOrder for C Mụi)
    const cashCreate = await mutate(pg, 'sale1', 'rc4-wi-cash-1', 'createOrder', {
      newOrderId: 'MEE-WI-CASH-1',
      order: {
        order_type: 'WALK_IN',
        walk_in_payment_method: 'CASH',
        order_date: '2026-11-25',
        order_time: '09:30',
        flower_total: 550000,
        flower: 'Bó hồng đỏ khách ghé mua trực tiếp'
      }
    });
    assert.equal(cashCreate.ok, true);
    assert.equal(cashCreate.row.sale, 'cmui');
    assert.equal(cashCreate.row.created_by, 'sale1');
    assert.equal(cashCreate.row.full_paid, false, 'Never fake full_paid on walk-in');
    assert.equal(cashCreate.row.settled, false, 'Never fake settled on walk-in');

    // 2. sale1 creates a Walk-in TRANSFER order WITHOUT bill (600k >= 500k)
    const trCreate = await mutate(pg, 'sale1', 'rc4-wi-tr-1', 'createOrder', {
      newOrderId: 'MEE-WI-TR-1',
      order: {
        order_type: 'WALK_IN',
        walk_in_payment_method: 'TRANSFER',
        order_date: '2026-11-25',
        order_time: '10:15',
        flower_total: 600000,
        flower: 'Bó tulip trắng khách chuyển khoản tại tiệm'
      }
    });
    assert.equal(trCreate.ok, true);
    assert.equal(trCreate.row.sale, 'cmui');
    assert.equal(trCreate.row.created_by, 'sale1');
    assert.equal(trCreate.row.full_paid, false, 'POLICY-01: never auto-verify transfer as full_paid');
    assert.equal(trCreate.row.settled, false, 'POLICY-01: never auto-verify transfer as settled');

    // 3. sale2 creates a settled STANDARD order (700k) to ensure other Sales' KPI is unaffected
    const stdCreate = await mutate(pg, 'sale2', 'rc4-std-1', 'createOrder', {
      newOrderId: 'MEE-STD-S2',
      requireOrderSource: true,
      order: {
        customer: 'Chị Hương', phone: '0909111222', order_date: '2026-11-25', order_time: '14:00',
        flower: 'Bó hướng dương', note: '', order_source: 'Threads', shipping: 'Ghé lấy', address: '',
        flower_total: 700000, payment: 'Chưa thanh toán', sale: 'sale2',
        card: false, card_qty: 0, card_text: '', banner: false, banner_qty: 0, banner_text: '',
        charm_fee: 0, charm_text: '', paper_fee: 0, paper_text: '', vat: 0, ship_fee: 0, ship_confirmed: false
      }
    });
    assert.equal(stdCreate.ok, true);
    await pg.query("update public.orders set settled = true, status = 'Đã giao' where id = 'MEE-STD-S2'");

    const adminCore = loadCoreHarness(pg, { username: 'admin', display_name: 'Admin Test', role: 'ADMIN', active: true });
    const cmuiCore = loadCoreHarness(pg, { username: 'cmui', display_name: 'C Mụi', role: 'SALE', active: true });
    const sale1Core = loadCoreHarness(pg, { username: 'sale1', display_name: 'Sale Một', role: 'SALE', active: true });
    const tho1Core = loadCoreHarness(pg, { username: 'tho1', display_name: 'Thợ Một', role: 'THO_OPS', active: true });

    // Check Debt Review (POLICY-01):
    // - Unverified Walk-in TRANSFER MUST appear in Debt Review for Admin & C Mụi with debt = 0 and canSubmitSettlement = true (for C Mụi)
    // - Walk-in CASH MUST NOT create fake debt or pollute Debt Review
    const adminDebt = await adminCore.fastDebt({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(adminDebt.items.length, 1, 'Only unverified Walk-in TRANSFER appears in Debt Review');
    assert.equal(adminDebt.items[0].id, 'MEE-WI-TR-1');
    assert.equal(adminDebt.items[0].debt, 0, 'POLICY-01: no fake debt on walk-in transfer');
    assert.equal(adminDebt.items[0].paymentVerified, false);
    assert.equal(adminDebt.items[0].walkInPaymentStatus, 'TRANSFER_UNVERIFIED');

    const cmuiDebt = await cmuiCore.fastDebt({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(cmuiDebt.items.length, 1);
    assert.equal(cmuiDebt.items[0].canSubmitSettlement, true, 'C Mụi can attach bill and submit transfer walk-in to Payment Check');

    const sale1OrderView = await sale1Core.fastOrder({ orderId: 'MEE-WI-TR-1' });
    assert.equal(sale1OrderView.order.canSubmitSettlement, false, 'Helper sale1 cannot submit settlement for C Mụi order');
    const cmuiCashView = await cmuiCore.fastOrder({ orderId: 'MEE-WI-CASH-1' });
    assert.equal(cmuiCashView.order.canSubmitSettlement, false, 'Walk-in CASH has no bank transfer bill to submit');
    assert.equal(cmuiCashView.order.kpiEligible, true);

    // Check Dashboard BEFORE transfer verification (daily & range):
    const dashBefore = await adminCore.fastDashboard({ start: '2026-11-01', end: '2026-11-30' });
    assert.equal(dashBefore.summary.orders, 3);
    assert.equal(dashBefore.summary.grossRevenue, 550000 + 600000 + 700000, 'Store revenue includes both walk-ins + standard ONCE');
    assert.equal(dashBefore.summary.revenue, 1850000);
    assert.equal(dashBefore.summary.settledRevenue, 700000, 'POLICY-02: unverified walk-in transfer NOT marked settledRevenue');
    assert.equal(dashBefore.summary.unsettledRevenue, 1150000);
    assert.equal(dashBefore.summary.debt, 0);

    // Check KPI BEFORE transfer verification (POLICY-02):
    // - C Mụi gets Walk-in CASH (550k, 1 order, 1 bigOrder), NOT unverified Walk-in TRANSFER
    // - sale1 (helper) gets 0 KPI
    // - sale2 gets 700k (unaffected)
    const kpiAdminBefore = await adminCore.fastKpi({ month: '2026-11' });
    const cmuiBefore = kpiAdminBefore.items.find((x) => x.username === 'cmui');
    const sale2Before = kpiAdminBefore.items.find((x) => x.username === 'sale2');
    const sale1Before = kpiAdminBefore.items.find((x) => x.username === 'sale1');
    assert.ok(cmuiBefore, 'C Mụi KPI present for Admin');
    assert.equal(cmuiBefore.revenue, 550000, 'C Mụi KPI includes Walk-in CASH immediately');
    assert.equal(cmuiBefore.orders, 1);
    assert.equal(cmuiBefore.bigOrders, 1);
    assert.equal(cmuiBefore.commission, 550000 * 0.08);
    assert.equal(sale1Before, undefined, 'POLICY-02: helper sale1 gets ZERO KPI for C Mụi walk-in');
    assert.equal(sale2Before.revenue, 700000, 'Other sale KPI unaffected');

    // KPI visibility permissions preserved:
    const kpiCmui = await cmuiCore.fastKpi({ month: '2026-11' });
    assert.ok(kpiCmui.items.some((x) => x.username === 'cmui'), 'C Mụi can view own KPI');
    const kpiSale1 = await sale1Core.fastKpi({ month: '2026-11' });
    assert.equal(kpiSale1.items.some((x) => x.username === 'cmui'), false, 'Other SALE cannot view C Mụi KPI');
    const kpiTho1 = await tho1Core.fastKpi({ month: '2026-11' });
    assert.equal(kpiTho1.items.some((x) => x.username === 'cmui'), false, 'THO_OPS cannot view C Mụi KPI');

    // 4. POLICY-01: Bill added later on Walk-in TRANSFER -> submitSettlement -> Admin REJECTS first
    const submit1 = await mutate(pg, 'cmui', 'rc4-set-1', 'submitSettlement', {
      orderId: 'MEE-WI-TR-1',
      expectedUpdatedAt: trCreate.row.updated_at,
      newSettlementId: 'SET-WI-1',
      newBillUrls: ['supabase://settlement-bills/walkin-bill-blur.jpg'],
      note: 'Bổ sung bill chuyển khoản khách vãng lai'
    });
    assert.equal(submit1.ok, true);
    assert.equal(submit1.settlementStatus, 'PENDING');

    const queuePending = await adminCore.fastSettlementQueue({ status: 'PENDING', allPending: true });
    assert.equal(queuePending.items.length, 1);
    assert.equal(queuePending.items[0].orderId, 'MEE-WI-TR-1');
    assert.equal(queuePending.items[0].order.walkInPaymentStatus, 'TRANSFER_PENDING_CHECK');

    const reject1 = await mutate(pg, 'admin', 'rc4-rev-rej', 'reviewSettlement', {
      settlementId: 'SET-WI-1',
      decision: 'REJECTED',
      reason: 'Ảnh bill mờ, cần tải lại'
    });
    assert.equal(reject1.ok, true);
    assert.equal(reject1.row.settled, false);

    // Still NOT counted in KPI after rejection
    const kpiAfterReject = await adminCore.fastKpi({ month: '2026-11' });
    assert.equal(kpiAfterReject.items.find((x) => x.username === 'cmui').revenue, 550000);

    // 5. C Mụi re-submits clear bill -> Admin APPROVES -> Transfer Walk-in verified!
    const submit2 = await mutate(pg, 'cmui', 'rc4-set-2', 'submitSettlement', {
      orderId: 'MEE-WI-TR-1',
      expectedUpdatedAt: reject1.row.updated_at,
      newSettlementId: 'SET-WI-2',
      newBillUrls: ['supabase://settlement-bills/walkin-bill-clear.jpg'],
      note: 'Bill rõ nét'
    });
    assert.equal(submit2.ok, true);

    const approve2 = await mutate(pg, 'admin', 'rc4-rev-app', 'reviewSettlement', {
      settlementId: 'SET-WI-2',
      decision: 'APPROVED'
    });
    assert.equal(approve2.ok, true);
    assert.equal(approve2.row.settled, true);

    // Debt Review is now empty (transfer verified!)
    const adminDebtAfter = await adminCore.fastDebt({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(adminDebtAfter.items.length, 0, 'Verified walk-in transfer leaves Debt Review');

    // Dashboard grossRevenue unchanged (ZERO double counting), settledRevenue increased by 600k
    const dashAfter = await adminCore.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(dashAfter.summary.grossRevenue, 1850000, 'NO double counting in Dashboard revenue');
    assert.equal(dashAfter.summary.settledRevenue, 700000 + 600000, 'Verified transfer enters settledRevenue');
    assert.equal(dashAfter.summary.unsettledRevenue, 550000);

    // KPI NOW includes BOTH Walk-in CASH (550k) AND verified Walk-in TRANSFER (600k) = 1,150,000 for C Mụi!
    const kpiAfterApprove = await adminCore.fastKpi({ month: '2026-11' });
    const cmuiAfter = kpiAfterApprove.items.find((x) => x.username === 'cmui');
    assert.equal(cmuiAfter.revenue, 1150000, 'C Mụi KPI includes Cash + verified Transfer ONCE');
    assert.equal(cmuiAfter.orders, 2);
    assert.equal(cmuiAfter.bigOrders, 2);
    assert.equal(cmuiAfter.commission, 1150000 * 0.08);
    assert.equal(kpiAfterApprove.items.find((x) => x.username === 'sale1'), undefined, 'Helper still gets ZERO KPI');

    // 6. POLICY-02 & POLICY-03: Soft-delete Walk-in CASH by Admin -> disappears from KPI & Dashboard, appears in Debt deletedWithPaymentAudit; Restore brings it back cleanly!
    // First confirm SALE (even C Mụi) cannot delete paid walk-in cash (POLICY-03: paid > 0 -> Admin only)
    const cmuiDelBlocked = await mutate(pg, 'cmui', 'rc4-cmui-del-block', 'deleteOrder', {
      orderId: 'MEE-WI-CASH-1',
      expectedUpdatedAt: cashCreate.row.updated_at,
      reason: 'Thử xóa đơn đã thu tiền',
      reasonCode: 'CUSTOMER_CANCEL'
    });
    assert.equal(cmuiDelBlocked.ok, false);
    assert.equal(cmuiDelBlocked.code, 'PAYMENT_RECONCILIATION_REQUIRED');

    // Settled Walk-in TRANSFER cannot be deleted even by ADMIN (POLICY-03: settled locked)
    const adminDelSettled = await mutate(pg, 'admin', 'rc4-admin-del-settled', 'deleteOrder', {
      orderId: 'MEE-WI-TR-1',
      expectedUpdatedAt: approve2.row.updated_at,
      reason: 'Thử xóa đơn đã tất toán',
      reasonCode: 'OTHER'
    });
    assert.equal(adminDelSettled.ok, false);
    assert.equal(adminDelSettled.code, 'ORDER_LOCKED');

    // Admin soft-deletes unlocked Walk-in CASH (with mandatory reason)
    const adminDelCash = await mutate(pg, 'admin', 'rc4-admin-del-cash', 'deleteOrder', {
      orderId: 'MEE-WI-CASH-1',
      expectedUpdatedAt: cashCreate.row.updated_at,
      reason: 'Nhập nhầm đơn khách vãng lai',
      reasonCode: 'DUPLICATE'
    });
    assert.equal(adminDelCash.ok, true);
    assert.equal(adminDelCash.hadPayment, true);

    const dashDeleted = await adminCore.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(dashDeleted.summary.grossRevenue, 1300000, 'Deleted walk-in removed from Dashboard revenue');
    const kpiDeleted = await adminCore.fastKpi({ month: '2026-11' });
    assert.equal(kpiDeleted.items.find((x) => x.username === 'cmui').revenue, 600000, 'Deleted walk-in removed from C Mụi KPI');
    const debtAudit = await adminCore.fastDebt({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(debtAudit.deletedWithPaymentAudit.count, 1, 'POLICY-03: Deleted paid walk-in appears in Debt reconciliation audit');
    assert.equal(debtAudit.deletedWithPaymentAudit.totalCollected, 550000);

    // Restore by SALE blocked; Restore by ADMIN succeeds and restores KPI + Dashboard
    const saleRestoreBlocked = await mutate(pg, 'cmui', 'rc4-cmui-restore-block', 'restoreOrder', {
      orderId: 'MEE-WI-CASH-1',
      expectedUpdatedAt: adminDelCash.row.updated_at,
      reason: 'Khôi phục'
    });
    assert.equal(saleRestoreBlocked.ok, false);
    assert.equal(saleRestoreBlocked.code, 'NOT_OWNER');

    const adminRestore = await mutate(pg, 'admin', 'rc4-admin-restore', 'restoreOrder', {
      orderId: 'MEE-WI-CASH-1',
      expectedUpdatedAt: adminDelCash.row.updated_at,
      reason: 'Khách xác nhận đơn hợp lệ'
    });
    assert.equal(adminRestore.ok, true);

    const kpiRestored = await adminCore.fastKpi({ month: '2026-11' });
    assert.equal(kpiRestored.items.find((x) => x.username === 'cmui').revenue, 1150000, 'Restored walk-in cleanly re-counted in C Mụi KPI');
    const dashRestored = await adminCore.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(dashRestored.summary.grossRevenue, 1850000, 'Restored walk-in cleanly re-counted in Dashboard');
  } finally {
    await pg.close();
  }
});

test('POLICY-04: Dry-run SQL is strictly READ ONLY, works on Production baseline & RC4 schema, and Backfill never converts keyword-only or paid rows', async () => {
  const dryRunSql = fs.readFileSync(DRY_RUN_SQL_PATH, 'utf8');
  // 1. Static read-only safety assertions (strip comments & quoted string literals before SQL command keyword check)
  assert.match(dryRunSql, /BEGIN\s+TRANSACTION\s+READ\s+ONLY;/i, 'Dry-run must open READ ONLY transaction');
  const strippedSql = dryRunSql.replace(/--.*$/gm, '').replace(/'(?:''|[^'])*'/g, "''");
  assert.doesNotMatch(strippedSql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i, 'Dry-run must contain zero write/DDL SQL');
  assert.doesNotMatch(strippedSql, /mee_ops_mutate/i, 'Dry-run must not invoke mutating RPC');

  // 2. Execute dry-run on Production BASELINE schema (pre-UI-V3, before is_deleted exists!)
  const pgBase = await setupDb({ upToBaseline: true });
  try {
    await pgBase.exec(`
      insert into public.orders(id, customer, order_date, order_time, flower, note, shipping, flower_total, payment, sale, status, settled, full_paid, full_paid_total, full_paid_bill_urls, image_urls, delete_after_sheet_sync, delete_requested_by, delete_requested_at) values
        ('LEG-KW-ONLY', '[ĐÃ XÓA] Khách tự ghi chú', '2026-10-01', '09:00', 'Bó hồng', 'Khách tự ghi', 'Ghé lấy', 400000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, false, null, null),
        ('LEG-UNPAID-OK', '[ĐÃ XÓA] Chị Lan', '2026-10-02', '10:00', 'Bó tulip', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 500000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, true, 'admin', '2026-10-02T04:00:00Z'),
        ('LEG-DEPOSIT', 'Anh Minh', '2026-10-03', '11:00', 'Giỏ hoa', 'Hủy đơn', 'Ghé lấy', 800000, 'Đã cọc 300k', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, false, 'admin', '2026-10-03T05:00:00Z'),
        ('LEG-FULLPAID', 'Chị Hoa', '2026-10-04', '12:00', 'Bó ly', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 1000000, 'Đã thanh toán toàn bộ đơn', 'sale2', 'Đã giao', false, true, 1000000, '["supabase://settlement-bills/leg.jpg"]'::jsonb, '["supabase://order-images/leg.jpg"]'::jsonb, false, null, null),
        ('LEG-LOG-SETTLED', 'Anh Đức', '2026-10-05', '13:00', 'Bó mẫu đơn', 'Bình thường', 'Ghé lấy', 900000, 'Đã thanh toán', 'sale2', 'Đã giao', true, false, 0, '[]'::jsonb, '[]'::jsonb, false, null, null);
      insert into public.activity_log(username, display_name, role, order_id, action, after_data)
        values ('admin', 'Admin Test', 'ADMIN', 'LEG-LOG-SETTLED', 'legacyDeleteOrder', '{"delete_after_sheet_sync": true}'::jsonb);
    `);
    const results = await pgBase.exec(dryRunSql);
    // results: [BEGIN, QUERY 1 (summary), QUERY 2 (detail), COMMIT]
    const summaryRes = results.find((r) => r.rows && r.rows[0] && 'total_suspected_legacy_deleted' in r.rows[0]);
    const detailRes = results.find((r) => r.rows && r.rows[0] && 'classification' in r.rows[0]);
    assert.ok(summaryRes, 'Summary query returned on Production baseline');
    assert.ok(detailRes, 'Detail query returned on Production baseline');
    const s = summaryRes.rows[0];
    assert.equal(Number(s.total_suspected_legacy_deleted), 5);
    assert.equal(Number(s.confirmed_with_evidence), 4, '4 rows have system evidence');
    assert.equal(Number(s.insufficient_evidence_keyword_only), 1, '1 row is keyword-only');
    assert.equal(Number(s.unpaid_orders), 2, 'LEG-KW-ONLY + LEG-UNPAID-OK');
    assert.equal(Number(s.deposit_or_partial_paid_orders), 1, 'LEG-DEPOSIT');
    assert.equal(Number(s.full_paid_or_settled_orders), 2, 'LEG-FULLPAID + LEG-LOG-SETTLED');
    assert.equal(Number(s.clean_verified_candidates), 1, 'Only LEG-UNPAID-OK is confirmed & unpaid');
    assert.equal(Number(s.owner_manual_review_required), 4, '4 cases require Owner review');
    assert.equal(Number(s.total_order_value_vnd), 3600000);
    assert.equal(Number(s.total_collected_vnd), 2200000, '300k + 1M + 900k');
    assert.equal(Number(s.total_related_debt_vnd), 1400000, '400k + 500k + 500k remaining on deposit');

    const byId = Object.fromEntries(detailRes.rows.map((r) => [r.id, r]));
    assert.equal(byId['LEG-KW-ONLY'].classification, 'INSUFFICIENT_EVIDENCE_KEYWORD_ONLY');
    assert.equal(byId['LEG-UNPAID-OK'].classification, 'CONFIRMED_UNPAID_CANDIDATE');
    assert.equal(byId['LEG-DEPOSIT'].classification, 'CONFIRMED_PAID_OR_DEPOSIT_REVIEW');
    assert.equal(byId['LEG-FULLPAID'].classification, 'CONFIRMED_LOCKED_FINANCIAL_REVIEW');
    assert.equal(byId['LEG-LOG-SETTLED'].classification, 'CONFIRMED_LOCKED_FINANCIAL_REVIEW');

    // 3. Upgrade DB to RC4 migrations, verify idempotency (run RC4 migrations twice!), then verify hardened backfill
    const v3Files = getMigrationFiles((f) => f.startsWith('20261125'));
    for (const pass of [1, 2]) {
      for (const f of v3Files) {
        await pgBase.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8'));
      }
      assert.ok(pass <= 2);
    }

    // Run hardened backfill SQL on isolated test DB
    await pgBase.exec(fs.readFileSync(BACKFILL_SQL_PATH, 'utf8'));
    const afterBackfill = (await pgBase.query('select id, is_deleted, customer from public.orders order by id')).rows;
    const mapAfter = Object.fromEntries(afterBackfill.map((r) => [r.id, r]));
    assert.equal(mapAfter['LEG-UNPAID-OK'].is_deleted, true, 'Verified unpaid legacy deleted order converted');
    assert.equal(mapAfter['LEG-KW-ONLY'].is_deleted, false, 'POLICY-04: keyword-only [ĐÃ XÓA] MUST NOT auto-convert');
    assert.equal(mapAfter['LEG-DEPOSIT'].is_deleted, false, 'POLICY-04: deposit order MUST NOT auto-convert');
    assert.equal(mapAfter['LEG-FULLPAID'].is_deleted, false, 'POLICY-04: full_paid order MUST NOT auto-convert');
    assert.equal(mapAfter['LEG-LOG-SETTLED'].is_deleted, false, 'POLICY-04: settled order MUST NOT auto-convert');

    // Re-running backfill is idempotent; rollback SQL restores cleanly
    await pgBase.exec(fs.readFileSync(BACKFILL_SQL_PATH, 'utf8'));
    await pgBase.exec(fs.readFileSync(ROLLBACK_SQL_PATH, 'utf8'));
    const afterRollback = (await pgBase.query("select is_deleted, customer from public.orders where id = 'LEG-UNPAID-OK'")).rows[0];
    assert.equal(afterRollback.is_deleted, false);
    assert.equal(afterRollback.customer, '[ĐÃ XÓA] Chị Lan');
  } finally {
    await pgBase.close();
  }
});

test('Section V: Migration from Production baseline preserves legacy/Bot orders, legacy V2 client edits preserve RC4 fields, and fallback API never resurrects soft-deleted orders', async () => {
  const pg = await setupDb({ upToBaseline: true });
  try {
    // Seed a legacy order & an Order Bot order on Production baseline (no order_source, no tag_note_free, no order_type)
    await pg.exec(`
      insert into public.orders(id, customer, phone, order_date, order_time, flower, note, shipping, address, flower_total, payment, sale, status, source_sheet)
      values
        ('PRE-V3-LEGACY', 'Khách Cũ', '0901112222', '2026-11-20', '10:00', 'Bó hồng', 'Ghi chú cũ', 'Ghé lấy', '', 450000, 'Chưa thanh toán', 'sale1', 'Chờ bó', 'LEGACY'),
        ('PRE-V3-BOT', 'Khách Bot', '0903334444', '2026-11-21', '11:00', 'Bó cẩm tú cầu', 'Tạo từ Bot', 'Ghé lấy', '', 520000, 'Chưa thanh toán', 'sale1', 'Chờ bó', 'ORDER_BOT');
    `);

    // Apply all RC4 migrations
    for (const f of getMigrationFiles((x) => x.startsWith('20261125'))) {
      await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8'));
    }

    const legacy = (await pg.query("select * from public.orders where id = 'PRE-V3-LEGACY'")).rows[0];
    assert.equal(legacy.order_source, '', 'Legacy order keeps empty source (never fabricated)');
    assert.equal(legacy.order_type, 'STANDARD');
    assert.equal(legacy.is_deleted, false);

    // Create a new RC4 order with tag_note_free + order_source
    const rc4Order = await mutate(pg, 'sale1', 'rc4-compat-1', 'createOrder', {
      newOrderId: 'MEE-RC4-COMPAT',
      requireOrderSource: true,
      order: {
        customer: 'Chị Mai', phone: '0908889999', order_date: '2026-11-25', order_time: '15:00',
        flower: 'Bó hồng ohara', note: 'Giao đúng giờ', tag_note_free: 'Chúc mừng sinh nhật',
        order_source: 'Page/IG', shipping: 'Ghé lấy', address: '', flower_total: 650000,
        payment: 'Chưa thanh toán', sale: 'sale1',
        card: false, card_qty: 0, card_text: '', banner: false, banner_qty: 0, banner_text: '',
        charm_fee: 0, charm_text: '', paper_fee: 0, paper_text: '', vat: 0, ship_fee: 0, ship_confirmed: false
      }
    });
    assert.equal(rc4Order.ok, true);

    // Simulate legacy V2 client updating MEE-RC4-COMPAT WITHOUT sending tag_note_free or order_source
    const v2Edit = await mutate(pg, 'sale1', 'rc4-compat-v2-edit', 'updateOrder', {
      orderId: 'MEE-RC4-COMPAT',
      expectedUpdatedAt: rc4Order.row.updated_at,
      order: {
        customer: 'Chị Mai (đã sửa)', phone: '0908889999', order_date: '2026-11-25', order_time: '15:30',
        flower: 'Bó hồng ohara', note: 'Giao đúng giờ', shipping: 'Ghé lấy', address: '', flower_total: 650000,
        payment: 'Chưa thanh toán', sale: 'sale1',
        card: false, card_qty: 0, card_text: '', banner: false, banner_qty: 0, banner_text: '',
        charm_fee: 0, charm_text: '', paper_fee: 0, paper_text: '', vat: 0, ship_fee: 0, ship_confirmed: false
      }
    });
    assert.equal(v2Edit.ok, true);
    assert.equal(v2Edit.row.tag_note_free, 'Chúc mừng sinh nhật', 'Legacy V2 edit preserves tag_note_free');
    assert.equal(v2Edit.row.order_source, 'Page/IG', 'Legacy V2 edit preserves order_source');

    // Verify defensive fallback meehoasg-api/index.js filters is_deleted and excludes WALK_IN from Production/Flowers
    const legacySrc = fs.readFileSync(LEGACY_API_PATH, 'utf8');
    assert.match(legacySrc, /is_deleted:\s*'is\.false'/);
    assert.match(legacySrc, /delete_after_sheet_sync:\s*'is\.false'/);
    assert.match(legacySrc, /ORDER_DELETED/);
    assert.match(legacySrc, /!==\s*'WALK_IN'/);
  } finally {
    await pg.close();
  }
});
