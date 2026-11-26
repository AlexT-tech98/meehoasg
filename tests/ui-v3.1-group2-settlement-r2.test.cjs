'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const ORDER_ACTIONS_PATH = path.join(ROOT, 'supabase/functions/meehoasg-order-actions/index.ts');
const R2_COPY_PATH = path.join(ROOT, 'supabase/functions/meehoasg-r2-copy/index.js');
const SWITCH_SQL_PATH = path.join(ROOT, 'scripts/legacy-settlement-bills-r2-switch.sql');
const ROLLBACK_SQL_PATH = path.join(ROOT, 'scripts/legacy-settlement-bills-r2-rollback.sql');

const { extractLegacySettlementBillKeys, runMigration } = require(path.join(ROOT, 'scripts/migrate-settlement-bills-to-r2.cjs'));
const { ALLOWED_GOLIVE_TEST_OBJECTS, countReferencesInDb, runCleanup } = require(path.join(ROOT, 'scripts/r2-cleanup-golive-test-objects.cjs'));

const ONE_PIXEL_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
const SAMPLE_DATA_URL = `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`;

function stripTsOrderActions(src) {
  return src
    .replace(/^import .*$/gm, '')
    .replace(/Deno\.env\.get\(([^)]+)\)!/g, 'Deno.env.get($1)')
    .replace(/\(v:unknown\)/g, '(v)')
    .replace(/\(text:string\)/g, '(text)')
    .replace(/\(prefix:string\)/g, '(prefix)')
    .replace(/\(table:string,query:Record<string,string>=\{\},method='GET',body\?:unknown\)/g, "(table,query={},method='GET',body)")
    .replace(/\(table:string,query:Record<string,string>\)/g, '(table,query)')
    .replace(/\(raw:string\)/g, '(raw)')
    .replace(/\(urls:string\[\]\)/g, '(urls)')
    .replace(/\(files:Array<\{data\?:string\}>,bucket:string\)/g, '(files,bucket)')
    .replace(/const uploaded:string\[\]=\[\];/g, 'const uploaded=[];')
    .replace(/ as PromiseRejectedResult\|undefined/g, '')
    .replace(/\(e as Error\)/g, 'e');
}

