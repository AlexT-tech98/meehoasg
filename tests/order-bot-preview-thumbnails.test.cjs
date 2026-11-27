'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const PROD_OPS_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-api-core';
const OWNER_ID = 5252724920;
const WEBHOOK_SECRET = 'thumb_fix_test_secret_64hex';
const VALID_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.thumbfix.sig';
const CMUI_SESSION = 'f'.repeat(64);
const SERVICE_KEY = 'test-service-role-key-for-hmac-proof';
const R2_BUCKET = 'meehoasg-website-media';

const sha256Hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function evidenceSignature(actor, requestId, bucket, filePath, expiresAt, storage = 'r2') {
  const parts = [actor, requestId, bucket, filePath, String(expiresAt)];
  if (storage === 'r2' || storage === 'r2-backup') parts.push(storage);
  return crypto.createHmac('sha256', `meehoa-upload-proof-v1:${SERVICE_KEY}`)
    .update(parts.join('|'))
    .digest('hex');
}

async function loadModules() {
  const [workerMod, opsClient, d1Store, supaOps] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/worker.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/ops-client.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/d1-store.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'supabase/functions/_shared/operations.js')).href)
  ]);
  return { workerMod, opsClient, d1Store, supaOps };
}

function createBotD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(ROOT, 'order-bot/cloudflare/schema.sql'), 'utf8'));
  return {
    _sqlite: sqlite,
    prepare(sql) {
      const bindStmt = (args = []) => ({
        bind: (...a) => bindStmt(a),
        first: async () => sqlite.prepare(sql).get(...args) || null,
        all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true }),
        run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes || 0) } })
      });
      return bindStmt([]);
    }
  };
}

function createMockR2() {
  const map = new Map();
  return {
    _map: map,
    async put(key, val, opts) {
      const bytes = val instanceof Uint8Array
        ? val
        : (val instanceof ArrayBuffer ? new Uint8Array(val) : new Uint8Array(Buffer.from(val)));
      map.set(key, { bytes, httpMetadata: opts?.httpMetadata || {} });
      return { key };
    },
    async get(key) {
      const item = map.get(key);
      if (!item) return null;
      return {
        key,
        body: item.bytes,
        httpMetadata: item.httpMetadata,
        async arrayBuffer() {
          return item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength);
        }
      };
    },
    async delete(key) {
      map.delete(key);
    }
  };
}

async function createPreMigrationOpsPg() {
  const pg = new PGlite();
  await pg.exec(
    'create role anon; create role authenticated; create role service_role; ' +
    'create schema storage; ' +
    'create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);'
  );
  await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  await pg.exec('alter table public.orders drop column if exists unverified_bill_urls;');
  for (const f of fs.readdirSync(path.join(ROOT, 'supabase/migrations')).sort()) {
    if (!f.endsWith('.sql') || f.startsWith('20261121120000_') || f.startsWith('20261127000000_')) continue;
    await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8'));
  }
  await pg.exec(
    "insert into public.app_users(username, password_hash, display_name, role, active) values " +
    "('admin','h','Meehoa_Manage','ADMIN',true), ('cmui','h','C Mụi','THO_OPS',true);"
  );
  await pg.query(
    "insert into public.app_sessions(token_hash, username, expires_at) values ($1, 'cmui', now() + interval '30 days')",
    [sha256Hex(CMUI_SESSION)]
  );
  return pg;
}

/**
 * Simulates live Production `meehoasg-api-core` v33 WITH real `prepareOrderUploads`,
 * real R2 presigned PUT handling, real HMAC `verifyStagedUploads`, real `previewSource`,
 * and real `createOperationService` committing to PostgreSQL.
 */
