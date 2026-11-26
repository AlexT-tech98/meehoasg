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
const { ALLOWED_GOLIVE_TEST_OBJECTS, runCleanup } = require(path.join(ROOT, 'scripts/r2-cleanup-golive-test-objects.cjs'));

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
  let capturedUpload = null;
  let capturedDiscard = null;
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
    createOperationService: ({ uploadImages, discardImages }) => {
      capturedUpload = uploadImages;
      capturedDiscard = discardImages;
      return {
        run: async (action, body) => {
          if (action === 'submitSettlement') {
            const urls = await uploadImages(body.billFiles, 'settlement-bills');
            return { ...opResult, billUrls: urls };
          }
          return opResult;
        },
      };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { handler, ctx, getUpload: () => capturedUpload, getDiscard: () => capturedDiscard, supabaseUploads };
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
    R2_MEDIA_BUCKET: 'meehoasg-media',
  };

  // 1. Production with R2 configured -> writes to R2, never Supabase Storage
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
      if (s.includes('/rest/v1/app_sessions')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', expires_at: new Date(Date.now() + 60000).toISOString() }]) };
      }
      if (s.includes('/rest/v1/app_users')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', role: 'SALE', active: true }]) };
      }
      if (s.startsWith('https://r2.example.test/')) {
        r2Puts.push({ url: s, method: opts.method });
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected fetch to ${s}`);
    },
  });

  assert.equal(okBoot.ctx.r2WriteEnabled(), true);
  assert.equal(okBoot.ctx.r2BackupEnabled(), false);
  const res1 = await okBoot.handler({
    method: 'POST',
    headers: { get: () => 'https://ops.meehoasg.com' },
    text: async () => JSON.stringify({
      token: validToken,
      action: 'submitSettlement',
      orderId: 'MEE-1',
      billFiles: [{ data: SAMPLE_DATA_URL }],
    }),
  });
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.equal(body1.billUrls.length, 1);
  assert.match(body1.billUrls[0], /^r2:\/\/meehoasg-media\/settlement-bills\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(r2Puts.length, 1);
  assert.equal(okBoot.supabaseUploads.length, 0, 'Must NEVER write to Supabase Storage when R2 is active');

  // 2. Production with R2 PUT error -> fails closed with R2_UPLOAD_FAILED, discards partial R2 uploads, NEVER falls back to Supabase
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
    text: async () => JSON.stringify({
      token: validToken,
      action: 'submitSettlement',
      orderId: 'MEE-1',
      billFiles: [{ data: SAMPLE_DATA_URL }],
    }),
  });
  const body2 = await res2.json();
  assert.equal(body2.ok, false);
  assert.equal(body2.code, 'R2_UPLOAD_FAILED');
  assert.equal(failBoot.supabaseUploads.length, 0, 'R2 upload failure must NEVER auto-fallback to Supabase Storage');
  assert.equal(r2Discards.length, 1, 'Failed R2 batch must discard partial R2 references');

  // 3. Production WITHOUT R2 keys -> fails closed with R2_NOT_CONFIGURED
  const noKeyBoot = bootOrderActions({
    env: { SUPABASE_URL: prodEnv.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'svc-key' },
    r2MediaFactory: () => { throw new Error('Should not be called without access key'); },
    fetcher: async (url) => {
      const s = String(url);
      if (s.includes('/rest/v1/app_sessions')) return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', expires_at: new Date(Date.now() + 60000).toISOString() }]) };
      if (s.includes('/rest/v1/app_users')) return { ok: true, status: 200, text: async () => JSON.stringify([{ username: 'sale1', role: 'SALE', active: true }]) };
      throw new Error(`Unexpected fetch to ${s}`);
    },
  });
  assert.equal(noKeyBoot.ctx.r2WriteEnabled(), true);
  const res3 = await noKeyBoot.handler({
    method: 'POST',
    headers: { get: () => 'https://ops.meehoasg.com' },
    text: async () => JSON.stringify({
      token: validToken,
      action: 'submitSettlement',
      orderId: 'MEE-1',
      billFiles: [{ data: SAMPLE_DATA_URL }],
    }),
  });
  const body3 = await res3.json();
  assert.equal(body3.ok, false);
  assert.equal(body3.code, 'R2_NOT_CONFIGURED');
  assert.equal(noKeyBoot.supabaseUploads.length, 0);

  // 4. Loopback QA without R2 keys -> allowed to use local disposable storage
  const localBoot = bootOrderActions({
    env: { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' },
    r2MediaFactory: () => null,
    fetcher: async () => ({ ok: true, status: 200, text: async () => '[]' }),
  });
  assert.equal(localBoot.ctx.r2WriteEnabled(), false);
});

test('Group 2B: legacy settlement bills batch migration, SHA-256 verify, DB reference switch, and safe rollback', async () => {
  // 1. Verify meehoasg-r2-copy supports explicit keys batch + SHA-256 readback verification
  const r2CopySrc = fs.readFileSync(R2_COPY_PATH, 'utf8');
  assert.match(r2CopySrc, /Array\.isArray\(input\?\.keys\)/);
  assert.match(r2CopySrc, /R2_HASH_MISMATCH/);

  // 2. Verify migrate-settlement-bills-to-r2.cjs extraction and batch execution
  const key1 = '11111111-1111-4111-8111-111111111111.jpg';
  const key2 = '22222222-2222-4222-8222-222222222222.png';
  const mockRows = [
    { id: 'SET-1', order_id: 'MEE-1', status: 'APPROVED', submitted_at: '2026-10-05T00:00:00Z', bill_urls: [`supabase://settlement-bills/${key1}`, 'https://drive.google.com/file/d/legacy'] },
    { id: 'SET-2', order_id: 'MEE-2', status: 'PENDING', submitted_at: '2026-11-10T00:00:00Z', bill_urls: [`supabase://settlement-bills/${key1}`, `supabase://settlement-bills/${key2}`] },
    { id: 'SET-3', order_id: 'MEE-3', status: 'APPROVED', submitted_at: '2026-11-26T10:00:00Z', bill_urls: ['r2://meehoasg-media/settlement-bills/33333333-3333-4333-8333-333333333333.jpg'] },
  ];
  const plan = extractLegacySettlementBillKeys(mockRows);
  assert.deepEqual(plan.keys, [key1, key2]);
  assert.equal(plan.affectedRows, 2);

  const batchesCalled = [];
  const migRes = await runMigration({
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    copyApiKey: 'secret-copy',
    mode: 'copy',
    batchSize: 1,
    r2Bucket: 'meehoasg-media',
    fetcher: async (url, opts = {}) => {
      const s = String(url);
      if (s.includes('/rest/v1/settlement_requests')) return { ok: true, status: 200, json: async () => mockRows };
      if (s.includes('/functions/v1/meehoasg-r2-copy')) {
        const body = JSON.parse(opts.body);
        batchesCalled.push(body);
        return { ok: true, status: 200, json: async () => ({ ok: true, verifiedKeys: body.keys, copied: body.keys.length, bytes: 1024 }) };
      }
      throw new Error(`Unexpected URL ${s}`);
    },
  });
  assert.equal(migRes.ok, true);
  assert.equal(migRes.batchesRun, 2);
  assert.equal(migRes.copiedCount, 2);
  assert.equal(migRes.supabaseOriginalsDeleted, false);
  assert.deepEqual(batchesCalled.map((b) => b.keys), [[key1], [key2]]);

  // 3. PGlite rehearsal of DB switch SQL & rollback SQL
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
      insert into public.orders(id, order_date, customer, flower) values ('MEE-1','2026-10-05','A','Hoa'),('MEE-2','2026-11-10','B','Hoa');
      insert into public.settlement_requests(id, order_id, sale_username, sale_name, bill_urls, status) values
        ('SET-1','MEE-1','sale1','Sale 1','["supabase://settlement-bills/${key1}","https://drive.google.com/legacy"]'::jsonb,'APPROVED'),
        ('SET-2','MEE-2','sale1','Sale 1','["supabase://settlement-bills/${key1}","supabase://settlement-bills/${key2}"]'::jsonb,'PENDING');
    `);

    // Only verify key1 first -> key2 MUST NOT be switched!
    await pg.query("select set_config('app.r2_bucket', 'meehoasg-website-media', false)");
    await pg.query("select set_config('app.verified_settlement_bill_keys', $1, false)", [JSON.stringify([key1])]);
    await pg.exec(fs.readFileSync(SWITCH_SQL_PATH, 'utf8'));

    const afterSwitch = await pg.query('select id, bill_urls from public.settlement_requests order by id');
    assert.deepEqual(afterSwitch.rows[0].bill_urls, [`r2://meehoasg-website-media/settlement-bills/${key1}`, 'https://drive.google.com/legacy']);
    assert.deepEqual(afterSwitch.rows[1].bill_urls, [`r2://meehoasg-website-media/settlement-bills/${key1}`, `supabase://settlement-bills/${key2}`]);

    // Rollback restores original supabase:// URLs cleanly
    await pg.exec(fs.readFileSync(ROLLBACK_SQL_PATH, 'utf8'));
    const afterRb = await pg.query('select id, bill_urls from public.settlement_requests order by id');
    assert.deepEqual(afterRb.rows[0].bill_urls, [`supabase://settlement-bills/${key1}`, 'https://drive.google.com/legacy']);
    assert.deepEqual(afterRb.rows[1].bill_urls, [`supabase://settlement-bills/${key1}`, `supabase://settlement-bills/${key2}`]);
  } finally {
    await pg.close();
  }
});

