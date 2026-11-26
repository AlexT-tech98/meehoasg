'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => path.join('supabase/migrations', f));

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end $$;
    create schema if not exists storage;
    create table if not exists storage.buckets (
      id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
    );
  `);
  await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  for (const rel of MIGRATIONS) {
    await pg.exec(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
  await pg.exec(`
    insert into public.app_users (username, password_hash, display_name, role, active) values
      ('admin', 'hash', 'Admin', 'ADMIN', true),
      ('sale1', 'hash', 'Sale Một', 'SALE', true),
      ('sale2', 'hash', 'Sale Hai', 'SALE', true),
      ('tho1', 'hash', 'Thợ Một', 'THO_OPS', true)
    on conflict (username) do nothing;
  `);
  return pg;
}

async function mutate(pg, actor, requestId, action, input) {
  const fp = createHash('sha256').update(JSON.stringify({ actor, requestId, action, input })).digest('hex');
  const res = await pg.query(
    'select public.mee_ops_mutate($1, $2, $3, $4, $5::jsonb) as res',
    [actor, requestId, action, fp, JSON.stringify(input)]
  );
  return res.rows[0].res;
}

function baseOrder(overrides = {}) {
  return {
    customer: 'Chị Lan',
    phone: '0901234567',
    order_date: '2026-11-25',
    order_time: '10:30',
    flower: 'Bó hồng đỏ Ecuador 15 cành',
    note: 'Giao giờ hành chính',
    tag_note_free: '',
    shipping: 'Shop book ship',
    address: '123 Lê Lợi, Q1',
    flower_total: 650000,
    payment: 'Cọc 200k',
    sale: 'sale1',
    card: false,
    card_qty: 0,
    card_text: '',
    banner: false,
    banner_qty: 0,
    banner_text: '',
    charm_fee: 0,
    charm_text: '',
    paper_fee: 0,
    paper_text: '',
    vat: 0,
    ship_fee: 30000,
    ship_confirmed: true,
    image_urls: ['supabase://order-images/11111111-1111-4111-8111-111111111111.jpg'],
    ...overrides
  };
}

test('TC-13: Tag note free CRUD, multiline, legacy client omission, and zero financial impact', async () => {
  const pg = await createDb();
  const { normalizeOperationOrder } = await import('../supabase/functions/_shared/operations.js');

  // Re-running migration is idempotent
  await pg.exec(fs.readFileSync(path.join(ROOT, MIGRATIONS[MIGRATIONS.length - 1]), 'utf8'));

  const tagVal = 'Ghi tag tặng sinh nhật\nKý tên: Gia đình bé Bống';
  const created = await mutate(pg, 'sale1', 'req-tc13-1', 'createOrder', {
    newOrderId: 'MEE-TC13-01',
    order: baseOrder({ tag_note_free: tagVal })
  });
  assert.equal(created.ok, true);
  assert.equal(created.row.tag_note_free, tagVal);
  assert.equal(Number(created.row.flower_total), 650000);
  assert.equal(Number(created.row.charm_fee), 0);
  assert.equal(created.row.card, false);

  // Legacy client omitting tagNoteFree in update preserves existing tag_note_free
  const normLegacy = normalizeOperationOrder({
    customer: 'Chị Lan',
    date: '2026-11-25',
    time: '10:30',
    flower: 'Bó hồng đỏ',
    shipping: 'Ghé lấy',
    flowerTotal: 650000
  }, { username: 'sale1', role: 'SALE' }, created.row);
  assert.equal(normLegacy.tag_note_free, tagVal);

  // Explicit update changes tag_note_free, explicit empty clears it
  const updated = await mutate(pg, 'sale1', 'req-tc13-2', 'updateOrder', {
    orderId: 'MEE-TC13-01',
    expectedUpdatedAt: created.row.updated_at,
    order: baseOrder({ tag_note_free: 'Chúc mừng khai trương' })
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.row.tag_note_free, 'Chúc mừng khai trương');

  const cleared = await mutate(pg, 'sale1', 'req-tc13-3', 'updateOrder', {
    orderId: 'MEE-TC13-01',
    expectedUpdatedAt: updated.row.updated_at,
    order: baseOrder({ tag_note_free: '' })
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.row.tag_note_free, '');
  await pg.close();
});

test('TC-14/TC-15/TC-16: Soft delete ownership matrix, mandatory reason, financial locks, restore & history', async () => {
  const pg = await createDb();

  // Create orders for sale1, sale2, tho1
  const s1 = await mutate(pg, 'sale1', 'r-s1', 'createOrder', { newOrderId: 'MEE-S1', order: baseOrder({ sale: 'sale1', payment: 'Cọc 200k' }) });
  const s2 = await mutate(pg, 'sale2', 'r-s2', 'createOrder', { newOrderId: 'MEE-S2', order: baseOrder({ sale: 'sale2', payment: 'Chưa thanh toán' }) });
  const t1 = await mutate(pg, 'tho1', 'r-t1', 'createOrder', { newOrderId: 'MEE-T1', order: baseOrder({ sale: 'Thợ Một', payment: 'Chưa thanh toán' }) });
  const fp = await mutate(pg, 'sale1', 'r-fp', 'createOrder', {
    newOrderId: 'MEE-FP',
    fullPaidRequested: true,
    newBillUrls: ['supabase://settlement-bills/22222222-2222-4222-8222-222222222222.jpg'],
    order: baseOrder({ sale: 'sale1' })
  });
  const settledOrd = await mutate(pg, 'admin', 'r-set', 'createOrder', { newOrderId: 'MEE-SET', order: baseOrder({ sale: 'sale1' }) });
  await pg.query("update public.orders set settled = true where id = 'MEE-SET'");
  const pendingOrd = await mutate(pg, 'admin', 'r-pend', 'createOrder', { newOrderId: 'MEE-PEND', order: baseOrder({ sale: 'sale1' }) });
  await pg.query("insert into public.settlement_requests (id, order_id, sale_username, status) values ('SET-1', 'MEE-PEND', 'sale1', 'PENDING')");

  // 1. Empty or whitespace reason rejected
  const noReason = await mutate(pg, 'admin', 'r-del-noreason', 'deleteOrder', {
    orderId: 'MEE-S1', expectedUpdatedAt: s1.row.updated_at, reason: '   ', reasonCode: 'OTHER'
  });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, 'DELETE_REASON_REQUIRED');

  // 2. Ownership enforcement: SALE cannot delete another Sale's order
  const saleOther = await mutate(pg, 'sale1', 'r-del-other', 'deleteOrder', {
    orderId: 'MEE-S2', expectedUpdatedAt: s2.row.updated_at, reason: 'Khách hủy đơn', reasonCode: 'CUSTOMER_CANCELLED'
  });
  assert.equal(saleOther.ok, false);
  assert.equal(saleOther.code, 'NOT_OWNER');

  // 3. THO_OPS cannot delete Sale's order, CAN delete own order (matched by display_name 'Thợ Một')
  const thoOther = await mutate(pg, 'tho1', 'r-tho-other', 'deleteOrder', {
    orderId: 'MEE-S2', expectedUpdatedAt: s2.row.updated_at, reason: 'Tạo nhầm đơn', reasonCode: 'CREATED_BY_MISTAKE'
  });
  assert.equal(thoOther.ok, false);
  assert.equal(thoOther.code, 'NOT_OWNER');

  const thoOwn = await mutate(pg, 'tho1', 'r-tho-own', 'deleteOrder', {
    orderId: 'MEE-T1', expectedUpdatedAt: t1.row.updated_at, reason: 'Tạo nhầm đơn', reasonCode: 'CREATED_BY_MISTAKE'
  });
  assert.equal(thoOwn.ok, true);
  assert.equal(thoOwn.row.is_deleted, true);
  assert.equal(thoOwn.row.deleted_by, 'tho1');
  assert.equal(thoOwn.row.deleted_by_role, 'THO_OPS');
  assert.equal(thoOwn.row.deleted_reason, 'Tạo nhầm đơn');
  assert.ok(!thoOwn.row.customer.includes('[ĐÃ XÓA]'), 'Must never inject [ĐÃ XÓA] into customer');
  assert.ok(!thoOwn.row.flower.includes('[ĐÃ XÓA]'), 'Must never inject [ĐÃ XÓA] into flower');
  assert.ok(!thoOwn.row.note.includes('[ĐÃ XÓA'), 'Must never inject [ĐÃ XÓA] into note');

  // 4. Final Order Deletion Policy Override:
  //    - Non-delete financial locks (updateOrder) stay strictly enforced on settled & pending Payment Check orders.
  //    - Owners (SALE / THO_OPS) and ADMIN CAN delete own/any orders regardless of deposit, Full Paid, pending Payment Check, or settled status.
  for (const id of ['MEE-SET', 'MEE-PEND']) {
    const fresh = (await pg.query('select * from public.orders where id = $1', [id])).rows[0];
    const editBlocked = await mutate(pg, 'admin', 'r-edit-block-' + id, 'updateOrder', {
      orderId: id,
      expectedUpdatedAt: fresh.updated_at,
      order: baseOrder({ sale: fresh.sale, note: 'Cố sửa đơn đã khóa' })
    });
    assert.equal(editBlocked.ok, false, id + ' updateOrder must remain locked');
    assert.equal(editBlocked.code, 'ORDER_LOCKED');
  }

  // Non-owner SALE (sale2) CANNOT delete sale1's Full Paid / settled / pending / deposited orders
  for (const id of ['MEE-FP', 'MEE-SET', 'MEE-PEND', 'MEE-S1']) {
    const fresh = (await pg.query('select updated_at from public.orders where id = $1', [id])).rows[0];
    const nonOwnerBlocked = await mutate(pg, 'sale2', 'r-nonowner-del-' + id, 'deleteOrder', {
      orderId: id, expectedUpdatedAt: fresh.updated_at, reason: 'Khách hủy đơn', reasonCode: 'CUSTOMER_CANCELLED'
    });
    assert.equal(nonOwnerBlocked.ok, false, 'Non-owner must be denied deleting ' + id);
    assert.equal(nonOwnerBlocked.code, 'NOT_OWNER');
  }

  // 5. SALE CAN delete own UNPAID order (paid = 0) AND own DEPOSITED order (MEE-S1, Cọc 200k)
  const s1Unpaid = await mutate(pg, 'sale1', 'r-s1-unpaid', 'createOrder', {
    newOrderId: 'MEE-S1-UNPAID',
    order: baseOrder({ sale: 'sale1', payment: 'Chưa thanh toán' })
  });
  const saleOwnUnpaid = await mutate(pg, 'sale1', 'r-sale-own-unpaid', 'deleteOrder', {
    orderId: 'MEE-S1-UNPAID', expectedUpdatedAt: s1Unpaid.row.updated_at, reason: 'Tạo nhầm đơn', reasonCode: 'CREATED_BY_MISTAKE'
  });
  assert.equal(saleOwnUnpaid.ok, true);
  assert.equal(saleOwnUnpaid.hadPayment, false);

  const salePaidDel = await mutate(pg, 'sale1', 'r-sale-paid-del', 'deleteOrder', {
    orderId: 'MEE-S1', expectedUpdatedAt: s1.row.updated_at, reason: 'Khách hủy đơn đã cọc', reasonCode: 'CUSTOMER_CANCELLED'
  });
  assert.equal(salePaidDel.ok, true);
  assert.equal(salePaidDel.hadPayment, true);
  assert.equal(Number(salePaidDel.paidAmount), 200000);
  assert.equal(salePaidDel.row.payment, 'Cọc 200k');
  assert.equal(salePaidDel.row.image_urls.length, 1);

  // ADMIN and owner CAN soft-delete Full Paid, settled, and pending Payment Check orders; Payment Check blocks review on deleted orders
  for (const [id, actor] of [['MEE-FP', 'sale1'], ['MEE-SET', 'sale1'], ['MEE-PEND', 'admin']]) {
    const fresh = (await pg.query('select updated_at from public.orders where id = $1', [id])).rows[0];
    const delOk = await mutate(pg, actor, 'r-del-fin-' + id, 'deleteOrder', {
      orderId: id, expectedUpdatedAt: fresh.updated_at, reason: 'Khách hủy đơn', reasonCode: 'CUSTOMER_CANCELLED'
    });
    assert.equal(delOk.ok, true, actor + ' must be able to soft-delete ' + id);
    assert.equal(delOk.row.is_deleted, true);
  }
  const reviewDeleted = await mutate(pg, 'admin', 'r-rev-deleted-pend', 'reviewSettlement', {
    settlementId: 'SET-1', decision: 'APPROVED'
  });
  assert.equal(reviewDeleted.ok, false);
  assert.equal(reviewDeleted.code, 'ORDER_DELETED');

  // 6. ADMIN deletes another Sale's eligible order -> succeeds
  const adminDel = await mutate(pg, 'admin', 'r-admin-del', 'deleteOrder', {
    orderId: 'MEE-S2', expectedUpdatedAt: s2.row.updated_at, reason: 'Đơn bị trùng', reasonCode: 'DUPLICATE_ORDER'
  });
  assert.equal(adminDel.ok, true);
  assert.equal(adminDel.row.deleted_by, 'admin');
  assert.equal(adminDel.row.deleted_by_role, 'ADMIN');

  // 7. Restore denied for SALE and THO_OPS
  for (const actor of ['sale1', 'tho1']) {
    const denied = await mutate(pg, actor, 'r-res-deny-' + actor, 'restoreOrder', {
      orderId: 'MEE-S1', expectedUpdatedAt: salePaidDel.row.updated_at
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'NOT_OWNER');
  }

  // 8. ADMIN restores MEE-S1 in-place; history preserved across restore + second delete
  const restored = await mutate(pg, 'admin', 'r-res-ok', 'restoreOrder', {
    orderId: 'MEE-S1', expectedUpdatedAt: salePaidDel.row.updated_at, reason: 'Khách đặt lại'
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.row.id, 'MEE-S1');
  assert.equal(restored.row.is_deleted, false);
  assert.equal(restored.row.restored_by, 'admin');
  assert.ok(restored.row.restored_at);
  assert.equal(restored.row.deleted_reason, 'Khách hủy đơn đã cọc', 'Last deletion reason retained on row');

  const delAgain = await mutate(pg, 'admin', 'r-del-again', 'deleteOrder', {
    orderId: 'MEE-S1', expectedUpdatedAt: restored.row.updated_at, reason: 'Khách đổi ý lần 2', reasonCode: 'OTHER'
  });
  assert.equal(delAgain.ok, true);

  const hist = (await pg.query("select event_type, actor_username, reason_text as reason from public.order_deletion_history where order_id = 'MEE-S1' order by id asc")).rows;
  assert.deepEqual(hist.map(h => h.event_type), ['DELETE', 'RESTORE', 'DELETE']);
  assert.equal(hist[0].reason, 'Khách hủy đơn đã cọc');
  assert.equal(hist[1].reason, 'Khách đặt lại');
  assert.equal(hist[2].reason, 'Khách đổi ý lần 2');

  // No duplicate order IDs created
  const cnt = (await pg.query("select count(*)::int as c from public.orders where id = 'MEE-S1'")).rows[0].c;
  assert.equal(cnt, 1);

  // RLS & anon/authenticated revocation on order_deletion_history
  const priv = (await pg.query(`
    select has_table_privilege('anon', 'public.order_deletion_history', 'SELECT') as a,
           has_table_privilege('authenticated', 'public.order_deletion_history', 'SELECT') as au,
           has_table_privilege('service_role', 'public.order_deletion_history', 'SELECT') as sr
  `)).rows[0];
  assert.equal(priv.a, false);
  assert.equal(priv.au, false);
  assert.equal(priv.sr, true);

  await pg.close();
});

test('TC-14 Legacy [ĐÃ XÓA] backfill & rollback scripts work cleanly and reversibly', async () => {
  const pg = await createDb();
  await pg.query(`
    insert into public.orders (
      id, customer, phone, order_date, order_time, flower, note, shipping, address,
      flower_total, payment, sale, status, delete_after_sheet_sync, delete_requested_by, delete_requested_at
    ) values (
      'MEE-LEG-1', '[ĐÃ XÓA] Nguyễn Văn A', '0909000111', '2026-10-20', '14:00',
      '[ĐÃ XÓA] Bó hướng dương', 'Giao chiều [ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', '',
      350000, 'Chưa thanh toán', 'sale1', 'Chờ bó', true, 'admin', '2026-10-20T05:00:00Z'
    )
  `);

  // Run backfill
  await pg.exec(fs.readFileSync(path.join(ROOT, 'scripts/legacy-deleted-orders-backfill.sql'), 'utf8'));
  const after = (await pg.query("select * from public.orders where id = 'MEE-LEG-1'")).rows[0];
  assert.equal(after.is_deleted, true);
  assert.equal(after.customer, 'Nguyễn Văn A');
  assert.equal(after.flower, 'Bó hướng dương');
  assert.equal(after.note, 'Giao chiều');
  assert.equal(after.deleted_reason_code, 'LEGACY_MIGRATION');
  assert.equal(after.deleted_by, 'admin');

  const histCount = (await pg.query("select count(*)::int as c from public.order_deletion_history where order_id = 'MEE-LEG-1'")).rows[0].c;
  assert.equal(histCount, 1);

  // Run rollback
  await pg.exec(fs.readFileSync(path.join(ROOT, 'scripts/legacy-deleted-orders-rollback.sql'), 'utf8'));
  const rolled = (await pg.query("select * from public.orders where id = 'MEE-LEG-1'")).rows[0];
  assert.equal(rolled.is_deleted, false);
  assert.equal(rolled.delete_after_sheet_sync, true);
  assert.equal(rolled.customer, '[ĐÃ XÓA] Nguyễn Văn A');
  assert.equal(rolled.flower, '[ĐÃ XÓA] Bó hướng dương');
  assert.equal(rolled.note, 'Giao chiều [ĐÃ XÓA TRÊN OPS]');
  const histAfterRollback = (await pg.query("select count(*)::int as c from public.order_deletion_history where order_id = 'MEE-LEG-1'")).rows[0].c;
  assert.equal(histAfterRollback, 0);

  await pg.close();
});

test('TC-17: Server-side full-period filtering, Đã bó projection, debt filter, and counts across 135 active + 5 deleted orders', async () => {
  const pg = await createDb();

  // Seed 135 active orders:
  // 40 Chờ bó (unpaid -> debt)
  // 25 Đã bó + Shop book ship -> projected to Chờ giao (unpaid -> debt)
  // 15 Đã bó + Ghé lấy -> projected to Chờ lấy (unpaid -> debt)
  // 20 Chờ giao (settled -> debt = 0)
  // 10 Chờ lấy (full_paid -> debt = 0)
  // 25 Đã giao (10 unpaid debt, 15 full_paid -> debt = 0)
  // + 5 soft-deleted orders (must NEVER appear in counts or rows)
  const specs = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `O-CB-${i}`, status: 'Chờ bó', shipping: 'Shop book ship', payment: 'Chưa thanh toán', settled: false, full_paid: false, is_deleted: false })),
    ...Array.from({ length: 25 }, (_, i) => ({ id: `O-DBG-${i}`, status: 'Đã bó', shipping: 'Shop book ship', payment: 'Cọc 100k', settled: false, full_paid: false, is_deleted: false })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `O-DBL-${i}`, status: 'Đã bó', shipping: 'Ghé lấy', payment: 'Chưa thanh toán', settled: false, full_paid: false, is_deleted: false })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `O-CG-${i}`, status: 'Chờ giao', shipping: 'Shop book ship', payment: 'Đã thanh toán', settled: true, full_paid: false, is_deleted: false })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `O-CL-${i}`, status: 'Chờ lấy', shipping: 'Ghé lấy', payment: 'Full Paid', settled: false, full_paid: true, is_deleted: false })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `O-DGD-${i}`, status: 'Đã giao', shipping: 'Shop book ship', payment: 'Cọc 200k', settled: false, full_paid: false, is_deleted: false })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `O-DGP-${i}`, status: 'Đã giao', shipping: 'Shop book ship', payment: 'Full Paid', settled: false, full_paid: true, is_deleted: false })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `O-DEL-${i}`, status: 'Chờ bó', shipping: 'Shop book ship', payment: 'Chưa thanh toán', settled: false, full_paid: false, is_deleted: true }))
  ];

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const hh = String(Math.floor(i / 10) % 24).padStart(2, '0');
    const mm = String((i * 7) % 60).padStart(2, '0');
    await pg.query(`
      insert into public.orders (
        id, customer, phone, order_date, order_time, flower, note, shipping, address,
        flower_total, payment, sale, status, settled, full_paid, full_paid_total, full_paid_bill_urls, image_urls, is_deleted
      ) values ($1, $2, '0901234567', '2026-11-25', $3, 'Hoa test', '', $4, 'Q1', 500000, $5, 'sale1', $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
    `, [
      s.id, 'Khách ' + s.id, `${hh}:${mm}`, s.shipping, s.payment, s.status, s.settled, s.full_paid,
      s.full_paid ? 500000 : 0,
      JSON.stringify(s.full_paid ? ['supabase://settlement-bills/22222222-2222-4222-8222-222222222222.jpg'] : []),
      JSON.stringify(s.full_paid ? ['supabase://order-images/11111111-1111-4111-8111-111111111111.jpg'] : []),
      s.is_deleted
    ]);
  }

  const page1 = (await pg.query(
    "select public.mee_search_orders_page('', '2026-11-25', '2026-11-25', 80, 0, null, false) as res"
  )).rows[0].res;
  assert.equal(page1.scopeTotal, 135);
  assert.equal(page1.total, 135);
  assert.equal(page1.rows.length, 80);
  assert.deepEqual(page1.counts, {
    'Tất cả': 135,
    'Chờ bó': 40,
    'Chờ giao': 45, // 25 Đã bó (Shop book ship) + 20 Chờ giao
    'Chờ lấy': 25,  // 15 Đã bó (Ghé lấy) + 10 Chờ lấy
    'Đã giao': 25,
    'Còn nợ': 90    // 40 + 25 + 15 + 10
  });

  const page2 = (await pg.query(
    "select public.mee_search_orders_page('', '2026-11-25', '2026-11-25', 80, 80, null, false) as res"
  )).rows[0].res;
  assert.equal(page2.rows.length, 55);
  const allIds = new Set([...page1.rows.map(r => r.id), ...page2.rows.map(r => r.id)]);
  assert.equal(allIds.size, 135, 'Pages 1+2 must cover all 135 active orders without duplicates');
  assert.ok(![...allIds].some(id => id.startsWith('O-DEL-')), 'Deleted orders must be excluded');

  // Filter Chờ giao returns all 45 (including projected Đã bó + Shop book ship), while counts remain full-period!
  const choGiao = (await pg.query(
    "select public.mee_search_orders_page('', '2026-11-25', '2026-11-25', 80, 0, 'Chờ giao', false) as res"
  )).rows[0].res;
  assert.equal(choGiao.total, 45);
  assert.equal(choGiao.rows.length, 45);
  assert.equal(choGiao.scopeTotal, 135);
  assert.equal(choGiao.counts['Chờ bó'], 40);

  // Filter Chờ lấy returns all 25 (including projected Đã bó + Ghé lấy)
  const choLay = (await pg.query(
    "select public.mee_search_orders_page('', '2026-11-25', '2026-11-25', 80, 0, 'Chờ lấy', false) as res"
  )).rows[0].res;
  assert.equal(choLay.total, 25);
  assert.equal(choLay.rows.length, 25);

  // Filter DEBT returns 90 across 2 pages (80 + 10)
  const debtP1 = (await pg.query(
    "select public.mee_search_orders_page('', '2026-11-25', '2026-11-25', 80, 0, null, true) as res"
  )).rows[0].res;
  const debtP2 = (await pg.query(
    "select public.mee_search_orders_page('', '2026-11-25', '2026-11-25', 80, 80, null, true) as res"
  )).rows[0].res;
  assert.equal(debtP1.total, 90);
  assert.equal(debtP1.rows.length, 80);
  assert.equal(debtP2.rows.length, 10);

  await pg.close();
});

test('TC-14/TC-18: Edge core getDeletedOrders auth, soft-delete exclusion across modules, and fastOrder previewUrls', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/meehoasg-api-core/index.js'), 'utf8').replace(/^import .*\n/gm, '');
  const imgRef = 'supabase://order-images/12345678-1234-4234-8234-123456789abc.jpg';

  function makeCore(actor) {
    const c = {
      console, TextEncoder, URL, Date, Intl, crypto: webcrypto,
      createOperationService: () => ({ run: async () => ({ ok: true }) }),
      createR2ImageReader:()=>async v=>v,createR2Media:()=>null,createOperationStorage: () => ({}),
      Deno: { env: { get: () => '' }, serve() {} }
    };
    vm.createContext(c);
    vm.runInContext(source, c);
    c.requireUser = async (_p, roles) => {
      if (roles && !roles.includes(actor.role)) throw new Error('Không có quyền thực hiện.');
      return actor;
    };
    c.saleDirectory = async () => ({
      users: [
        { username: 'admin', display_name: 'Admin', role: 'ADMIN', active: true },
        { username: 'sale1', display_name: 'Sale Một', role: 'SALE', active: true }
      ],
      map: new Map([
        ['admin', { username: 'admin', display_name: 'Admin', role: 'ADMIN' }],
        ['sale1', { username: 'sale1', display_name: 'Sale Một', role: 'SALE' }],
        ['salemot', { username: 'sale1', display_name: 'Sale Một', role: 'SALE' }]
      ])
    });
    c.settlementMap = async () => ({});
    c.displayUrls = async urls => urls.map(u => 'https://signed.test/' + encodeURIComponent(u));
    return c;
  }

  // TC-18: fastOrder returns previewUrls alongside full-res imageUrls and canonical driveUrls
  const adminCore = makeCore({ username: 'admin', display_name: 'Admin', role: 'ADMIN' });
  adminCore.one = async () => ({
    id: 'MEE-IMG-1', updated_at: '2026-11-25T00:00:00Z', customer: 'A', phone: '', address: '',
    order_date: '2026-11-25', order_time: '09:00', flower: 'Hồng', note: '', tag_note_free: 'Free tag',
    shipping: 'Ghé lấy', flower_total: 500000, payment: '', sale: 'sale1', status: 'Chờ bó',
    settled: false, full_paid: false, full_paid_bill_urls: [], image_urls: [imgRef], is_deleted: false
  });
  const detail = await adminCore.fastOrder({ orderId: 'MEE-IMG-1' });
  assert.equal(detail.ok, true);
  assert.equal(detail.order.tagNoteFree, 'Free tag');
  assert.equal(detail.order.driveUrls[0], imgRef);
  assert.match(detail.order.imageUrls[0], /123456789abc\.jpg/);
  assert.match(detail.order.previewUrls[0], /123456789abc\.preview\.jpg/);

  // Non-ADMIN cannot view soft-deleted order via fastOrder or getDeletedOrders
  const saleCore = makeCore({ username: 'sale1', display_name: 'Sale Một', role: 'SALE' });
  saleCore.one = async () => ({ id: 'MEE-DEL-X', is_deleted: true, image_urls: [], full_paid_bill_urls: [] });
  const deniedOrder = await saleCore.fastOrder({ orderId: 'MEE-DEL-X' });
  assert.equal(deniedOrder.ok, false);
  assert.equal(deniedOrder.code, 'ORDER_DELETED');
  await assert.rejects(() => saleCore.getDeletedOrders({}), /Không có quyền/);

  // ADMIN can view Trash with deletionHistory & hasPaymentAudit
  adminCore.all = async (table) => {
    if (table === 'orders') return [{
      id: 'MEE-TRASH-1', updated_at: '2026-11-25T00:00:00Z', customer: 'Chị B', phone: '', address: '',
      order_date: '2026-11-25', order_time: '10:00', flower: 'Tulip', note: '', tag_note_free: '',
      shipping: 'Ghé lấy', flower_total: 600000, payment: 'Cọc 250k', sale: 'sale1', status: 'Chờ bó',
      settled: false, full_paid: false, full_paid_bill_urls: [], image_urls: [imgRef],
      is_deleted: true, deleted_at: '2026-11-25T01:00:00Z', deleted_by: 'sale1', deleted_by_role: 'SALE',
      deleted_reason: 'Khách hủy đơn', deleted_reason_code: 'CUSTOMER_CANCELLED'
    }];
    if (table === 'order_deletion_history') return [{
      id: 1, order_id: 'MEE-TRASH-1', event_type: 'DELETE', actor_username: 'sale1',
      actor_display_name: 'Sale Một', actor_role: 'SALE', reason_code: 'CUSTOMER_CANCELLED',
      reason: 'Khách hủy đơn', occurred_at: '2026-11-25T01:00:00Z'
    }];
    return [];
  };
  const trash = await adminCore.getDeletedOrders({});
  assert.equal(trash.ok, true);
  assert.equal(trash.total, 1);
  assert.equal(trash.items[0].hasPaymentAudit, true);
  assert.equal(trash.items[0].deletedReason, 'Khách hủy đơn');
  assert.equal(trash.items[0].deletionHistory.length, 1);

  // Dashboard, KPI, Debt, Production, FlowerInventory exclude soft-deleted orders
  const activeAndDeleted = [
    {
      id: 'MEE-ACT', updated_at: '2026-11-25T00:00:00Z', customer: 'Active', phone: '', address: '',
      order_date: '2026-11-25', order_time: '10:00', flower: 'Hồng đỏ', note: '', tag_note_free: '',
      shipping: 'Ghé lấy', flower_total: 500000, payment: 'Chưa thanh toán', sale: 'sale1', status: 'Chờ bó',
      settled: false, full_paid: true, full_paid_total: 500000, full_paid_bill_urls: [], image_urls: [], is_deleted: false
    },
    {
      id: 'MEE-SOFTDEL', updated_at: '2026-11-25T00:00:00Z', customer: 'Deleted', phone: '', address: '',
      order_date: '2026-11-25', order_time: '10:30', flower: 'Tulip', note: '', tag_note_free: '',
      shipping: 'Ghé lấy', flower_total: 900000, payment: 'Chưa thanh toán', sale: 'sale1', status: 'Chờ bó',
      settled: false, full_paid: true, full_paid_total: 900000, full_paid_bill_urls: [], image_urls: [], is_deleted: true
    }
  ];
  adminCore.all = async (table) => table === 'orders' ? activeAndDeleted : [];
  const dash = await adminCore.fastDashboard({ start: '2026-11-25', end: '2026-11-25' });
  assert.equal(dash.summary.orders, 1);
  assert.equal(dash.summary.grossRevenue, 500000);
  const kpi = await adminCore.fastKpi({ month: '2026-11' });
  assert.equal(kpi.items[0].revenue, 500000);
  const prod = await adminCore.fastProduction({ date: '2026-11-25' });
  assert.equal(prod.orders.length, 1);
  assert.equal(prod.orders[0].id, 'MEE-ACT');

  // Final Deletion Policy Override: fastDebt excludes all deleted orders completely and removes deletedWithPaymentAudit
  adminCore.all = async (table) => {
    if (table !== 'orders') return [];
    return [
      {
        id: 'MEE-DEL-PAID', updated_at: '2026-11-25T00:00:00Z', customer: 'Khách cọc đã xóa', phone: '0901112222', address: '',
        order_date: '2026-11-25', order_time: '11:00', flower: 'Hồng', note: '', tag_note_free: '',
        shipping: 'Ghé lấy', flower_total: 700000, payment: 'Cọc 300k', sale: 'sale1', status: 'Chờ bó',
        settled: false, full_paid: false, full_paid_bill_urls: [], image_urls: [],
        is_deleted: true, deleted_at: '2026-11-25T02:00:00Z', deleted_by: 'admin', deleted_by_role: 'ADMIN',
        deleted_reason: 'Khách hủy đơn đã cọc', deleted_reason_code: 'CUSTOMER_CANCELLED'
      },
      {
        id: 'MEE-ACT-DEBT', updated_at: '2026-11-25T00:00:00Z', customer: 'Khách nợ active', phone: '', address: '',
        order_date: '2026-11-25', order_time: '10:00', flower: 'Tulip', note: '', tag_note_free: '',
        shipping: 'Ghé lấy', flower_total: 500000, payment: 'Chưa thanh toán', sale: 'sale1', status: 'Chờ bó',
        settled: false, full_paid: false, full_paid_bill_urls: [], image_urls: [], is_deleted: false
      }
    ];
  };
  const debtRes = await adminCore.fastDebt({ start: '2026-11-25', end: '2026-11-25' });
  assert.equal(debtRes.items.length, 1);
  assert.equal(debtRes.summary.debt, 500000);
  assert.equal(debtRes.deletedWithPaymentAudit, undefined, 'deletedWithPaymentAudit must be completely removed from Debt');
});

test('RC2 Ownership Hardening: duplicate display_name fails closed & sale reassignment revokes previous owner', async () => {
  const pg = await createDb();
  await pg.exec(`
    insert into public.app_users(username, password_hash, display_name, role, active) values
      ('dup_lan_1', 'h', 'Lan', 'SALE', true),
      ('dup_lan_2', 'h', 'Lan', 'SALE', true);
  `);

  // 1. Creating order with ambiguous display_name 'Lan' is rejected with SALE_AMBIGUOUS
  const ambigCreate = await mutate(pg, 'admin', 'r-ambig-create', 'createOrder', {
    newOrderId: 'MEE-AMB-1',
    order: baseOrder({ sale: 'Lan' })
  });
  assert.equal(ambigCreate.ok, false);
  assert.equal(ambigCreate.code, 'SALE_AMBIGUOUS');

  // 2. Creating order with exact username 'dup_lan_1' succeeds and ONLY dup_lan_1 owns it
  const exactCreate = await mutate(pg, 'admin', 'r-exact-create', 'createOrder', {
    newOrderId: 'MEE-EXACT-1',
    order: baseOrder({ sale: 'dup_lan_1', payment: 'Chưa thanh toán' })
  });
  assert.equal(exactCreate.ok, true);
  const ownerCheck = (await pg.query(`
    select username, public.mee_ops_owner('dup_lan_1', u) as owns_exact,
           public.mee_ops_owner('Lan', u) as owns_ambig
    from public.app_users u where username in ('dup_lan_1', 'dup_lan_2') order by username
  `)).rows;
  assert.equal(ownerCheck[0].owns_exact, true);
  assert.equal(ownerCheck[1].owns_exact, false);
  assert.equal(ownerCheck[0].owns_ambig, false, 'Ambiguous legacy display_name must fail closed');
  assert.equal(ownerCheck[1].owns_ambig, false, 'Ambiguous legacy display_name must fail closed');

  // 3. Legacy row storing ambiguous display_name 'Lan': neither dup_lan_1 nor dup_lan_2 can delete/edit it
  await pg.query(`
    insert into public.orders(id, customer, phone, order_date, order_time, flower, note, shipping, address, flower_total, payment, sale, status)
    values ('MEE-LEG-AMB', 'Khách cũ', '0900000000', '2026-11-25', '10:00', 'Hồng', '', 'Ghé lấy', '', 400000, 'Chưa thanh toán', 'Lan', 'Chờ bó')
  `);
  const legUpdatedAt = (await pg.query("select updated_at from public.orders where id = 'MEE-LEG-AMB'")).rows[0].updated_at;
  for (const actor of ['dup_lan_1', 'dup_lan_2']) {
    const delTry = await mutate(pg, actor, 'r-amb-del-' + actor, 'deleteOrder', {
      orderId: 'MEE-LEG-AMB', expectedUpdatedAt: legUpdatedAt, reason: 'Khách hủy đơn', reasonCode: 'CUSTOMER_CANCELLED'
    });
    assert.equal(delTry.ok, false);
    assert.equal(delTry.code, 'NOT_OWNER');
  }

  // 4. Reassigning order from sale1 -> sale2 revokes sale1 immediately and grants sale2
  const owned = await mutate(pg, 'sale1', 'r-own-create', 'createOrder', {
    newOrderId: 'MEE-REASSIGN-1',
    order: baseOrder({ sale: 'sale1', payment: 'Chưa thanh toán' })
  });
  assert.equal(owned.ok, true);
  const reassigned = await mutate(pg, 'admin', 'r-own-reassign', 'updateOrder', {
    orderId: 'MEE-REASSIGN-1',
    expectedUpdatedAt: owned.row.updated_at,
    order: baseOrder({ sale: 'sale2', payment: 'Chưa thanh toán' })
  });
  assert.equal(reassigned.ok, true);
  assert.equal(reassigned.row.sale, 'sale2');

  const oldOwnerEdit = await mutate(pg, 'sale1', 'r-old-edit', 'updateOrder', {
    orderId: 'MEE-REASSIGN-1',
    expectedUpdatedAt: reassigned.row.updated_at,
    order: baseOrder({ sale: 'sale1', flower: 'Hijack' })
  });
  assert.equal(oldOwnerEdit.ok, false);
  assert.equal(oldOwnerEdit.code, 'NOT_OWNER');

  const oldOwnerDel = await mutate(pg, 'sale1', 'r-old-del', 'deleteOrder', {
    orderId: 'MEE-REASSIGN-1',
    expectedUpdatedAt: reassigned.row.updated_at,
    reason: 'Khách hủy đơn', reasonCode: 'CUSTOMER_CANCELLED'
  });
  assert.equal(oldOwnerDel.ok, false);
  assert.equal(oldOwnerDel.code, 'NOT_OWNER');

  const newOwnerDel = await mutate(pg, 'sale2', 'r-new-del', 'deleteOrder', {
    orderId: 'MEE-REASSIGN-1',
    expectedUpdatedAt: reassigned.row.updated_at,
    reason: 'Khách hủy đơn', reasonCode: 'CUSTOMER_CANCELLED'
  });
  assert.equal(newOwnerDel.ok, true);

  // 5. Edge JS saleDirectory() & canonicalSale() match SQL fail-closed semantics on duplicate display_name
  const source = fs.readFileSync(path.join(ROOT, 'supabase/functions/meehoasg-api-core/index.js'), 'utf8').replace(/^import .*\n/gm, '');
  const c = {
    console, TextEncoder, URL, Date, Intl, crypto: webcrypto,
    createOperationService: () => ({ run: async () => ({ ok: true }) }),
    createR2ImageReader:()=>async v=>v,createR2Media:()=>null,createOperationStorage: () => ({}),
    Deno: { env: { get: () => '' }, serve() {} }
  };
  vm.createContext(c);
  vm.runInContext(source, c);
  c.all = async () => [
    { username: 'dup_lan_1', display_name: 'Lan', role: 'SALE', active: true },
    { username: 'dup_lan_2', display_name: 'Lan', role: 'SALE', active: true },
    { username: 'sale_unique', display_name: 'Minh', role: 'SALE', active: true }
  ];
  const dir = await c.saleDirectory();
  assert.equal(c.canonicalSale('dup_lan_1', dir).username, 'dup_lan_1');
  assert.equal(c.canonicalSale('dup_lan_2', dir).username, 'dup_lan_2');
  assert.equal(c.canonicalSale('Minh', dir).username, 'sale_unique');
  const ambigCanon = c.canonicalSale('Lan', dir);
  assert.equal(ambigCanon.known, false);
  assert.equal(ambigCanon.ambiguous, true);
  assert.equal(ambigCanon.username, '');

  await pg.close();
});

test('RC2 Rollback & Backwards Compatibility: Old FE + New API/DB preserves tag_note_free & hides soft-deleted orders across backup/restore', async () => {
  const pg = await createDb();

  // 1. Create order with tag_note_free and a second order then soft-delete it
  const activeTag = await mutate(pg, 'sale1', 'r-rb-1', 'createOrder', {
    newOrderId: 'MEE-RB-TAG',
    order: baseOrder({ sale: 'sale1', tag_note_free: 'Chúc mừng khai trương phát đạt' })
  });
  assert.equal(activeTag.ok, true);
  assert.equal(activeTag.row.tag_note_free, 'Chúc mừng khai trương phát đạt');

  const toDel = await mutate(pg, 'sale1', 'r-rb-2', 'createOrder', {
    newOrderId: 'MEE-RB-DEL',
    order: baseOrder({ sale: 'sale1', tag_note_free: 'Tag của đơn đã xóa', payment: 'Chưa thanh toán' })
  });
  const delRes = await mutate(pg, 'sale1', 'r-rb-3', 'deleteOrder', {
    orderId: 'MEE-RB-DEL', expectedUpdatedAt: toDel.row.updated_at, reason: 'Khách hủy đơn', reasonCode: 'CUSTOMER_CANCELLED'
  });
  assert.equal(delRes.ok, true);

  // 2. Old Frontend (40667052) sends updateOrder WITHOUT tag_note_free -> MUST preserve existing tag_note_free
  const legacyOrderPayload = baseOrder({ sale: 'sale1', note: 'Sửa từ FE cũ' });
  delete legacyOrderPayload.tag_note_free;
  const legacyEdit = await mutate(pg, 'sale1', 'r-rb-4', 'updateOrder', {
    orderId: 'MEE-RB-TAG',
    expectedUpdatedAt: activeTag.row.updated_at,
    order: legacyOrderPayload
  });
  assert.equal(legacyEdit.ok, true);
  assert.equal(legacyEdit.row.note, 'Sửa từ FE cũ');
  assert.equal(legacyEdit.row.tag_note_free, 'Chúc mừng khai trương phát đạt', 'Old FE edit must NOT wipe tag_note_free');

  // 3. Old Frontend (40667052) calls legacy 5-arg mee_search_orders_page -> works & NEVER resurfaces soft-deleted order
  const legacySearch = (await pg.query(
    "select public.mee_search_orders_page('', '2026-11-25', '2026-11-25', 80, 0) as res"
  )).rows[0].res;
  assert.equal(legacySearch.total, 1);
  assert.deepEqual(legacySearch.rows.map(r => r.id), ['MEE-RB-TAG']);

  // 4. Snapshot backup/restore roundtrip preserves tag_note_free, is_deleted, deleted_reason & order_deletion_history
  const dump = await pg.dumpDataDir();
  const restoredPg = new PGlite({ loadDataDir: dump });
  try {
    const tagRow = (await restoredPg.query("select tag_note_free, is_deleted from public.orders where id = 'MEE-RB-TAG'")).rows[0];
    const delRow = (await restoredPg.query("select tag_note_free, is_deleted, deleted_reason from public.orders where id = 'MEE-RB-DEL'")).rows[0];
    const histCnt = (await restoredPg.query("select count(*)::int as c from public.order_deletion_history where order_id = 'MEE-RB-DEL'")).rows[0].c;
    assert.equal(tagRow.tag_note_free, 'Chúc mừng khai trương phát đạt');
    assert.equal(tagRow.is_deleted, false);
    assert.equal(delRow.tag_note_free, 'Tag của đơn đã xóa');
    assert.equal(delRow.is_deleted, true);
    assert.equal(delRow.deleted_reason, 'Khách hủy đơn');
    assert.equal(histCnt, 1);
  } finally {
    await restoredPg.close();
  }

  await pg.close();
});