function createLiveV33DirectUploadOps(pg, supaOps, hooks = {}) {
  const r2Store = new Map();
  const stats = {
    prepareCalls: 0,
    putCalls: [],
    createOrderCalls: 0,
    createOrderPayloads: [],
    legacyUploadCalls: 0,
    discardedRefs: []
  };

  const previewSource = (url) => {
    const value = String(url);
    return /^(?:supabase:\/\/order-images|r2:\/\/[a-z0-9-]+\/order-images)\/[0-9a-f-]{36}\.jpg$/.test(value)
      ? value.replace(/\.jpg$/, '.preview.jpg')
      : url;
  };

  const verifyStagedUploads = async ({ actor, requestId, samples = [], bills = [] }) => {
    const seen = new Set();
    const check = (item, kind) => {
      const bucket = kind === 'sample' ? 'order-images' : 'settlement-bills';
      const filePath = String(item?.path || '').trim();
      const expiresAt = Number(item?.expiresAt);
      const proof = String(item?.proof || '').trim();
      const storage = item?.storage === 'r2' ? 'r2' : 'supabase';
      if (!/^[0-9a-f-]{36}(?:\.preview)?\.jpg$/.test(filePath) || expiresAt < Date.now()) {
        throw new Error('UPLOAD_CLAIM_INVALID');
      }
      const expected = evidenceSignature(actor, requestId, bucket, filePath, expiresAt, storage);
      if (expected !== proof) throw new Error('UPLOAD_CLAIM_INVALID');
      const objectKey = `${bucket}/${filePath}`;
      const ref = `r2://${R2_BUCKET}/${objectKey}`;
      if (seen.has(ref)) throw new Error('UPLOAD_CLAIM_DUPLICATE');
      seen.add(ref);
      const stored = r2Store.get(objectKey);
      if (!stored || stored.bytes.length < 1 || stored.bytes.length > 5 * 1024 * 1024) {
        throw new Error('R2_UPLOAD_NOT_READY');
      }
      return ref;
    };
    const verifiedSamples = samples.map(item => check(item, 'sample'));
    const verifiedPreviews = samples.map(item => {
      const expected = String(item?.path || '').replace(/\.jpg$/, '.preview.jpg');
      if (!item?.preview) return '';
      if (String(item.preview.path || '') !== expected) throw new Error('UPLOAD_CLAIM_INVALID');
      return check(item.preview, 'sample');
    }).filter(Boolean);
    const verifiedBills = bills.map(item => check(item, 'bill'));
    return { samples: verifiedSamples, previews: verifiedPreviews, bills: verifiedBills };
  };

  const fetcher = async (url, init = {}) => {
    const urlStr = String(url || '');
    // 1. Direct R2 signed PUT upload
    if (urlStr.startsWith(`https://r2-mock.meehoasg.test/${R2_BUCKET}/`) && String(init.method || 'GET').toUpperCase() === 'PUT') {
      const parsed = new URL(urlStr);
      const objectKey = parsed.pathname.slice(`/${R2_BUCKET}/`.length);
      const contentType = init.headers?.['Content-Type'] || init.headers?.['content-type'] || '';
      const bytes = init.body instanceof Uint8Array
        ? new Uint8Array(init.body)
        : new Uint8Array(Buffer.from(init.body || ''));
      stats.putCalls.push({ objectKey, contentType, size: bytes.length });
      if (hooks.failPreviewPut && objectKey.endsWith('.preview.jpg')) {
        return new Response('R2 temporary error', { status: 500 });
      }
      if (contentType !== 'image/jpeg') {
        return new Response('Invalid content type', { status: 400 });
      }
      r2Store.set(objectKey, { bytes, contentType });
      return new Response('', { status: 200 });
    }

    // 2. Supabase Edge Gateway verify_jwt check
    const hdrs = init.headers || {};
    if ((hdrs.Authorization || hdrs.authorization) !== `Bearer ${VALID_JWT}` || hdrs.apikey !== VALID_JWT) {
      return new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), { status: 401 });
    }

    const body = JSON.parse(init.body || '{}');
    const { name, payload = {} } = body;
    const tok = String(payload.token || '').trim();
    const sess = (await pg.query(
      'select s.username, s.expires_at, u.display_name, u.role, u.active from public.app_sessions s join public.app_users u on u.username = s.username where s.token_hash = $1 limit 1',
      [sha256Hex(tok)]
    )).rows[0];
    if (!sess || !sess.active || new Date(sess.expires_at).getTime() <= Date.now()) {
      return new Response(JSON.stringify({ ok: false, code: 'AUTH_REQUIRED', message: 'Phiên đăng nhập không hợp lệ.' }), { status: 200 });
    }
    const user = { username: sess.username, display_name: sess.display_name, role: sess.role, active: sess.active };

    if (name === 'getOrderRules') {
      return new Response(JSON.stringify({ ok: false, message: 'Thao tác không được hỗ trợ.' }), { status: 200 });
    }

    if (name === 'prepareOrderUploads') {
      stats.prepareCalls += 1;
      const requestId = String(payload.requestId || '').trim();
      const samples = Number(payload.samples) || 0;
      const bills = Number(payload.bills) || 0;
      const expiresAt = Date.now() + 14 * 60 * 1000;
      const tickets = [];
      for (let i = 0; i < samples; i++) {
        const filePath = `${crypto.randomUUID()}.jpg`;
        const previewPath = filePath.replace(/\.jpg$/, '.preview.jpg');
        tickets.push({
          kind: 'sample',
          path: filePath,
          storage: 'r2',
          expiresAt,
          proof: evidenceSignature(user.username, requestId, 'order-images', filePath, expiresAt, 'r2'),
          uploadUrl: `https://r2-mock.meehoasg.test/${R2_BUCKET}/order-images/${filePath}?X-Amz-Signature=sig`,
          preview: {
            path: previewPath,
            storage: 'r2',
            expiresAt,
            proof: evidenceSignature(user.username, requestId, 'order-images', previewPath, expiresAt, 'r2'),
            uploadUrl: `https://r2-mock.meehoasg.test/${R2_BUCKET}/order-images/${previewPath}?X-Amz-Signature=sig`
          }
        });
      }
      for (let i = 0; i < bills; i++) {
        const filePath = `${crypto.randomUUID()}.jpg`;
        tickets.push({
          kind: 'bill',
          path: filePath,
          storage: 'r2',
          expiresAt,
          proof: evidenceSignature(user.username, requestId, 'settlement-bills', filePath, expiresAt, 'r2'),
          uploadUrl: `https://r2-mock.meehoasg.test/${R2_BUCKET}/settlement-bills/${filePath}?X-Amz-Signature=sig`
        });
      }
      return new Response(JSON.stringify({ ok: true, tickets }), { status: 200 });
    }

    if (name === 'createOrder') {
      stats.createOrderCalls += 1;
      stats.createOrderPayloads.push(payload);
      const opService = supaOps.createOperationService({
        db: async (endpoint, _q, _m, rpcBody) => {
          if (endpoint === 'rpc/mee_ops_lookup') {
            return (await pg.query('select public.mee_ops_lookup($1,$2,$3,$4) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint])).rows[0].res;
          }
          if (endpoint === 'rpc/mee_ops_mutate') {
            return (await pg.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint, JSON.stringify(rpcBody.p_input)])).rows[0].res;
          }
          throw new Error(`Unexpected RPC ${endpoint}`);
        },
        one: async () => null,
        uploadImages: async (files, bucket) => {
          stats.legacyUploadCalls += files.length;
          return files.map(() => `r2://${R2_BUCKET}/${bucket}/${crypto.randomUUID()}.jpg`);
        },
        discardImages: async (urls) => {
          stats.discardedRefs.push(...(urls || []));
          for (const u of urls || []) {
            const prefix = `r2://${R2_BUCKET}/`;
            if (String(u).startsWith(prefix)) r2Store.delete(String(u).slice(prefix.length));
          }
        },
        verifyStagedUploads,
        sha256: async (s) => sha256Hex(s),
        newId: (prefix) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
      });

      const result = await opService.run('createOrder', payload, user);
      if (hooks.timeoutAfterCommitOnFirstCreate && stats.createOrderCalls === 1) {
        const abortErr = new Error('Simulated timeout after SQL commit');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (result.ok && result.orderId) {
        const row = (await pg.query('select * from public.orders where id = $1', [result.orderId])).rows[0];
        const rawImages = row.image_urls || [];
        result.order = {
          id: row.id,
          updatedAt: row.updated_at,
          customer: row.customer,
          flower: row.flower,
          date: row.order_date,
          time: row.order_time,
          shipping: row.shipping,
          flowerTotal: Number(row.flower_total),
          totalDue: Number(row.flower_total),
          payment: row.payment,
          paid: 130000,
          debt: Number(row.flower_total) - 130000,
          sale: 'C Mụi',
          saleUsername: 'cmui',
          driveUrls: rawImages,
          imageUrls: rawImages,
          previewUrls: rawImages.map(previewSource)
        };
      }
      return new Response(JSON.stringify(result), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: false, message: 'Thao tác không được hỗ trợ.' }), { status: 200 });
  };

  return { fetcher, r2Store, stats, previewSource };
}

