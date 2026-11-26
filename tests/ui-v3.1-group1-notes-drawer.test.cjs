'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'html');
const V3_CSS_PATH = path.join(ROOT, 'assets/meehoa-ui-v3.css');
const DRY_RUN_SQL = path.join(ROOT, 'scripts/legacy-note-to-tag-note-free-dry-run.sql');
const BACKFILL_SQL = path.join(ROOT, 'scripts/legacy-note-to-tag-note-free-backfill.sql');
const ROLLBACK_SQL = path.join(ROOT, 'scripts/legacy-note-to-tag-note-free-rollback.sql');

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
  const dir = path.join(ROOT, 'supabase/migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return pg;
}

test('Group 1A: legacy note -> tag_note_free dry-run, idempotent backfill, mid-string/deposit/Bsung guards, recovered S1/S2 notes, and safe rollback', async () => {
  const pg = await setupDb();
  try {
    await pg.exec(`
      insert into public.orders (
        id, order_date, customer, flower, note, tag_note_free, card, card_text, banner, banner_text,
        is_deleted, delete_after_sheet_sync, created_at, updated_at
      ) values
      -- 1. Eligible explicit note prefix (pre-Go-Live)
      ('MEE-LEG-EXPLICIT', '2026-11-20', 'Khách A', 'Bó hồng đỏ', 'Note: Chúc mừng sinh nhật em yêu', '', false, '', false, '', false, false, '2026-11-20T05:00:00Z', '2026-11-20T05:00:00Z'),
      -- 2. Eligible clean legacy greeting note (pre-Go-Live)
      ('MEE-LEG-CLEAN', '2026-11-22', 'Khách B', 'Giỏ hoa pastel', 'Happy Anniversary 3 Years', '', false, '', false, '', false, false, '2026-11-22T06:00:00Z', '2026-11-22T06:00:00Z'),
      -- 3. Recovered SAFE_AUTO_S1: blank / self-written tag note
      ('MEE-SAFE-S1', '2026-11-22', 'Khách S1', 'Bó cẩm tú cầu', 'Note trống tự ghi', '', false, '', false, '', false, false, '2026-11-22T07:00:00Z', '2026-11-22T07:00:00Z'),
      -- 4. Recovered SAFE_AUTO_S2: greeting with scholarship / @hihihaha / Tăng Quỳnh Giao / cứ gọi cho anh
      ('MEE-SAFE-S2', '2026-11-22', 'Khách S2', 'Bó hướng dương', 'Note: Congrats on the scholarship @hihihaha55_ chúc Tăng Quỳnh Giao, có gì cứ gọi cho anh nhé', '', false, '', false, '', false, false, '2026-11-22T08:00:00Z', '2026-11-22T08:00:00Z'),
      -- 5. Already has tag_note_free -> NEVER overwrite
      ('MEE-HAS-TAG', '2026-11-23', 'Khách C', 'Bó tulip', 'Ghi chú giữ nguyên', 'Tag cũ đã có sẵn', false, '', false, '', false, false, '2026-11-23T06:00:00Z', '2026-11-23T06:00:00Z'),
      -- 6. Post-Go-Live order -> NEVER touch
      ('MEE-POST-GOLIVE', '2026-11-26', 'Như Huỳnh', 'Bó sen đá', 'Giấy gói màu đen, tôn màu hoa', '', false, '', false, '', false, false, '2026-11-26T09:02:01Z', '2026-11-26T09:02:01Z'),
      -- 7. Deleted / audit stamp -> NEVER touch
      ('MEE-DELETED', '2026-11-18', 'Khách D', 'Bó cúc', 'Meehoa_Manage · 2026-11-19 · hủy đơn', '', false, '', false, '', true, false, '2026-11-18T04:00:00Z', '2026-11-18T04:00:00Z'),
      -- 8. Mid-string Card/Banner -> KEEP at note (protects 205 mid-string orders)
      ('MEE-CARD-MID', '2026-11-24', 'Khách E', 'Kệ khai trương', 'Lấy note: Happy Birthday Mami\nThiệp (có lấy): Để trống', '', true, 'Thiệp gốc', true, 'Banner gốc', false, false, '2026-11-24T04:00:00Z', '2026-11-24T04:00:00Z'),
      -- 9. Deferred placeholder "Bsung sau" -> KEEP at note (protects 32 orders)
      ('MEE-BSUNG-SAU', '2026-11-24', 'Khách BS', 'Bó hồng', 'Note: Bsung sau', '', false, '', false, '', false, false, '2026-11-24T05:00:00Z', '2026-11-24T05:00:00Z'),
      -- 10. Payment / deposit warning -> KEEP at note (protects 13 orders)
      ('MEE-DEPOSIT-WARN', '2026-11-24', 'Khách Cọc', 'Giỏ hoa', 'Sinh nhật vui vẻ Kem nhá\n\nbankfull toàn bộ đơn', '', false, '', false, '', false, false, '2026-11-24T06:00:00Z', '2026-11-24T06:00:00Z'),
      -- 11. Operational / packaging / pickup -> KEEP at note
      ('MEE-OPS-MIXED', '2026-11-25', 'Khách F', 'Giỏ hoa lớn', 'Đổi giấy gói hoa thành màu đen\nNote: Finally!', '', false, '', false, '', false, false, '2026-11-25T04:00:00Z', '2026-11-25T04:00:00Z');
    `);

    // 1. Dry-run executes read-only and classifies every row accurately
    const drySql = fs.readFileSync(DRY_RUN_SQL, 'utf8');
    const summaryQuery = drySql.split('-- QUERY 2:')[0];
    const summaryRes = await pg.query(summaryQuery);
    const s = summaryRes.rows[0];
    assert.equal(Number(s.total_orders_with_note), 11);
    assert.equal(Number(s.total_auto_migrate_eligible), 4);
    assert.equal(Number(s.keep_card_or_banner), 1);
    assert.equal(Number(s.keep_deferred_placeholder), 1);
    assert.equal(Number(s.keep_payment_or_deposit), 1);
    assert.equal(Number(s.keep_ops_or_mixed), 1);
    assert.equal(Number(s.total_kept_at_note), 4);
    assert.equal(Number(s.total_protected_skipped), 3);

    // 2. Execute backfill
    const backfillSql = fs.readFileSync(BACKFILL_SQL, 'utf8');
    await pg.exec(backfillSql);

    const after1 = await pg.query(`
      select id, note, tag_note_free, flower, card_text, banner_text
      from public.orders
      order by id
    `);
    const byId = Object.fromEntries(after1.rows.map((r) => [r.id, r]));

    // Migrated rows moved note -> tag_note_free and cleared note (no duplicate display)
    assert.equal(byId['MEE-LEG-EXPLICIT'].tag_note_free, 'Note: Chúc mừng sinh nhật em yêu');
    assert.equal(byId['MEE-LEG-EXPLICIT'].note, '');
    assert.equal(byId['MEE-LEG-CLEAN'].tag_note_free, 'Happy Anniversary 3 Years');
    assert.equal(byId['MEE-LEG-CLEAN'].note, '');
    assert.equal(byId['MEE-SAFE-S1'].tag_note_free, 'Note trống tự ghi');
    assert.equal(byId['MEE-SAFE-S1'].note, '');
    assert.match(byId['MEE-SAFE-S2'].tag_note_free, /scholarship/);
    assert.equal(byId['MEE-SAFE-S2'].note, '');

    // Kept-at-note & protected rows untouched
    assert.equal(byId['MEE-HAS-TAG'].note, 'Ghi chú giữ nguyên');
    assert.equal(byId['MEE-HAS-TAG'].tag_note_free, 'Tag cũ đã có sẵn');
    assert.equal(byId['MEE-POST-GOLIVE'].note, 'Giấy gói màu đen, tôn màu hoa');
    assert.equal(byId['MEE-POST-GOLIVE'].tag_note_free, '');
    assert.equal(byId['MEE-DELETED'].note, 'Meehoa_Manage · 2026-11-19 · hủy đơn');
    assert.equal(byId['MEE-CARD-MID'].note, 'Lấy note: Happy Birthday Mami\nThiệp (có lấy): Để trống');
    assert.equal(byId['MEE-CARD-MID'].tag_note_free, '');
    assert.equal(byId['MEE-CARD-MID'].card_text, 'Thiệp gốc');
    assert.equal(byId['MEE-BSUNG-SAU'].note, 'Note: Bsung sau');
    assert.equal(byId['MEE-BSUNG-SAU'].tag_note_free, '');
    assert.match(byId['MEE-DEPOSIT-WARN'].note, /bankfull/);
    assert.equal(byId['MEE-DEPOSIT-WARN'].tag_note_free, '');
    assert.match(byId['MEE-OPS-MIXED'].note, /Đổi giấy gói/);
    assert.equal(byId['MEE-OPS-MIXED'].tag_note_free, '');

    // 3. Re-run backfill -> strictly idempotent
    await pg.exec(backfillSql);
    const backup2 = await pg.query('select count(*)::int as c from public.legacy_note_migration_backup');
    assert.equal(backup2.rows[0].c, 4);

    // 4. Simulate post-migration manual edit; rollback must NOT overwrite user edit
    await pg.query(`update public.orders set tag_note_free = 'Admin sửa sau migration' where id = 'MEE-LEG-EXPLICIT'`);

    // 5. Execute rollback
    await pg.exec(fs.readFileSync(ROLLBACK_SQL, 'utf8'));
    const afterRollback = await pg.query('select id, note, tag_note_free from public.orders where id in ($1, $2) order by id', ['MEE-LEG-CLEAN', 'MEE-LEG-EXPLICIT']);
    const rbById = Object.fromEntries(afterRollback.rows.map((r) => [r.id, r]));
    assert.equal(rbById['MEE-LEG-CLEAN'].note, 'Happy Anniversary 3 Years');
    assert.equal(rbById['MEE-LEG-CLEAN'].tag_note_free, '');
    assert.equal(rbById['MEE-LEG-EXPLICIT'].tag_note_free, 'Admin sửa sau migration');
  } finally {
    await pg.close();
  }
});