function bootOrderActions({ env, fetcher, r2MediaFactory, opResult = { ok: true, id: 'SET-1' } }) {
  const src = stripTsOrderActions(fs.readFileSync(ORDER_ACTIONS_PATH, 'utf8'));
  let handler = null;
  const supabaseUploads = [];
  const ctx = {
    Deno: {
      env: { get: (k) => env[k] || '' },
      serve: (fn) => { handler = fn; },
    },
    crypto: crypto.webcrypto,
    URL,
    TextEncoder,
    Uint8Array,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Response: class MockResponse {
      constructor(body, init = {}) {
        this.body = body;
        this.status = init.status || 200;
        this.headers = init.headers || {};
      }
      async json() { return JSON.parse(this.body); }
    },
    console: { error: () => {}, log: () => {} },
    fetch: fetcher,
    createR2Media: r2MediaFactory,
    createOperationStorage: () => ({
      uploadImages: async (files, bucket) => {
        supabaseUploads.push({ count: files.length, bucket });
        return files.map(() => `supabase://${bucket}/${crypto.randomUUID()}.jpg`);
      },
      discard: async () => {},
    }),
    createOperationService: ({ uploadImages }) => ({
      run: async (action, body) => {
        if (action === 'submitSettlement') {
          const urls = await uploadImages(body.billFiles, 'settlement-bills');
          return { ...opResult, billUrls: urls };
        }
        return opResult;
      },
    }),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { handler, ctx, supabaseUploads };
}

test('Group 2A: meehoasg-order-actions writes settlement bills ONLY to Permanent R2 on Production (fail-closed, zero Supabase fallback)', async () => {
  const r2Puts = [];
  const r2Discards = [];
  const validToken = 'a'.repeat(64);
  const prodEnv = {
    SUPABASE_URL: 'https://zxnfhshnavbmvdthrmrd.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_ACCESS_KEY_ID: 'r2-ak',
    R2_SECRET_ACCESS_KEY: 'r2-sk',
    R2_MEDIA_BUCKET: 'meehoasg-website-media',
  };

  const okBoot = bootOrderActions({
    env: prodEnv,
    r2MediaFactory: ({ bucket }) => ({
      key: (kind, p) => `${kind === 'bill' ? 'settlement-bills' : 'order-images'}/${p}`,
      reference: (k) => `r2://${bucket}/${k}`,
      signedUrl: async (method, k) => `https://r2.example.test/${bucket}/${k}?method=${method}`,
      discard: async (ref) => { r2Discards.push(ref); },
    }),
    fetcher: async (url, opts = {}) => {
      const s = String(url);
      if (s.includes('/rest/v1/app_sessions')) return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', expires_at: new Date(Date.now() + 60000).toISOString() }]) };
      if (s.includes('/rest/v1/app_users')) return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', role: 'SALE', active: true }]) };
      if (s.startsWith('https://r2.example.test/')) { r2Puts.push({ url: s, method: opts.method }); return { ok: true, status: 200 }; }
      throw new Error(`Unexpected fetch to ${s}`);
    },
  });

  assert.equal(okBoot.ctx.r2WriteEnabled(), true);
  assert.equal(okBoot.ctx.r2BackupEnabled(), false);
  const res1 = await okBoot.handler({
    method: 'POST',
    headers: { get: () => 'https://ops.meehoasg.com' },
    text: async () => JSON.stringify({ token: validToken, action: 'submitSettlement', orderId: 'MEE-1', billFiles: [{ data: SAMPLE_DATA_URL }] }),
  });
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.match(body1.billUrls[0], /^r2:\/\/meehoasg-website-media\/settlement-bills\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(r2Puts.length, 1);
  assert.equal(okBoot.supabaseUploads.length, 0);

  // R2 PUT failure -> fail-closed R2_UPLOAD_FAILED + discard
  const failBoot = bootOrderActions({
    env: prodEnv,
    r2MediaFactory: ({ bucket }) => ({
      key: (kind, p) => `${kind === 'bill' ? 'settlement-bills' : 'order-images'}/${p}`,
      reference: (k) => `r2://${bucket}/${k}`,
      signedUrl: async (_m, k) => `https://r2.example.test/${bucket}/${k}`,
      discard: async (ref) => { r2Discards.push(ref); },
    }),
    fetcher: async (url) => {
      const s = String(url);
      if (s.includes('/rest/v1/app_sessions')) return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', expires_at: new Date(Date.now() + 60000).toISOString() }]) };
      if (s.includes('/rest/v1/app_users')) return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', role: 'SALE', active: true }]) };
      if (s.startsWith('https://r2.example.test/')) return { ok: false, status: 503 };
      throw new Error(`Unexpected fetch to ${s}`);
    },
  });
  const res2 = await failBoot.handler({
    method: 'POST',
    headers: { get: () => 'https://ops.meehoasg.com' },
    text: async () => JSON.stringify({ token: validToken, action: 'submitSettlement', orderId: 'MEE-1', billFiles: [{ data: SAMPLE_DATA_URL }] }),
  });
  const body2 = await res2.json();
  assert.equal(body2.ok, false);
  assert.equal(body2.code, 'R2_UPLOAD_FAILED');
  assert.equal(failBoot.supabaseUploads.length, 0);
  assert.equal(r2Discards.length, 1);

  // Missing R2 keys on Production -> R2_NOT_CONFIGURED
  const noKeyBoot = bootOrderActions({
    env: { SUPABASE_URL: prodEnv.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'svc-key' },
    r2MediaFactory: () => { throw new Error('Should not be called'); },
    fetcher: async (url) => {
      const s = String(url);
      if (s.includes('/rest/v1/app_sessions')) return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', expires_at: new Date(Date.now() + 60000).toISOString() }]) };
      if (s.includes('/rest/v1/app_users')) return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', role: 'SALE', active: true }]) };
      throw new Error(`Unexpected fetch to ${s}`);
    },
  });
  const res3 = await noKeyBoot.handler({
    method: 'POST',
    headers: { get: () => 'https://ops.meehoasg.com' },
    text: async () => JSON.stringify({ token: validToken, action: 'submitSettlement', orderId: 'MEE-1', billFiles: [{ data: SAMPLE_DATA_URL }] }),
  });
  assert.equal((await res3.json()).code, 'R2_NOT_CONFIGURED');
});

test('Group 2B: dual-source 919 bills migration (settlement_requests + orders.full_paid_bill_urls), queued-delete trigger compat, and rollback', async () => {
  const r2CopySrc = fs.readFileSync(R2_COPY_PATH, 'utf8');
  assert.match(r2CopySrc, /Array\.isArray\(input\?\.keys\)/);
  assert.match(r2CopySrc, /R2_HASH_MISMATCH/);

  const srKey1 = '11111111-1111-4111-8111-111111111111.jpg';
  const srKey2 = '22222222-2222-4222-8222-222222222222.png';
  const fpKey1 = '44444444-4444-4444-8444-444444444444.jpg';
  const fpKeyQueued = '55555555-5555-4555-8555-555555555555.jpg';

  const mockSrRows = [
    { id: 'SET-1', order_id: 'MEE-1', status: 'APPROVED', submitted_at: '2026-10-05T00:00:00Z', bill_urls: [`supabase://settlement-bills/${srKey1}`, 'https://drive.google.com/legacy'] },
    { id: 'SET-2', order_id: 'MEE-2', status: 'PENDING', submitted_at: '2026-11-10T00:00:00Z', bill_urls: [`supabase://settlement-bills/${srKey1}`, `supabase://settlement-bills/${srKey2}`] },
  ];
  const mockFpOrders = [
    { id: 'MEE-FP-1', full_paid: true, is_deleted: false, delete_after_sheet_sync: false, full_paid_bill_urls: [`supabase://settlement-bills/${fpKey1}`, 'r2://meehoasg-website-media/settlement-bills/66666666-6666-4666-8666-666666666666.jpg'] },
    { id: 'MEE-FP-QUEUED', full_paid: true, is_deleted: true, delete_after_sheet_sync: true, full_paid_bill_urls: [`supabase://settlement-bills/${fpKeyQueued}`] },
  ];

  const plan = extractLegacySettlementBillKeys(mockSrRows, mockFpOrders, 'all');
  assert.equal(plan.distinctSettlementRequestBills || plan.srKeys.length, 2);
  assert.equal(plan.fpKeys.length, 2);
  assert.equal(plan.overlapCount, 0);
  assert.deepEqual(plan.keys, [srKey1, srKey2, fpKey1, fpKeyQueued]);

  const migRes = await runMigration({
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    copyApiKey: 'secret-copy',
    mode: 'copy',
    scope: 'all',
    batchSize: 2,
    r2Bucket: 'meehoasg-website-media',
    fetcher: async (url, opts = {}) => {
      const s = String(url);
      if (s.includes('/rest/v1/settlement_requests')) return { ok: true, status: 200, json: async () => mockSrRows };
      if (s.includes('/rest/v1/orders')) return { ok: true, status: 200, json: async () => mockFpOrders };
      if (s.includes('/functions/v1/meehoasg-r2-copy')) {
        const body = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ ok: true, verifiedKeys: body.keys, copied: 1, bytes: 2048 }) };
      }
      throw new Error(`Unexpected URL ${s}`);
    },
  });
  assert.equal(migRes.ok, true);
  assert.equal(migRes.distinctLegacyBills, 4);
  assert.equal(migRes.batchesRun, 2);
  assert.equal(migRes.supabaseOriginalsDeleted, false);

  // PGlite rehearsal of BOTH settlement_requests AND orders.full_paid_bill_urls (including delete_after_sheet_sync=true!)
  const pg = new PGlite();
  try {
    await pg.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);
    `);
    await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    const dir = path.join(ROOT, 'supabase/migrations');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await pg.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
    await pg.exec(`
      insert into public.orders(id, order_date, customer, flower, flower_total, full_paid, full_paid_total, full_paid_bill_urls, is_deleted, delete_after_sheet_sync) values
        ('MEE-1','2026-10-05','A','Hoa',300000,false,0,'[]'::jsonb,false,false),
        ('MEE-2','2026-11-10','B','Hoa',400000,false,0,'[]'::jsonb,false,false),
        ('MEE-FP-1','2026-10-12','C','Hoa',500000,true,500000,'["supabase://settlement-bills/${fpKey1}"]'::jsonb,false,false),
        ('MEE-FP-QUEUED','2026-10-15','D','Hoa',600000,true,600000,'["supabase://settlement-bills/${fpKeyQueued}"]'::jsonb,true,true);
      insert into public.settlement_requests(id, order_id, sale_username, sale_name, bill_urls, status) values
        ('SET-1','MEE-1','sale1','Sale 1','["supabase://settlement-bills/${srKey1}","https://drive.google.com/legacy"]'::jsonb,'APPROVED'),
        ('SET-2','MEE-2','sale1','Sale 1','["supabase://settlement-bills/${srKey1}","supabase://settlement-bills/${srKey2}"]'::jsonb,'PENDING'),
        ('SET-3','MEE-2','sale1','Sale 1','["supabase://settlement-bills/${srKey1}"]'::jsonb,'REJECTED');
    `);

    // Verify unauthorized mutation of bills on queued-delete order STILL throws ORDER_DELETING!
    await assert.rejects(
      () => pg.query(`update public.orders set full_paid_bill_urls = '[]'::jsonb where id = 'MEE-FP-QUEUED'`),
      /ORDER_DELETING/
    );

    // Batch 1: switch verified keys (srKey1, fpKey1, fpKeyQueued — leaving srKey2 unverified!)
    await pg.query("select set_config('app.r2_bucket', 'meehoasg-website-media', false)");
    await pg.query("select set_config('app.verified_settlement_bill_keys', $1, false)", [JSON.stringify([srKey1, fpKey1, fpKeyQueued])]);
    await pg.exec(fs.readFileSync(SWITCH_SQL_PATH, 'utf8'));

    const afterSr1 = await pg.query('select id, bill_urls from public.settlement_requests order by id');
    assert.deepEqual(afterSr1.rows[0].bill_urls, [`r2://meehoasg-website-media/settlement-bills/${srKey1}`, 'https://drive.google.com/legacy']);
    assert.deepEqual(afterSr1.rows[1].bill_urls, [`r2://meehoasg-website-media/settlement-bills/${srKey1}`, `supabase://settlement-bills/${srKey2}`]);
    assert.deepEqual(afterSr1.rows[2].bill_urls, [`r2://meehoasg-website-media/settlement-bills/${srKey1}`]);

    const afterFp = await pg.query("select id, full_paid, full_paid_bill_urls from public.orders where id in ('MEE-FP-1','MEE-FP-QUEUED') order by id");
    assert.equal(afterFp.rows[0].full_paid, true);
    assert.deepEqual(afterFp.rows[0].full_paid_bill_urls, [`r2://meehoasg-website-media/settlement-bills/${fpKey1}`]);
    assert.equal(afterFp.rows[1].full_paid, true);
    assert.deepEqual(afterFp.rows[1].full_paid_bill_urls, [`r2://meehoasg-website-media/settlement-bills/${fpKeyQueued}`]);

    // Batch 2: switch remaining key [srKey2] on multi-bill row SET-2; backup MUST preserve original supabase:// array!
    await pg.query("select set_config('app.verified_settlement_bill_keys', $1, false)", [JSON.stringify([srKey2])]);
    await pg.exec(fs.readFileSync(SWITCH_SQL_PATH, 'utf8'));

    const afterSr2 = await pg.query("select id, bill_urls from public.settlement_requests where id = 'SET-2'");
    assert.deepEqual(afterSr2.rows[0].bill_urls, [
      `r2://meehoasg-website-media/settlement-bills/${srKey1}`,
      `r2://meehoasg-website-media/settlement-bills/${srKey2}`,
    ]);
    const set2Backup = await pg.query("select orig_bill_urls, new_bill_urls from public.legacy_settlement_bills_r2_backup where settlement_id = 'SET-2'");
    assert.deepEqual(set2Backup.rows[0].orig_bill_urls, [
      `supabase://settlement-bills/${srKey1}`,
      `supabase://settlement-bills/${srKey2}`,
    ]);
    assert.deepEqual(set2Backup.rows[0].new_bill_urls, [
      `r2://meehoasg-website-media/settlement-bills/${srKey1}`,
      `r2://meehoasg-website-media/settlement-bills/${srKey2}`,
    ]);

    // Post-switch manual edit protection: simulate manual edit on SET-3 -> rollback must NOT overwrite it
    await pg.query(`update public.settlement_requests set bill_urls = '["https://drive.google.com/manual-override"]'::jsonb where id = 'SET-3'`);

    // Per-batch rollback: set app.rollback_settlement_bill_keys to [fpKeyQueued] -> ONLY MEE-FP-QUEUED reverts
    await pg.query("select set_config('app.rollback_settlement_bill_keys', $1, false)", [JSON.stringify([fpKeyQueued])]);
    await pg.exec(fs.readFileSync(ROLLBACK_SQL_PATH, 'utf8'));

    const afterBatchRbFp = await pg.query("select id, full_paid_bill_urls from public.orders where id in ('MEE-FP-1','MEE-FP-QUEUED') order by id");
    assert.deepEqual(afterBatchRbFp.rows[0].full_paid_bill_urls, [`r2://meehoasg-website-media/settlement-bills/${fpKey1}`]);
    assert.deepEqual(afterBatchRbFp.rows[1].full_paid_bill_urls, [`supabase://settlement-bills/${fpKeyQueued}`]);
    const afterBatchRbSr = await pg.query('select id, bill_urls from public.settlement_requests order by id');
    assert.deepEqual(afterBatchRbSr.rows[0].bill_urls, [`r2://meehoasg-website-media/settlement-bills/${srKey1}`, 'https://drive.google.com/legacy']);
    assert.deepEqual(afterBatchRbSr.rows[1].bill_urls, [`r2://meehoasg-website-media/settlement-bills/${srKey1}`, `r2://meehoasg-website-media/settlement-bills/${srKey2}`]);
    assert.deepEqual(afterBatchRbSr.rows[2].bill_urls, ['https://drive.google.com/manual-override']);
    const fpBackupRemaining = await pg.query('select order_id from public.legacy_full_paid_bills_r2_backup order by order_id');
    assert.deepEqual(fpBackupRemaining.rows.map((r) => r.order_id), ['MEE-FP-1']);

    // Full rollback: clear app.rollback_settlement_bill_keys -> SET-1, SET-2 (both bills!), and MEE-FP-1 revert & clean backups; SET-3 stays protected
    await pg.query("select set_config('app.rollback_settlement_bill_keys', '', false)");
    await pg.exec(fs.readFileSync(ROLLBACK_SQL_PATH, 'utf8'));

    const finalSr = await pg.query('select id, bill_urls from public.settlement_requests order by id');
    assert.deepEqual(finalSr.rows[0].bill_urls, [`supabase://settlement-bills/${srKey1}`, 'https://drive.google.com/legacy']);
    assert.deepEqual(finalSr.rows[1].bill_urls, [`supabase://settlement-bills/${srKey1}`, `supabase://settlement-bills/${srKey2}`]);
    assert.deepEqual(finalSr.rows[2].bill_urls, ['https://drive.google.com/manual-override']);

    const finalFp = await pg.query("select id, full_paid_bill_urls from public.orders where id in ('MEE-FP-1','MEE-FP-QUEUED') order by id");
    assert.deepEqual(finalFp.rows[0].full_paid_bill_urls, [`supabase://settlement-bills/${fpKey1}`]);
    assert.deepEqual(finalFp.rows[1].full_paid_bill_urls, [`supabase://settlement-bills/${fpKeyQueued}`]);

    const remSrBackup = await pg.query('select settlement_id from public.legacy_settlement_bills_r2_backup order by settlement_id');
    assert.deepEqual(remSrBackup.rows.map((r) => r.settlement_id), ['SET-3']);
    const remFpBackup = await pg.query('select count(*)::int as c from public.legacy_full_paid_bills_r2_backup');
    assert.equal(remFpBackup.rows[0].c, 0);
  } finally {
    await pg.close();
  }
});