function makeWebhookReq(update) {
  return new Request('https://meehoa-order-bot.meehoasg.workers.dev/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': WEBHOOK_SECRET
    },
    body: JSON.stringify(update)
  });
}

describe('Order Bot Preview Thumbnails (OPS v33 Direct R2 Staging)', () => {
  test('selectPreviewPhotoVariant chooses ~320px Telegram variant and ignores tiny 90px or single-size arrays', async () => {
    const { workerMod } = await loadModules();
    const { selectPreviewPhotoVariant } = workerMod;

    const multi = [
      { file_id: 'f_90', width: 67, height: 90, file_size: 1400 },
      { file_id: 'f_320', width: 240, height: 320, file_size: 14200 },
      { file_id: 'f_800', width: 600, height: 800, file_size: 51000 },
      { file_id: 'f_1280', width: 960, height: 1280, file_size: 112000 }
    ];
    const picked = selectPreviewPhotoVariant(multi, multi[multi.length - 1]);
    assert.equal(picked?.file_id, 'f_320');

    assert.equal(selectPreviewPhotoVariant([multi[3]], multi[3]), null);
    assert.equal(selectPreviewPhotoVariant([multi[0], multi[3]], multi[3]), null);
  });

  test('E2E Production v33: multi-size Telegram photo uploads BOTH <uuid>.jpg and <uuid>.preview.jpg via prepareOrderUploads + preuploadedSamples so OPS thumbnails exist in R2', async () => {
    const { workerMod, d1Store, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const ops = createLiveV33DirectUploadOps(pg, supaOps);
    const sentMessages = [];

    const fullJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x11, 0x22, 0x33, 0xff, 0xd9]);
    const previewJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x99, 0xff, 0xd9]);

    const telegramFetcher = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/getFile')) {
        if (u.includes('file_id=f_preview_320')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/thumb_320.jpg', file_size: previewJpegBytes.length } }));
        }
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/full_1280.jpg', file_size: fullJpegBytes.length } }));
      }
      if (u.includes('/file/bot') && u.includes('thumb_320.jpg')) {
        return new Response(previewJpegBytes, { status: 200 });
      }
      if (u.includes('/file/bot') && u.includes('full_1280.jpg')) {
        return new Response(fullJpegBytes, { status: 200 });
      }
      if (u.includes('/sendMessage')) {
        sentMessages.push(JSON.parse(init.body || '{}'));
        return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }));
      }
      if (u.includes('/answerCallbackQuery') || u.includes('/editMessageReplyMarkup')) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      return new Response('Not found', { status: 404 });
    };

    const env = {
      ENVIRONMENT: 'production',
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'bot_token_test',
      TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID),
      OPS_API_URL: PROD_OPS_URL,
      OPS_TOKEN: CMUI_SESSION,
      OPS_SUPABASE_ANON_KEY: VALID_JWT,
      OPS_SERVICE: { fetch: ops.fetcher },
      TELEGRAM_FETCHER: telegramFetcher
    };

    try {
      // 1. Owner sends multi-size Telegram photo + caption (just like the real order report)
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70001,
        message: {
          message_id: 101,
          chat: { id: OWNER_ID, type: 'private' },
          from: { id: OWNER_ID },
          photo: [
            { file_id: 'f_small_90', file_unique_id: 'u_90', width: 67, height: 90, file_size: 1200 },
            { file_id: 'f_preview_320', file_unique_id: 'u_320', width: 240, height: 320, file_size: previewJpegBytes.length },
            { file_id: 'f_full_1280', file_unique_id: 'u_1280', width: 960, height: 1280, file_size: fullJpegBytes.length }
          ],
          caption: 'Khách: Trần Lê Minh Phát\nMẫu: Ly 1 bông như mẫu\nTổng 260k cọc 130k\nNhận lúc 10:00 ngày 28/11/2026\nGhé lấy'
        }
      }), env);

      const drafts1 = await d1Store.loadDrafts(botD1, OWNER_ID);
      const d1 = drafts1[drafts1.__active];
      assert.equal(d1.sampleRefs.length, 1);
      assert.ok(d1.sampleRefs[0].r2_key, 'Original photo must be saved in bot R2');
      assert.ok(d1.sampleRefs[0].preview_r2_key?.endsWith('.preview.jpg'), '320px preview must be saved in bot R2');

      // 2. Owner confirms via /confirm
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70002,
        message: {
          message_id: 102,
          chat: { id: OWNER_ID, type: 'private' },
          from: { id: OWNER_ID },
          text: '/confirm'
        }
      }), env);

      assert.equal(ops.stats.prepareCalls, 1, 'Must call prepareOrderUploads exactly once');
      assert.equal(ops.stats.putCalls.length, 2, 'Must PUT both .preview.jpg and original .jpg to OPS R2');
      assert.equal(ops.stats.legacyUploadCalls, 0, 'Must NOT use legacy imageFiles path for JPEG samples on OPS v33');
      assert.equal(ops.stats.createOrderCalls, 1);

      const sentOrder = ops.stats.createOrderPayloads[0].order;
      assert.deepEqual(sentOrder.imageFiles, [], 'imageFiles must be empty when all samples are preuploaded');
      assert.equal(sentOrder.preuploadedSamples.length, 1);
      assert.ok(sentOrder.preuploadedSamples[0].preview?.path.endsWith('.preview.jpg'));

      // Verify committed PostgreSQL row + BOTH objects exist in OPS R2 with distinct expected bytes
      const drafts2 = await d1Store.loadDrafts(botD1, OWNER_ID);
      const d2 = drafts2[drafts2.__active];
      assert.equal(d2.status, 'submitted');
      assert.equal(d2.stagedOpsUpload, null, 'stagedOpsUpload cache should be cleared after submit');

      const pgRow = (await pg.query('select id, image_urls from public.orders where id = $1', [d2.opsOrderId])).rows[0];
      assert.equal(pgRow.image_urls.length, 1);
      const originalRef = pgRow.image_urls[0];
      const previewRef = ops.previewSource(originalRef);
      const prefix = `r2://${R2_BUCKET}/`;
      assert.ok(originalRef.startsWith(prefix));
      assert.ok(previewRef.endsWith('.preview.jpg'));

      const r2Original = ops.r2Store.get(originalRef.slice(prefix.length));
      const r2Preview = ops.r2Store.get(previewRef.slice(prefix.length));
      assert.ok(r2Original, 'Original <uuid>.jpg MUST exist in OPS R2');
      assert.ok(r2Preview, 'Thumbnail <uuid>.preview.jpg MUST exist in OPS R2');
      assert.deepEqual(Buffer.from(r2Original.bytes), Buffer.from(fullJpegBytes));
      assert.deepEqual(Buffer.from(r2Preview.bytes), Buffer.from(previewJpegBytes));
    } finally {
      await pg.close();
    }
  });

  test('Single-size photo (no separate 320px variant) still uploads BOTH <uuid>.jpg and <uuid>.preview.jpg', async () => {
    const { workerMod, d1Store, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const ops = createLiveV33DirectUploadOps(pg, supaOps);
    const singleBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9]);

    const env = {
      ENVIRONMENT: 'production',
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'bot_token_test',
      TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID),
      OPS_API_URL: PROD_OPS_URL,
      OPS_TOKEN: CMUI_SESSION,
      OPS_SUPABASE_ANON_KEY: VALID_JWT,
      OPS_SERVICE: { fetch: ops.fetcher },
      TELEGRAM_FETCHER: async (url) => {
        const u = String(url);
        if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/one.jpg', file_size: singleBytes.length } }));
        if (u.includes('/file/bot')) return new Response(singleBytes, { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
    };

    try {
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70101,
        message: {
          message_id: 201,
          chat: { id: OWNER_ID, type: 'private' },
          from: { id: OWNER_ID },
          photo: [{ file_id: 'f_only_one', file_unique_id: 'u_only_one' }],
          caption: 'Khách: Minh Thư\nMẫu: Bó tulip trắng\nTổng 400k cọc 200k\nNhận lúc 14:00 ngày 28/11/2026\nGhé lấy'
        }
      }), env);

      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70102,
        message: { message_id: 202, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/confirm' }
      }), env);

      const drafts = await d1Store.loadDrafts(botD1, OWNER_ID);
      const d = drafts[drafts.__active];
      assert.equal(d.status, 'submitted');
      const pgRow = (await pg.query('select image_urls from public.orders where id = $1', [d.opsOrderId])).rows[0];
      const prefix = `r2://${R2_BUCKET}/`;
      const origKey = pgRow.image_urls[0].slice(prefix.length);
      const prevKey = origKey.replace(/\.jpg$/, '.preview.jpg');
      assert.ok(ops.r2Store.has(origKey));
      assert.ok(ops.r2Store.has(prevKey), 'Preview key must exist in OPS R2 even for single-size photo');
      assert.deepEqual(Buffer.from(ops.r2Store.get(prevKey).bytes), Buffer.from(singleBytes));
    } finally {
      await pg.close();
    }
  });

  test('Idempotent retry after createOrder timeout reuses stagedOpsUpload with identical p_fingerprint and creates 0 duplicate orders', async () => {
    const { workerMod, d1Store, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const ops = createLiveV33DirectUploadOps(pg, supaOps, { timeoutAfterCommitOnFirstCreate: true });
    const imgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb, 0xff, 0xd9]);

    const env = {
      ENVIRONMENT: 'production',
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'bot_token_test',
      TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID),
      OPS_API_URL: PROD_OPS_URL,
      OPS_TOKEN: CMUI_SESSION,
      OPS_SUPABASE_ANON_KEY: VALID_JWT,
      OPS_SERVICE: { fetch: ops.fetcher },
      TELEGRAM_FETCHER: async (url) => {
        const u = String(url);
        if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/retry.jpg', file_size: imgBytes.length } }));
        if (u.includes('/file/bot')) return new Response(imgBytes, { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
    };

    try {
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70201,
        message: {
          message_id: 301,
          chat: { id: OWNER_ID, type: 'private' },
          from: { id: OWNER_ID },
          photo: [{ file_id: 'f_retry', file_unique_id: 'u_retry' }],
          caption: 'Khách: Ngọc Hân\nMẫu: Bó hồng kem\nTổng 300k cọc 150k\nNhận lúc 15:00 ngày 28/11/2026\nGhé lấy'
        }
      }), env);

      // Attempt 1: times out AFTER SQL commit
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70202,
        message: { message_id: 302, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/confirm' }
      }), env);

      const draftsAfterTimeout = await d1Store.loadDrafts(botD1, OWNER_ID);
      const dTimeout = draftsAfterTimeout[draftsAfterTimeout.__active];
      assert.equal(dTimeout.status, 'confirmed');
      assert.ok(dTimeout.stagedOpsUpload?.preuploadedSamples?.length === 1, 'stagedOpsUpload must be retained across timeout');

      // Attempt 2: retries /confirm -> reuses cached stagedOpsUpload, 0 extra prepare/PUT, hits mee_ops_lookup receipt!
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70203,
        message: { message_id: 303, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/confirm' }
      }), env);

      assert.equal(ops.stats.prepareCalls, 1, 'Retry must reuse staged upload without calling prepareOrderUploads again');
      assert.equal(ops.stats.putCalls.length, 2, 'Retry must NOT re-upload duplicate objects to R2');
      assert.equal(ops.stats.createOrderCalls, 2);
      const orderCount = (await pg.query('select count(*)::int as n from public.orders')).rows[0].n;
      assert.equal(orderCount, 1, 'Idempotent retry must create exactly 1 order in PostgreSQL');

      const draftsFinal = await d1Store.loadDrafts(botD1, OWNER_ID);
      assert.equal(draftsFinal[draftsFinal.__active].status, 'submitted');
    } finally {
      await pg.close();
    }
  });

  test('Fail-closed: R2 PUT failure for .preview.jpg aborts createOrder instead of creating a broken-thumbnail order', async () => {
    const { workerMod, d1Store, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const ops = createLiveV33DirectUploadOps(pg, supaOps, { failPreviewPut: true });
    const imgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x05, 0x06, 0xff, 0xd9]);

    const env = {
      ENVIRONMENT: 'production',
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'bot_token_test',
      TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID),
      OPS_API_URL: PROD_OPS_URL,
      OPS_TOKEN: CMUI_SESSION,
      OPS_SUPABASE_ANON_KEY: VALID_JWT,
      OPS_SERVICE: { fetch: ops.fetcher },
      TELEGRAM_FETCHER: async (url) => {
        const u = String(url);
        if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/fail.jpg', file_size: imgBytes.length } }));
        if (u.includes('/file/bot')) return new Response(imgBytes, { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
    };

    try {
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70301,
        message: {
          message_id: 401,
          chat: { id: OWNER_ID, type: 'private' },
          from: { id: OWNER_ID },
          photo: [{ file_id: 'f_fail', file_unique_id: 'u_fail' }],
          caption: 'Khách: Quốc Bảo\nMẫu: Bó hướng dương\nTổng 350k cọc 200k\nNhận lúc 11:00 ngày 28/11/2026\nGhé lấy'
        }
      }), env);

      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 70302,
        message: { message_id: 402, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/confirm' }
      }), env);

      assert.equal(ops.stats.createOrderCalls, 0, 'Must NOT call createOrder when .preview.jpg PUT fails');
      const drafts = await d1Store.loadDrafts(botD1, OWNER_ID);
      assert.equal(drafts[drafts.__active].status, 'confirmed', 'Draft must remain retryable');
    } finally {
      await pg.close();
    }
  });

  test('Cancelling a draft cleans up BOTH original r2_key and preview_r2_key in Bot R2', async () => {
    const { workerMod } = await loadModules();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x09, 0xff, 0xd9]);

    const env = {
      ENVIRONMENT: 'production',
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'bot_token_test',
      TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID),
      TELEGRAM_FETCHER: async (url) => {
        const u = String(url);
        if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/c.jpg', file_size: bytes.length } }));
        if (u.includes('/file/bot')) return new Response(bytes, { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
    };

    await workerMod.handleTelegramWebhook(makeWebhookReq({
      update_id: 70401,
      message: {
        message_id: 501,
        chat: { id: OWNER_ID, type: 'private' },
        from: { id: OWNER_ID },
        photo: [
          { file_id: 'f_c_320', file_unique_id: 'u_c_320', width: 240, height: 320 },
          { file_id: 'f_c_1280', file_unique_id: 'u_c_1280', width: 960, height: 1280 }
        ],
        caption: 'Khách: Test Cancel\nMẫu: Bó cúc\nTổng 200k'
      }
    }), env);

    assert.equal(botR2._map.size, 2, 'Both full photo and preview photo should exist in Bot R2');

    await workerMod.handleTelegramWebhook(makeWebhookReq({
      update_id: 70402,
      message: { message_id: 502, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/cancel' }
    }), env);

    assert.equal(botR2._map.size, 0, 'Cancelling draft must clean up both full and preview R2 keys');
  });
});