test('Group 1B: Drawer polish keeps single Copy thông tin đơn hàng button, unified Address block, compact copy icon, and 0 !important in UI V3 CSS', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const v3Css = fs.readFileSync(V3_CSS_PATH, 'utf8');

  // 1. No redundant top copy buttons in quickBar
  const quickBarMatch = html.match(/var quickBar =[\s\S]*?var isWalkIn/);
  assert.ok(quickBarMatch, 'quickBar definition must exist in html');
  const quickBarSrc = quickBarMatch[0];
  assert.doesNotMatch(quickBarSrc, /Copy SĐT/);
  assert.doesNotMatch(quickBarSrc, /Copy địa chỉ/);
  assert.doesNotMatch(quickBarSrc, /Copy Tag/);
  assert.match(quickBarSrc, /Copy thông tin đơn hàng/);
  assert.equal((quickBarSrc.match(/mee3-quickbtn/g) || []).length, 1, 'quickBar must contain exactly one button');

  // 2. No "Chạm để copy" text anywhere in UI
  assert.doesNotMatch(html, /Chạm để copy/);
  assert.doesNotMatch(v3Css, /mee3-copy-hint/);

  // 3. Unified Address block matching Thiệp & Note (two lines: header + .mee3-note-text) + compact copy icon
  assert.match(html, /class="mee3-note-block mee3-addr-block mee3-copyable-block copyable"[^>]*data-mee-copy-address="1"/);
  assert.match(html, /<div class="mee3-note-block-head"><span>ĐỊA CHỈ GIAO HÀNG<\/span><span class="mee3-icon-copy" aria-hidden="true">/);
  assert.match(html, /<div class="mee3-note-text">' \+ multiline\(o\.address\) \+ '<\/div>/);

  // 4. Phone keeps click-to-copy with compact icon
  assert.match(html, /data-mee-copy-phone="1"[^>]*onclick="MEEOPS7\.copyOrderField\(\\'/);
  assert.match(html, /<span>Số điện thoại<\/span><span class="mee3-icon-copy" aria-hidden="true">/);

  // 5. CSS debt rule preserved: 0 !important in assets/meehoa-ui-v3.css
  const importantCount = (v3Css.match(/!important/g) || []).length;
  assert.equal(importantCount, 0, 'assets/meehoa-ui-v3.css must remain at 0 !important');
});