test('Group 2C: Go-Live R2 test-object cleanup enforces strict allow-list and zero-DB-reference guard', async () => {
  assert.equal(ALLOWED_GOLIVE_TEST_OBJECTS.length, 6);
  // Ensure trashed order MEE-4CEA187B770C469B image is NEVER in allow-list
  assert.equal(ALLOWED_GOLIVE_TEST_OBJECTS.some((k) => k.includes('efe981ed')), false);

  const deleted = [];
  const fakeR2 = {
    exists: async (k) => !deleted.includes(k),
    reference: (k) => `r2://meehoasg-media/${k}`,
    discard: async (ref) => { deleted.push(ref.replace('r2://meehoasg-media/', '')); },
  };

  // 1. Unknown key blocked even with execute: true
  const blocked = await runCleanup({
    keys: ['order-images/efe981ed-1111-2222-3333-444444444444.jpg'],
    execute: true,
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    r2Media: fakeR2,
    fetcher: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockedCount, 1);
  assert.equal(blocked.items[0].status, 'BLOCKED_NOT_IN_ALLOWLIST');
  assert.equal(deleted.length, 0);

  // 2. Referenced allow-listed key blocked even with execute: true
  const refBlocked = await runCleanup({
    keys: [ALLOWED_GOLIVE_TEST_OBJECTS[0]],
    execute: true,
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    r2Media: fakeR2,
    fetcher: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/rest/v1/orders') ? [{ id: 'MEE-REF' }] : []),
    }),
  });
  assert.equal(refBlocked.ok, false);
  assert.equal(refBlocked.items[0].status, 'BLOCKED_REFERENCED_IN_DB');
  assert.equal(deleted.length, 0);

  // 3. Dry-run never deletes
  const dry = await runCleanup({
    execute: false,
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    r2Media: fakeR2,
    fetcher: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.deletedCount, 0);
  assert.equal(deleted.length, 0);

  // 4. Execute deletes ONLY the 6 verified zero-ref allow-listed objects
  const execRes = await runCleanup({
    execute: true,
    supabaseUrl: 'https://proj.supabase.co',
    serviceKey: 'svc',
    r2Media: fakeR2,
    fetcher: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  assert.equal(execRes.ok, true);
  assert.equal(execRes.deletedCount, 6);
  assert.equal(deleted.length, 6);
});
