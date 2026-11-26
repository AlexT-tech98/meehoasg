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
  const files = getMigrationFiles(upToBaseline ? (f) => f < '20261125' : null);
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

test('POLICY-01 & POLICY-02 Override: Walk-in recorded immediately in Dashboard store revenue (distinguishing unverified transfer) and excluded from ALL personal KPI & commission regardless of payment method/status', async () => {
  const pg = await setupDb();
  try {
    // 1. sale1 creates a Walk-in CASH order (550k) -> assigned to cmui, created_by=sale1
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

    // 2. sale1 creates a Walk-in TRANSFER order WITHOUT bill (600k)
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

    // 3. sale2 creates a settled STANDARD order (700k) and cmui creates a settled STANDARD order (800k) -> standard KPI untouched
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

    const stdCmui = await mutate(pg, 'cmui', 'rc4-std-cmui', 'createOrder', {
      newOrderId: 'MEE-STD-CMUI',
      requireOrderSource: true,
      order: {
        customer: 'Anh Hải', phone: '0909333444', order_date: '2026-11-25', order_time: '15:00',
        flower: 'Giỏ hoa lan', note: '', order_source: 'Zalo', shipping: 'Ghé lấy', address: '',
        flower_total: 800000, payment: 'Đã thanh toán', sale: 'cmui',
        card: false, card_qty: 0, card_text: '', banner: false, banner_qty: 0, banner_text: '',
        charm_fee: 0, charm_text: '', paper_fee: 0, paper_text: '', vat: 0, ship_fee: 0, ship_confirmed: false
      }
    });
    assert.equal(stdCmui.ok, true);
    await pg.query("update public.orders set settled = true, status = 'Đã giao' where id = 'MEE-STD-CMUI'");

    const adminCore = loadCoreHarness(pg, { username: 'admin', display_name: 'Admin Test', role: 'ADMIN', active: true });
    const cmuiCore = loadCoreHarness(pg, { username: 'cmui', display_name: 'C Mụi', role: 'SALE', active: true });
    const sale1Core = loadCoreHarness(pg, { username: 'sale1', display_name: 'Sale Một', role: 'SALE', active: true });
    const tho1Core = loadCoreHarness(pg, { username: 'tho1', display_name: 'Thợ Một', role: 'THO_OPS', active: true });

    // Check Debt Review (POLICY-01): unverified Walk-in TRANSFER appears with debt=0; Walk-in CASH excluded
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
    assert.equal(cmuiCashView.order.kpiEligible, false, 'POLICY-02 Override: Walk-in CASH is NOT KPI-eligible');

    // Check Dashboard BEFORE transfer verification (records walk-in immediately by sale date & separates unverified transfer):
    const dashBefore = await adminCore.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(dashBefore.summary.orders, 4);
    assert.equal(dashBefore.summary.grossRevenue, 550000 + 600000 + 700000 + 800000, 'Store revenue records both walk-ins + standards immediately ONCE');
    assert.equal(dashBefore.summary.revenue, 2650000);
    assert.equal(dashBefore.summary.walkInOrders, 2);
    assert.equal(dashBefore.summary.walkInRevenue, 1150000);
    assert.equal(dashBefore.summary.walkInCashRevenue, 550000);
    assert.equal(dashBefore.summary.walkInTransferUnverifiedRevenue, 600000, 'Clearly distinguishes unverified walk-in transfer');
    assert.equal(dashBefore.summary.walkInTransferVerifiedRevenue, 0);
    assert.equal(dashBefore.summary.settledRevenue, 1500000, 'Unverified walk-in transfer NOT marked settledRevenue');
    assert.equal(dashBefore.summary.unsettledRevenue, 1150000);
    assert.equal(dashBefore.summary.cms, 1500000 * 0.08, 'Dashboard CMS only applies to standard verified orders');
    assert.equal(dashBefore.summary.debt, 0);

    // Check KPI BEFORE transfer verification (POLICY-02 Override):
    // - C Mụi ONLY gets own STANDARD settled order (800k), ZERO walk-in KPI!
    // - sale1 (helper) gets ZERO KPI
    // - sale2 gets 700k (unaffected)
    const kpiAdminBefore = await adminCore.fastKpi({ month: '2026-11' });
    const cmuiBefore = kpiAdminBefore.items.find((x) => x.username === 'cmui');
    const sale2Before = kpiAdminBefore.items.find((x) => x.username === 'sale2');
    const sale1Before = kpiAdminBefore.items.find((x) => x.username === 'sale1');
    assert.equal(cmuiBefore.revenue, 800000, 'C Mụi KPI ONLY counts standard settled order, excludes Walk-in CASH & TRANSFER');
    assert.equal(cmuiBefore.orders, 1);
    assert.equal(cmuiBefore.commission, 800000 * 0.08);
    assert.equal(sale1Before, undefined, 'Helper sale1 gets ZERO KPI');
    assert.equal(sale2Before.revenue, 700000, 'Other sale KPI unaffected');

    // KPI visibility permissions preserved:
    const kpiCmui = await cmuiCore.fastKpi({ month: '2026-11' });
    assert.ok(kpiCmui.items.some((x) => x.username === 'cmui'), 'C Mụi can view own KPI');
    const kpiSale1 = await sale1Core.fastKpi({ month: '2026-11' });
    assert.equal(kpiSale1.items.some((x) => x.username === 'cmui'), false, 'Other SALE cannot view C Mụi KPI');
    const kpiTho1 = await tho1Core.fastKpi({ month: '2026-11' });
    assert.equal(kpiTho1.items.some((x) => x.username === 'cmui'), false, 'THO_OPS cannot view C Mụi KPI');

    // 4. POLICY-01: Bill added later on Walk-in TRANSFER -> submitSettlement -> Admin REJECTS -> C Mụi re-submits -> Admin APPROVES
    const submit1 = await mutate(pg, 'cmui', 'rc4-set-1', 'submitSettlement', {
      orderId: 'MEE-WI-TR-1',
      expectedUpdatedAt: trCreate.row.updated_at,
      newSettlementId: 'SET-WI-1',
      newBillUrls: ['supabase://settlement-bills/walkin-bill-blur.jpg'],
      note: 'Bổ sung bill chuyển khoản khách vãng lai'
    });
    assert.equal(submit1.ok, true);

    const reject1 = await mutate(pg, 'admin', 'rc4-rev-rej', 'reviewSettlement', {
      settlementId: 'SET-WI-1',
      decision: 'REJECTED',
      reason: 'Ảnh bill mờ, cần tải lại'
    });
    assert.equal(reject1.ok, true);
    assert.equal(reject1.row.settled, false);

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

    // Dashboard: grossRevenue & walkInRevenue UNCHANGED (ZERO double counting!), transfer moves from unverified to verified, CMS UNCHANGED!
    const dashAfter = await adminCore.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(dashAfter.summary.grossRevenue, 2650000, 'ZERO double counting in Dashboard grossRevenue after verification');
    assert.equal(dashAfter.summary.walkInRevenue, 1150000, 'ZERO double counting in walkInRevenue');
    assert.equal(dashAfter.summary.walkInTransferUnverifiedRevenue, 0);
    assert.equal(dashAfter.summary.walkInTransferVerifiedRevenue, 600000);
    assert.equal(dashAfter.summary.settledRevenue, 1500000 + 600000);
    assert.equal(dashAfter.summary.cms, 1500000 * 0.08, 'POLICY-02 Override: Verified WALK_IN generates ZERO Dashboard CMS');

    // POLICY-02 Override: EVEN AFTER settled=true, Walk-in TRANSFER is STILL EXCLUDED from personal KPI & commission!
    const kpiAfterApprove = await adminCore.fastKpi({ month: '2026-11' });
    const cmuiAfter = kpiAfterApprove.items.find((x) => x.username === 'cmui');
    assert.equal(cmuiAfter.revenue, 800000, 'POLICY-02 Override: Even settled WALK_IN excluded from C Mụi personal KPI');
    assert.equal(cmuiAfter.orders, 1);
    assert.equal(cmuiAfter.commission, 800000 * 0.08);
    assert.equal(kpiAfterApprove.items.find((x) => x.username === 'sale1'), undefined);

    // 5. Final Deletion Policy Override + No double counting on Soft-delete & Restore of Walk-in CASH & settled TRANSFER
    // Non-owner (sale1) still CANNOT delete cmui's walk-in order
    const sale1DelBlocked = await mutate(pg, 'sale1', 'rc4-sale1-del-block', 'deleteOrder', {
      orderId: 'MEE-WI-CASH-1',
      expectedUpdatedAt: cashCreate.row.updated_at,
      reason: 'Thử xóa đơn không phải của mình',
      reasonCode: 'CUSTOMER_CANCELLED'
    });
    assert.equal(sale1DelBlocked.ok, false);
    assert.equal(sale1DelBlocked.code, 'NOT_OWNER');

    // Owner (cmui) CAN soft-delete own Walk-in CASH order AND own settled Walk-in TRANSFER order
    const cmuiDelCash = await mutate(pg, 'cmui', 'rc4-cmui-del-cash', 'deleteOrder', {
      orderId: 'MEE-WI-CASH-1',
      expectedUpdatedAt: cashCreate.row.updated_at,
      reason: 'Nhập nhầm đơn khách vãng lai',
      reasonCode: 'DUPLICATE_ORDER'
    });
    assert.equal(cmuiDelCash.ok, true);
    assert.equal(cmuiDelCash.hadPayment, true);

    const adminDelSettled = await mutate(pg, 'admin', 'rc4-admin-del-settled', 'deleteOrder', {
      orderId: 'MEE-WI-TR-1',
      expectedUpdatedAt: approve2.row.updated_at,
      reason: 'Xóa đơn vãng lai đã tất toán',
      reasonCode: 'OTHER'
    });
    assert.equal(adminDelSettled.ok, true);

    const dashDeleted = await adminCore.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(dashDeleted.summary.grossRevenue, 1500000, 'Both deleted walk-ins completely removed from Dashboard revenue');
    assert.equal(dashDeleted.summary.walkInRevenue, 0);
    assert.equal(dashDeleted.summary.walkInOrders, 0);
    const kpiDeleted = await adminCore.fastKpi({ month: '2026-11' });
    assert.equal(kpiDeleted.items.find((x) => x.username === 'cmui').revenue, 800000, 'C Mụi standard KPI completely unaffected by walk-in delete');
    const debtAudit = await adminCore.fastDebt({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(debtAudit.deletedWithPaymentAudit, undefined, 'Final Deletion Policy: deletedWithPaymentAudit removed from Debt');

    const saleRestoreBlocked = await mutate(pg, 'cmui', 'rc4-cmui-restore-block', 'restoreOrder', {
      orderId: 'MEE-WI-CASH-1',
      expectedUpdatedAt: cmuiDelCash.row.updated_at,
      reason: 'Khôi phục'
    });
    assert.equal(saleRestoreBlocked.ok, false);
    assert.equal(saleRestoreBlocked.code, 'NOT_OWNER');

    const adminRestoreCash = await mutate(pg, 'admin', 'rc4-admin-restore-cash', 'restoreOrder', {
      orderId: 'MEE-WI-CASH-1',
      expectedUpdatedAt: cmuiDelCash.row.updated_at,
      reason: 'Khách xác nhận đơn hợp lệ'
    });
    assert.equal(adminRestoreCash.ok, true);
    const adminRestoreTr = await mutate(pg, 'admin', 'rc4-admin-restore-tr', 'restoreOrder', {
      orderId: 'MEE-WI-TR-1',
      expectedUpdatedAt: adminDelSettled.row.updated_at,
      reason: 'Khôi phục đơn chuyển khoản đã tất toán'
    });
    assert.equal(adminRestoreTr.ok, true);
    assert.equal(adminRestoreTr.row.settled, true, 'Settled flag preserved intact upon restore');

    const dashRestored = await adminCore.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
    assert.equal(dashRestored.summary.grossRevenue, 2650000, 'Restored walk-ins cleanly re-counted ONCE in Dashboard');
    assert.equal(dashRestored.summary.walkInRevenue, 1150000);
    const kpiRestored = await adminCore.fastKpi({ month: '2026-11' });
    assert.equal(kpiRestored.items.find((x) => x.username === 'cmui').revenue, 800000, 'C Mụi personal KPI still excludes restored walk-in');
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
        ('LEG-DEPOSIT', 'Anh Minh', '2026-10-03', '11:00', 'Giỏ hoa', 'Hủy đơn', 'Ghé lấy', 800000, 'Đã cọc 300', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, false, 'admin', '2026-10-03T05:00:00Z'),
        ('LEG-DEP-MULTI-NUM', 'Chị Thảo', '2026-10-03', '12:00', 'Bó baby', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 700000, 'CK 500.000đ ngày 25/11', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, true, 'admin', '2026-10-03T06:00:00Z'),
        ('LEG-DEP-DECIMAL', 'Anh Khoa', '2026-10-03', '13:00', 'Bó tulip', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 2000000, 'Đã cọc 1,5tr', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, true, 'admin', '2026-10-03T07:00:00Z'),
        ('LEG-DEP-NO-NUM', 'Chị Vy', '2026-10-03', '14:00', 'Bó ly', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', 600000, 'Đã cọc', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, true, 'admin', '2026-10-03T08:00:00Z'),
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
    assert.equal(Number(s.total_suspected_legacy_deleted), 8);
    assert.equal(Number(s.confirmed_with_evidence), 7, '7 rows have system evidence');
    assert.equal(Number(s.insufficient_evidence_keyword_only), 1, '1 row is keyword-only');
    assert.equal(Number(s.unpaid_orders), 2, 'LEG-KW-ONLY + LEG-UNPAID-OK');
    assert.equal(Number(s.deposit_or_partial_paid_orders), 4, 'LEG-DEPOSIT + LEG-DEP-MULTI-NUM + LEG-DEP-DECIMAL + LEG-DEP-NO-NUM');
    assert.equal(Number(s.full_paid_or_settled_orders), 2, 'LEG-FULLPAID + LEG-LOG-SETTLED');
    assert.equal(Number(s.clean_verified_candidates), 1, 'Only LEG-UNPAID-OK is confirmed & unpaid');
    assert.equal(Number(s.owner_manual_review_required), 7, '7 cases require Owner review');
    assert.equal(Number(s.total_order_value_vnd), 6900000);
    assert.equal(Number(s.total_verified_collected_vnd), 1900000, 'ONLY FullPaid (1M) + Settled (900k) count as verified collected');
    assert.equal(Number(s.total_unverified_estimated_paid_vnd), 2300000, '300k + 500k + 1.5M unverified text estimates kept separate');
    assert.equal(Number(s.total_related_debt_vnd), 2700000, '400k + 500k + 500k + 200k + 500k + 600k');

    const byId = Object.fromEntries(detailRes.rows.map((r) => [r.id, r]));
    assert.equal(byId['LEG-KW-ONLY'].classification, 'INSUFFICIENT_EVIDENCE_KEYWORD_ONLY');
    assert.equal(byId['LEG-UNPAID-OK'].classification, 'CONFIRMED_UNPAID_CANDIDATE');
    assert.equal(byId['LEG-DEPOSIT'].classification, 'CONFIRMED_PAID_OR_DEPOSIT_REVIEW');
    assert.equal(Number(byId['LEG-DEPOSIT'].unverified_estimated_paid_vnd), 300000, 'Đã cọc 300 -> 300k');
    assert.equal(Number(byId['LEG-DEPOSIT'].verified_collected_vnd), 0, 'Unverified deposit NEVER reported as verified');
    assert.equal(Number(byId['LEG-DEP-MULTI-NUM'].unverified_estimated_paid_vnd), 500000, 'CK 500.000đ ngày 25/11 -> 500k');
    assert.equal(Number(byId['LEG-DEP-DECIMAL'].unverified_estimated_paid_vnd), 1500000, 'Đã cọc 1,5tr -> 1.5M');
    assert.equal(byId['LEG-DEP-NO-NUM'].classification, 'CONFIRMED_PAID_OR_DEPOSIT_REVIEW');
    assert.equal(byId['LEG-DEP-NO-NUM'].has_unverified_payment_signal, true, 'Đã cọc (no number) flagged for Owner review');
    assert.equal(byId['LEG-FULLPAID'].classification, 'CONFIRMED_LOCKED_FINANCIAL_REVIEW');
    assert.equal(Number(byId['LEG-FULLPAID'].verified_collected_vnd), 1000000);
    assert.equal(byId['LEG-LOG-SETTLED'].classification, 'CONFIRMED_LOCKED_FINANCIAL_REVIEW');
    assert.equal(Number(byId['LEG-LOG-SETTLED'].verified_collected_vnd), 900000);

    // 3. Upgrade DB to UI V3 + Final Deletion Policy Override migrations, verify idempotency (run twice!), then verify Owner-approved backfill
    const v3Files = getMigrationFiles((f) => f >= '20261125');
    for (const pass of [1, 2]) {
      for (const f of v3Files) {
        await pgBase.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8'));
      }
      assert.ok(pass <= 2);
    }

    // Run Owner-approved backfill SQL on isolated test DB:
    // Converts ALL confirmed legacy deleted orders regardless of payment/Full Paid/settled status, while NEVER converting keyword-only rows!
    await pgBase.exec(fs.readFileSync(BACKFILL_SQL_PATH, 'utf8'));
    const afterBackfill = (await pgBase.query('select id, is_deleted, customer, payment, settled, full_paid, full_paid_total from public.orders order by id')).rows;
    const mapAfter = Object.fromEntries(afterBackfill.map((r) => [r.id, r]));
    assert.equal(mapAfter['LEG-KW-ONLY'].is_deleted, false, 'Keyword-only [ĐÃ XÓA] without system evidence MUST NOT auto-convert');
    for (const id of ['LEG-UNPAID-OK', 'LEG-DEPOSIT', 'LEG-DEP-MULTI-NUM', 'LEG-DEP-DECIMAL', 'LEG-DEP-NO-NUM', 'LEG-FULLPAID', 'LEG-LOG-SETTLED']) {
      assert.equal(mapAfter[id].is_deleted, true, id + ' has confirmed deletion evidence -> must convert to Trash');
    }
    assert.equal(mapAfter['LEG-FULLPAID'].full_paid, true, 'Full Paid flag preserved intact in Trash');
    assert.equal(Number(mapAfter['LEG-FULLPAID'].full_paid_total), 1000000, 'Full Paid total preserved intact in Trash');
    assert.equal(mapAfter['LEG-LOG-SETTLED'].settled, true, 'Settled flag preserved intact in Trash');
    assert.equal(mapAfter['LEG-DEPOSIT'].payment, 'Đã cọc 300', 'Deposit text preserved intact in Trash');

    // Re-running backfill is idempotent (zero duplicate deletion history rows); rollback SQL restores cleanly
    await pgBase.exec(fs.readFileSync(BACKFILL_SQL_PATH, 'utf8'));
    const histCnt = (await pgBase.query("select count(*)::int as c from public.order_deletion_history where reason_code = 'LEGACY_MIGRATION'")).rows[0].c;
    assert.equal(histCnt, 7, 'Idempotent re-run must keep exact 7 history rows');
    await pgBase.exec(fs.readFileSync(ROLLBACK_SQL_PATH, 'utf8'));
    const afterRollback = (await pgBase.query("select is_deleted, customer, full_paid, settled from public.orders where id in ('LEG-UNPAID-OK', 'LEG-FULLPAID', 'LEG-LOG-SETTLED') order by id")).rows;
    const rbMap = Object.fromEntries(afterRollback.map((r) => [r.customer.includes('Lan') ? 'UNPAID' : (r.full_paid ? 'FP' : 'SET'), r]));
    assert.equal(rbMap.UNPAID.is_deleted, false);
    assert.equal(rbMap.UNPAID.customer, '[ĐÃ XÓA] Chị Lan');
    assert.equal(rbMap.FP.is_deleted, false);
    assert.equal(rbMap.FP.full_paid, true);
    assert.equal(rbMap.SET.is_deleted, false);
    assert.equal(rbMap.SET.settled, true);
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

    // Apply all UI V3 migrations (RC2..RC5 + Final Deletion Policy Override)
    for (const f of getMigrationFiles((x) => x >= '20261125')) {
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
