const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { webcrypto } = crypto;
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');

async function createDb(includeCmui = true) {
  const pg = new PGlite();
  await pg.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema if not exists storage;
    create table if not exists storage.buckets (
      id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]
    );
  `);
  await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  const migDir = path.join(ROOT, 'supabase/migrations');
  for (const f of fs.readdirSync(migDir).filter(x => x.endsWith('.sql')).sort()) {
    await pg.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }
  await pg.exec(`
    insert into public.app_users(username, password_hash, display_name, role, active) values
      ('admin', 'h', 'Admin', 'ADMIN', true),
      ('sale1', 'h', 'Sale Một', 'SALE', true),
      ('sale2', 'h', 'Sale Hai', 'SALE', true),
      ('tho1', 'h', 'Thợ Một', 'THO_OPS', true)
      ${includeCmui ? ",('cmui', 'h', 'C Mụi', 'SALE', true)" : ''};
  `);
  return pg;
}

async function mutate(pg, actor, reqId, action, input, fpOverride) {
  const fp = fpOverride || hash(actor + '|' + reqId + '|' + action + '|' + JSON.stringify(input));
  const res = await pg.query(
    'select public.mee_ops_mutate($1, $2, $3, $4, $5::jsonb) as res',
    [actor, reqId, action, fp, JSON.stringify(input)]
  );
  return res.rows[0].res;
}

function baseOrder(over = {}) {
  return {
    customer: 'Chị Hương',
    phone: '0901234567',
    order_date: '2026-11-25',
    order_time: '10:30',
    flower: 'Bó hồng đỏ 20 bông',
    note: 'Gọi trước 15 phút',
    tag_note_free: '',
    shipping: 'Shop book ship',
    address: '101 Nguyễn Huệ, Q1',
    flower_total: 650000,
    payment: 'Chưa thanh toán',
    sale: 'sale1',
    card: false, card_qty: 0, card_text: '',
    banner: false, banner_qty: 0, banner_text: '',
    charm_fee: 0, charm_text: '',
    paper_fee: 0, paper_text: '',
    vat: 0, ship_fee: 35000, ship_confirmed: true,
    image_urls: [],
    ...over
  };
}

test('TC-19: Order Source fixed 6-value validation, UI V3 requirement, legacy/bot compatibility & edit preservation', async () => {
  const pg = await createDb(true);
  const VALID_SOURCES = ['Threads', 'TikTok', 'Page/IG', 'Zalo', 'Google Map', 'Khách ghé tiệm'];

  // 1. UI V3 form (requireOrderSource=true) rejects empty source
  const missingSrc = await mutate(pg, 'sale1', 'rc3-src-miss', 'createOrder', {
    newOrderId: 'RC3-SRC-MISS',
    requireOrderSource: true,
    order: baseOrder({ order_source: '' })
  });
  assert.equal(missingSrc.ok, false);
  assert.equal(missingSrc.code, 'ORDER_SOURCE_REQUIRED');

  // 2. Arbitrary source outside 6 approved values rejected (even without requireOrderSource)
  const invalidSrc = await mutate(pg, 'sale1', 'rc3-src-bad', 'createOrder', {
    newOrderId: 'RC3-SRC-BAD',
    order: baseOrder({ order_source: 'Facebook Ads' })
  });
  assert.equal(invalidSrc.ok, false);
  assert.equal(invalidSrc.code, 'ORDER_SOURCE_INVALID');

  // 3. All 6 approved values succeed and persist
  for (let i = 0; i < VALID_SOURCES.length; i++) {
    const src = VALID_SOURCES[i];
    const ok = await mutate(pg, 'sale1', 'rc3-src-ok-' + i, 'createOrder', {
      newOrderId: 'RC3-SRC-' + i,
      requireOrderSource: true,
      order: baseOrder({ order_source: src })
    });
    assert.equal(ok.ok, true, src + ' must succeed');
    assert.equal(ok.row.order_source, src);
    assert.equal(ok.row.order_type, 'STANDARD');
    assert.equal(ok.row.created_by, 'sale1');
  }

  // 4. Legacy client / Order Bot omitting order_source succeeds with '' (no disruption!)
  const botOrder = baseOrder();
  delete botOrder.order_source;
  const botRes = await mutate(pg, 'sale1', 'rc3-bot-create', 'createOrder', {
    newOrderId: 'RC3-BOT-1',
    order: botOrder
  });
  assert.equal(botRes.ok, true);
  assert.equal(botRes.row.order_source, '');

  // 5. Legacy client editing an order WITHOUT sending order_source preserves existing value
  const threadsRow = (await pg.query("select * from public.orders where id = 'RC3-SRC-0'")).rows[0];
  const legacyEditPayload = baseOrder({ note: 'Sửa từ client cũ' });
  delete legacyEditPayload.order_source;
  const preserved = await mutate(pg, 'sale1', 'rc3-legacy-edit', 'updateOrder', {
    orderId: 'RC3-SRC-0',
    expectedUpdatedAt: threadsRow.updated_at,
    order: legacyEditPayload
  });
  assert.equal(preserved.ok, true);
  assert.equal(preserved.row.order_source, 'Threads', 'Legacy edit omitting order_source must preserve existing value');

  // 6. Authorized edit can update order_source to another approved value
  const changed = await mutate(pg, 'sale1', 'rc3-change-src', 'updateOrder', {
    orderId: 'RC3-SRC-0',
    expectedUpdatedAt: preserved.row.updated_at,
    order: baseOrder({ order_source: 'Zalo' })
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.row.order_source, 'Zalo');

  // 7. Editing legacy order with empty source does not force fake source
  const botEdit = await mutate(pg, 'sale1', 'rc3-bot-edit', 'updateOrder', {
    orderId: 'RC3-BOT-1',
    expectedUpdatedAt: botRes.row.updated_at,
    order: baseOrder({ order_source: '', note: 'Cập nhật đơn cũ' })
  });
  assert.equal(botEdit.ok, true);
  assert.equal(botEdit.row.order_source, '');

  await pg.close();
});

test('TC-20: Walk-in Quick Order canonicalizes C Mụi, records created_by separately, enforces ownership & idempotency, never auto-verifies Full Paid/settled', async () => {
  const pg = await createDb(true);

  // 1. SALE, THO_OPS, ADMIN creating walk-in all assign canonical sale='cmui' while recording real created_by
  for (const [idx, actor, method] of [[1, 'sale1', 'CASH'], [2, 'tho1', 'TRANSFER'], [3, 'admin', 'CASH']]) {
    const res = await mutate(pg, actor, 'rc3-wi-' + idx, 'createOrder', {
      newOrderId: 'RC3-WI-' + idx,
      order: {
        order_type: 'WALK_IN',
        order_date: '2026-11-25',
        order_time: '14:15',
        flower_total: 350000,
        walk_in_payment_method: method,
        flower: idx === 1 ? '' : 'Bó hồng mua trực tiếp'
      }
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.walkIn, true);
    assert.equal(res.row.order_type, 'WALK_IN');
    assert.equal(res.row.customer, 'Khách vãng lai');
    assert.equal(res.row.order_source, 'Khách ghé tiệm');
    assert.equal(res.row.sale, 'cmui', 'Must assign canonical C Mụi username regardless of actor ' + actor);
    assert.equal(res.row.created_by, actor, 'Must record actual creator separately');
    assert.equal(res.row.shipping, 'Ghé lấy');
    assert.equal(res.row.status, 'Đã giao');
    assert.equal(Number(res.row.flower_total), 350000);
    assert.equal(res.row.full_paid, false, 'Must NEVER auto-set full_paid without bill/sample policy');
    assert.equal(res.row.settled, false, 'Must NEVER auto-set settled');
    assert.equal(res.row.walk_in_payment_method, method);

    const debt = Number((await pg.query('select public.mee_ops_debt(o) as d from public.orders o where id = $1', ['RC3-WI-' + idx])).rows[0].d);
    assert.equal(debt, 0, 'Walk-in paid in full must not create fake debt');
  }

  // 2. Idempotent retry with same requestId & same logical payload fingerprint creates ZERO duplicates
  const idemFp = hash('sale1|rc3-wi-idem|createOrder|walkin-250k');
  const retry1 = await mutate(pg, 'sale1', 'rc3-wi-idem', 'createOrder', {
    newOrderId: 'RC3-WI-IDEM-A',
    order: { order_type: 'WALK_IN', order_date: '2026-11-25', order_time: '15:00', flower_total: 250000, walk_in_payment_method: 'CASH' }
  }, idemFp);
  const retry2 = await mutate(pg, 'sale1', 'rc3-wi-idem', 'createOrder', {
    newOrderId: 'RC3-WI-IDEM-B',
    order: { order_type: 'WALK_IN', order_date: '2026-11-25', order_time: '15:00', flower_total: 250000, walk_in_payment_method: 'CASH' }
  }, idemFp);
  assert.equal(retry1.ok, true);
  assert.equal(retry2.ok, true);
  assert.equal(retry2.orderId, retry1.orderId);
  assert.equal(retry2.idempotent, true);
  const idemCount = (await pg.query("select count(*)::int as c from public.orders where id like 'RC3-WI-IDEM-%'")).rows[0].c;
  assert.equal(idemCount, 1);

  // 3. Creator (sale1) does NOT gain edit/delete rights over walk-in order owned by cmui!
  const wi1 = (await pg.query("select * from public.orders where id = 'RC3-WI-1'")).rows[0];
  const creatorEdit = await mutate(pg, 'sale1', 'rc3-wi-creator-edit', 'updateOrder', {
    orderId: 'RC3-WI-1',
    expectedUpdatedAt: wi1.updated_at,
    order: { order_type: 'WALK_IN', order_date: '2026-11-25', order_time: '14:15', flower_total: 400000, walk_in_payment_method: 'CASH' }
  });
  assert.equal(creatorEdit.ok, false);
  assert.equal(creatorEdit.code, 'NOT_OWNER');

  const creatorDel = await mutate(pg, 'sale1', 'rc3-wi-creator-del', 'deleteOrder', {
    orderId: 'RC3-WI-1',
    expectedUpdatedAt: wi1.updated_at,
    reason: 'Thử xóa đơn mình tạo hộ', reasonCode: 'OTHER'
  });
  assert.equal(creatorDel.ok, false);
  assert.equal(creatorDel.code, 'NOT_OWNER');

  // 4. Amount <= 0 and invalid payment method rejected
  const zeroAmt = await mutate(pg, 'sale1', 'rc3-wi-zero', 'createOrder', {
    newOrderId: 'RC3-WI-ZERO',
    order: { order_type: 'WALK_IN', order_date: '2026-11-25', order_time: '14:00', flower_total: 0, walk_in_payment_method: 'CASH' }
  });
  assert.equal(zeroAmt.ok, false);
  assert.equal(zeroAmt.code, 'WALK_IN_INPUT_INVALID');

  const badPay = await mutate(pg, 'sale1', 'rc3-wi-badpay', 'createOrder', {
    newOrderId: 'RC3-WI-BADPAY',
    order: { order_type: 'WALK_IN', order_date: '2026-11-25', order_time: '14:00', flower_total: 200000, walk_in_payment_method: 'CRYPTO' }
  });
  assert.equal(badPay.ok, false);
  assert.equal(badPay.code, 'WALK_IN_PAYMENT_INVALID');

  // 5. Cannot convert STANDARD order into WALK_IN to bypass standard validation
  const std = await mutate(pg, 'admin', 'rc3-std-1', 'createOrder', {
    newOrderId: 'RC3-STD-1',
    order: baseOrder({ order_source: 'Zalo' })
  });
  assert.equal(std.ok, true);
  const morph = await mutate(pg, 'admin', 'rc3-morph', 'updateOrder', {
    orderId: 'RC3-STD-1',
    expectedUpdatedAt: std.row.updated_at,
    order: { order_type: 'WALK_IN', order_date: '2026-11-25', order_time: '10:30', flower_total: 650000, walk_in_payment_method: 'CASH' }
  });
  assert.equal(morph.ok, false);
  assert.equal(morph.code, 'ORDER_TYPE_IMMUTABLE');

  await pg.close();

  // 6. Fail-closed when canonical C Mụi account is absent
  const pgNoCmui = await createDb(false);
  const noCmui = await mutate(pgNoCmui, 'admin', 'rc3-no-cmui', 'createOrder', {
    newOrderId: 'RC3-NO-CMUI',
    order: { order_type: 'WALK_IN', order_date: '2026-11-25', order_time: '14:00', flower_total: 200000, walk_in_payment_method: 'CASH' }
  });
  assert.equal(noCmui.ok, false);
  assert.equal(noCmui.code, 'WALK_IN_OWNER_NOT_CONFIGURED');
  await pgNoCmui.close();
});

test('TC-20 Edge API: Walk-in included in Dashboard daily revenue, excluded from Production & FlowerInventory, preserves KPI gating', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/meehoasg-api-core/index.js'), 'utf8').replace(/^import .*\n/gm, '');
  const c = {
    console, TextEncoder, URL, Date, Intl, crypto: webcrypto,
    createOperationService: () => ({ run: async () => ({ ok: true }) }),
    createOperationStorage: () => ({}),
    Deno: { env: { get: () => '' }, serve() {} }
  };
  vm.createContext(c);
  vm.runInContext(source, c);
  c.requireUser = async () => ({ username: 'admin', display_name: 'Admin', role: 'ADMIN', active: true });
  c.settlementMap = async () => ({});
  c.displayUrls = async u => u;
  c.displayPreviewUrls = async u => u;
  c.db = async () => [];

  const rows = [
    {
      id: 'STD-1', updated_at: '2026-11-25T00:00:00Z', customer: 'Chị A', phone: '0901', address: 'Q1',
      order_date: '2026-11-25', order_time: '09:00', flower: 'Tulip', note: '', tag_note_free: '',
      order_source: 'Threads', order_type: 'STANDARD', walk_in_payment_method: '', created_by: 'sale1',
      shipping: 'Ghé lấy', flower_total: 500000, payment: 'Chưa thanh toán', sale: 'sale1', status: 'Chờ bó',
      settled: false, full_paid: false, full_paid_bill_urls: [], image_urls: [], is_deleted: false
    },
    {
      id: 'WI-1', updated_at: '2026-11-25T01:00:00Z', customer: 'Khách vãng lai', phone: '', address: '',
      order_date: '2026-11-25', order_time: '11:00', flower: 'Khách vãng lai mua hoa tại tiệm', note: '', tag_note_free: '',
      order_source: 'Khách ghé tiệm', order_type: 'WALK_IN', walk_in_payment_method: 'CASH', created_by: 'sale1',
      shipping: 'Ghé lấy', flower_total: 300000, payment: 'Đã thanh toán 300000 đ (Tiền mặt - Khách vãng lai)', sale: 'cmui', status: 'Đã giao',
      settled: false, full_paid: false, full_paid_bill_urls: [], image_urls: [], is_deleted: false
    }
  ];
  c.all = async (table) => {
    if (table === 'app_users') return [
      { username: 'admin', display_name: 'Admin', role: 'ADMIN', active: true },
      { username: 'sale1', display_name: 'Sale Một', role: 'SALE', active: true },
      { username: 'cmui', display_name: 'C Mụi', role: 'SALE', active: true }
    ];
    if (table === 'orders') return rows;
    return [];
  };

  const dash = await c.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
  assert.equal(dash.summary.orders, 2);
  assert.equal(dash.summary.grossRevenue, 800000, 'Dashboard daily revenue includes walk-in');
  assert.equal(dash.summary.debt, 500000, 'Walk-in contributes 0 debt');
  assert.equal(dash.summary['Chờ bó'], 1);
  assert.equal(dash.summary['Đã giao'], 1);
  assert.equal(dash.summary.settledRevenue, 0, 'Unverified walk-in not falsely marked settledRevenue');

  const prod = await c.fastProduction({ date: '2026-11-25' });
  assert.equal(prod.orders.length, 1, 'Walk-in excluded from Production board');
  assert.equal(prod.orders[0].id, 'STD-1');

  const inv = await c.flowerInventory({ start: '2026-11-25', end: '2026-11-25' });
  assert.equal(inv.totalOrders, 1, 'Walk-in excluded from Flower Inventory demand');

  const kpi = await c.fastKpi({ month: '2026-11' });
  assert.equal(kpi.items.length, 0, 'POLICY-02 Override: ALL WALK_IN orders excluded from personal KPI & commission');
});
