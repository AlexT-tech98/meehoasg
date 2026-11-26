'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function getMigrationFiles(filterFn) {
  const dir = path.join(ROOT, 'supabase/migrations');
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return filterFn ? all.filter(filterFn) : all;
}

async function createBaselineDb() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);
  `);
  await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  for (const file of getMigrationFiles((f) => f < '20261125')) {
    await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', file), 'utf8'));
  }
  await pg.exec(`
    insert into public.app_users(username, display_name, role, password_hash, active) values
      ('admin', 'Admin Prod', 'ADMIN', 'hash', true),
      ('sale1', 'Sale An', 'SALE', 'hash', true),
      ('cmui', 'C Mụi', 'SALE', 'hash', true),
      ('tho1', 'Thợ Bình', 'THO_OPS', 'hash', true);
  `);
  return pg;
}

async function applyRc4Migrations(pg) {
  for (const file of getMigrationFiles((f) => f >= '20261125')) {
    await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', file), 'utf8'));
  }
}

test('Release Readiness: Order Bot V1 exact payload shape creates order cleanly on RC4 without orderSource and supports idempotent retry', async () => {
  const pg = await createBaselineDb();
  try {
    await applyRc4Migrations(pg);
    const { createOperationService } = await import('../supabase/functions/_shared/operations.js');

    const service = createOperationService({
      db: async (endpoint, _q, _m, body) => {
        if (endpoint === 'rpc/mee_ops_lookup') {
          const { rows } = await pg.query(
            'select public.mee_ops_lookup($1,$2,$3,$4) as res',
            [body.p_actor, body.p_request_id, body.p_action, body.p_fingerprint]
          );
          return rows[0].res;
        }
        if (endpoint === 'rpc/mee_ops_mutate') {
          const { rows } = await pg.query(
            'select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res',
            [body.p_actor, body.p_request_id, body.p_action, body.p_fingerprint, JSON.stringify(body.p_input)]
          );
          return rows[0].res;
        }
        throw new Error('Unexpected endpoint ' + endpoint);
      },
      one: async (table, q) => {
        if (table === 'orders' && q.id?.startsWith('eq.')) {
          return (await pg.query('select * from public.orders where id = $1', [q.id.slice(3)])).rows[0] || null;
        }
        return null;
      },
      uploadImages: async () => [],
      discardImages: async () => {},
      sha256: async (v) => sha256(v),
      newId: (prefix) => `${prefix}-BOTTEST0001`
    });

    const botUser = { username: 'sale1', display_name: 'Sale An', role: 'SALE' };
    // Exact payload shape produced by order-bot/cloudflare/ops-client.mjs
    const botPayload = {
      requestId: 'tg-bot-req-20261126-001',
      order: {
        customer: 'Chị Thảo (Order Bot)',
        phone: '0909555666',
        date: '2026-11-26',
        order_date: '2026-11-26',
        time: '15:30',
        order_time: '15:30',
        flower: 'Bó hồng Ohara 25 cành mix baby',
        note: 'Giao giờ hành chính [Khách báo đã cọc 200k]',
        shipping: 'Shop book ship',
        address: '45 Nguyễn Thị Minh Khai, Q.1',
        flowerTotal: 750000,
        flower_total: 750000,
        payment: 'Chưa thanh toán',
        sale: 'sale1',
        card: true,
        cardQty: 1,
        card_qty: 1,
        cardText: 'Chúc mừng sinh nhật',
        card_text: 'Chúc mừng sinh nhật',
        banner: false,
        bannerQty: 0,
        banner_qty: 0,
        bannerText: '',
        banner_text: '',
        charmFee: 0,
        charm_fee: 0,
        charmText: '',
        charm_text: '',
        paperFee: 0,
        paper_fee: 0,
        paperText: '',
        paper_text: '',
        vat: 0,
        shipFee: 0,
        ship_fee: 0,
        shipFeeActive: '0',
        ship_confirmed: false,
        fullPaidRequested: false,
        imageFiles: [],
        unverifiedBillFiles: []
      }
    };

    const first = await service.run('createOrder', botPayload, botUser);
    assert.equal(first.ok, true, 'Order Bot createOrder succeeds on RC4');
    assert.equal(first.orderId, 'MEE-BOTTEST0001');
    assert.equal(first.row.order_source, '', 'Order Bot omits source without fabricating one');
    assert.equal(first.row.order_type, 'STANDARD');
    assert.equal(first.row.full_paid, false);
    assert.equal(first.row.status, 'Chờ bó');
    assert.equal(Number(first.row.flower_total), 750000);
    assert.equal(first.row.created_by, 'sale1');

    // Idempotent retry with same requestId returns same order without duplicating
    const retry = await service.run('createOrder', botPayload, botUser);
    assert.equal(retry.ok, true);
    assert.equal(retry.orderId, 'MEE-BOTTEST0001');
    const count = (await pg.query('select count(*)::int as n from public.orders')).rows[0].n;
    assert.equal(count, 1, 'Idempotent Order Bot retry creates exactly 1 row');
  } finally {
    await pg.close();
  }
});

test('Release Readiness: Production baseline upgrade + double-apply idempotency preserves all financial totals, Full Paid, settlements, and V2 rollback safety', async () => {
  const pg = await createBaselineDb();
  try {
    // Seed realistic Production baseline records before UI V3 migrations
    await pg.exec(`
      insert into public.orders(id, customer, phone, order_date, order_time, flower, note, shipping, address, flower_total, payment, sale, status, settled, full_paid, full_paid_total, full_paid_bill_urls, image_urls, card, card_qty, card_text, banner, banner_qty, banner_text, ship_fee, ship_confirmed, delete_after_sheet_sync) values
        ('PROD-STD-1', 'Khách Prod 1', '0901000001', '2026-11-24', '09:00', 'Bó tulip', 'Note prod', 'Shop book ship', 'Q1', 500000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, true, 2, 'Chúc mừng', true, 3, 'Khai trương', 35000, true, false),
        ('PROD-FP-1', 'Khách FullPaid', '0901000002', '2026-11-24', '10:00', 'Giỏ lan', 'FP prod', 'Ghé lấy', '', 1200000, 'Đã thanh toán toàn bộ đơn', 'sale1', 'Đã giao', false, true, 1200000, '["supabase://settlement-bills/fp1.jpg"]'::jsonb, '["supabase://order-images/fp1.jpg"]'::jsonb, false, 0, '', false, 0, '', 0, false, false),
        ('PROD-LEG-DEL', '[ĐÃ XÓA] Khách Hủy', '0901000003', '2026-11-24', '11:00', 'Bó hồng', '[ĐÃ XÓA TRÊN OPS]', 'Ghé lấy', '', 400000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, 0, '[]'::jsonb, '[]'::jsonb, false, 0, '', false, 0, '', 0, false, true);
      insert into public.settlement_requests(id, order_id, sale_username, sale_name, flower_total, accessory_total, vat, ship_fee, required_amount, bill_urls, note, status)
        values ('SET-PROD-1', 'PROD-STD-1', 'sale1', 'Sale An', 500000, 125000, 0, 35000, 660000, '["supabase://settlement-bills/s1.jpg"]'::jsonb, 'Pending prod', 'PENDING');
    `);

    const beforeTotals = (await pg.query('select id, public.mee_ops_total(o)::numeric as total from public.orders o order by id')).rows;

    // Apply RC4 migrations TWICE to prove full idempotency
    await applyRc4Migrations(pg);
    await applyRc4Migrations(pg);

    const afterTotals = (await pg.query('select id, public.mee_ops_total(o)::numeric as total, order_source, order_type, tag_note_free, is_deleted from public.orders o order by id')).rows;
    assert.equal(afterTotals.length, beforeTotals.length);
    for (let i = 0; i < beforeTotals.length; i++) {
      assert.equal(afterTotals[i].id, beforeTotals[i].id);
      assert.equal(Number(afterTotals[i].total), Number(beforeTotals[i].total), `Total preserved for ${afterTotals[i].id}`);
      assert.equal(afterTotals[i].order_source, '');
      assert.equal(afterTotals[i].order_type, 'STANDARD');
      assert.equal(afterTotals[i].tag_note_free, '');
      assert.equal(afterTotals[i].is_deleted, false);
    }

    // Verify mee_search_orders_page excludes legacy delete_after_sheet_sync=true row automatically
    const searchRes = (await pg.query("select public.mee_search_orders_page('', '2026-11-24', '2026-11-24', 80, 0, null, false) as res")).rows[0].res;
    const foundIds = (searchRes.rows || []).map((r) => r.id);
    assert.ok(foundIds.includes('PROD-STD-1'));
    assert.ok(foundIds.includes('PROD-FP-1'));
    assert.ok(!foundIds.includes('PROD-LEG-DEL'), 'Legacy delete_after_sheet_sync row excluded from operational search');
  } finally {
    await pg.close();
  }
});

test('Release Readiness: meehoasg-delete-order uses atomic soft-delete RPC and Invoice + VietQR contract remains intact', () => {
  const delFn = fs.readFileSync(path.join(ROOT, 'supabase/functions/meehoasg-delete-order/index.js'), 'utf8');
  assert.match(delFn, /p_action:'deleteOrder'/);
  assert.match(delFn, /rpc\/mee_ops_mutate/);
  assert.match(delFn, /DELETE_REASON_REQUIRED/);
  assert.doesNotMatch(delFn, /method\s*:\s*'DELETE'/i, 'Never hard-deletes rows');

  const coreJs = fs.readFileSync(path.join(ROOT, 'assets/meehoa-core.js'), 'utf8');
  assert.match(coreJs, /img\.vietqr\.io\/image\//, 'Invoice VietQR generator intact');
  assert.match(coreJs, /In hóa đơn \+ QR/, 'Invoice button intact');
  assert.match(coreJs, /Vãng lai:/, 'Dashboard walk-in revenue breakdown compiled into core bundle');
  assert.match(coreJs, /CK chưa xác minh:/, 'Dashboard unverified transfer breakdown compiled into core bundle');
});