test('Group 2C: Go-Live R2 cleanup checks real schema (before_data, after_data, order_snapshot, operation_receipts) and deletes only the 4 remaining QA objects', async () => {
  assert.equal(ALLOWED_GOLIVE_TEST_OBJECTS.length, 7);
  assert.equal(ALLOWED_GOLIVE_TEST_OBJECTS.includes('settlement-bills/2d44d3e7-d82f-4f2b-90b7-4e56d815a74a.jpg'), true);
  assert.equal(ALLOWED_GOLIVE_TEST_OBJECTS.some((k) => k.includes('efe981ed')), false);

  const fourRemainingQaKeys = new Set([
    'order-images/c0dbba8c-8556-4c8e-a876-1a8d2d0123b5.jpg',
    'order-images/c0dbba8c-8556-4c8e-a876-1a8d2d0123b5.preview.jpg',
    'settlement-bills/ebb0c8f9-6cb0-4a91-b451-857338a12a82.jpg',
    'settlement-bills/2d44d3e7-d82f-4f2b-90b7-4e56d815a74a.jpg',
  ]);
  const existingInR2 = new Set(fourRemainingQaKeys);
  const fakeR2 = {
    exists: async (k) => existingInR2.has(k),
    reference: (k) => `r2://meehoasg-website-media/${k}`,
    discard: async (ref) => { existingInR2.delete(ref.replace('r2://meehoasg-website-media/', '')); },
  };

  // Verify exact column names queried (NEVER queries non-existent activity_log.detail!)
  const seenPaths = [];
  const resPurgedReceipt = await countReferencesInDb({
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    objectKey: ALLOWED_GOLIVE_TEST_OBJECTS[6],
    fetcher: async (url) => {
      const s = String(url);
      seenPaths.push(s);
      assert.doesNotMatch(s, /detail=/, 'Must NEVER query non-existent activity_log.detail column');
      if (s.includes('/operation_receipts?')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ actor: 'admin', request_id: 'r1', action: 'submitSettlement', result: { orderId: 'MEE-V31QA-290B49D7' } }],
        };
      }
      // Order MEE-V31QA-290B49D7 is absent from orders -> historical purged test receipt!
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  assert.equal(resPurgedReceipt.referenced, false);
  assert.equal(resPurgedReceipt.historicalTestReceipts, 1);
  assert.deepEqual(resPurgedReceipt.historicalTestReceiptOrderIds, ['MEE-V31QA-290B49D7']);
  assert.ok(seenPaths.some((p) => p.includes('/order_deletion_history?') && p.includes('order_snapshot.cs.')));
  assert.ok(seenPaths.some((p) => p.includes('/activity_log?') && p.includes('before_data.cs.') && p.includes('after_data.cs.')));

  // Active or trashed order in operation_receipts / order_deletion_history / activity_log MUST block deletion!
  const resActiveReceipt = await countReferencesInDb({
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    objectKey: 'order-images/efe981ed-4afd-4a20-852b-e7b40c489031.preview.jpg',
    fetcher: async (url) => {
      const s = String(url);
      if (s.includes('/order_deletion_history?')) return { ok: true, status: 200, json: async () => [{ id: 1, order_id: 'MEE-4CEA187B770C469B' }] };
      if (s.includes('/activity_log?')) return { ok: true, status: 200, json: async () => [{ id: 10176, order_id: 'MEE-4CEA187B770C469B' }] };
      if (s.includes('/operation_receipts?')) return { ok: true, status: 200, json: async () => [{ actor: 'admin', request_id: 'r2', action: 'createOrder', result: { orderId: 'MEE-4CEA187B770C469B' } }] };
      if (s.includes('/orders?')) return { ok: true, status: 200, json: async () => [{ id: 'MEE-4CEA187B770C469B', is_deleted: true }] };
      return { ok: true, status: 200, json: async () => [] };
    },
  });
  assert.equal(resActiveReceipt.referenced, true);
  assert.deepEqual(resActiveReceipt.matchedTables, ['orders', 'order_deletion_history', 'activity_log', 'operation_receipts']);

  // Dry-run marks existing 4 QA objects DRY_RUN_ELIGIBLE and 3 absent objects ALREADY_ABSENT_IN_R2
  const dry = await runCleanup({
    execute: false,
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    r2Media: fakeR2,
    fetcher: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.deletedCount, 0);
  assert.equal(dry.items.filter((i) => i.status === 'DRY_RUN_ELIGIBLE').length, 4);
  assert.equal(dry.items.filter((i) => i.status === 'ALREADY_ABSENT_IN_R2').length, 3);
  assert.equal(existingInR2.size, 4);

  // Execute deletes ONLY the 4 remaining QA objects and confirms HEAD 404 (!exists)
  const exec = await runCleanup({
    execute: true,
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    r2Media: fakeR2,
    fetcher: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  assert.equal(exec.ok, true);
  assert.equal(exec.blockedCount, 0);
  assert.equal(exec.deletedCount, 4);
  assert.equal(exec.items.filter((i) => i.status === 'DELETED_AND_VERIFIED').length, 4);
  assert.equal(exec.items.filter((i) => i.status === 'ALREADY_ABSENT_IN_R2').length, 3);
  for (const k of fourRemainingQaKeys) {
    assert.equal(await fakeR2.exists(k), false, `Expected HEAD 404 after cleanup for ${k}`);
  }
});
