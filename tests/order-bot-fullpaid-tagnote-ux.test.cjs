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
const WEBHOOK_SECRET = 'fp_tagnote_ux_secret_64hex';
const VALID_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fptagnote.sig';
const CMUI_SESSION = 'c'.repeat(64);
const SERVICE_KEY = 'test-service-role-key-fp';
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
  const [workerMod, coreMod, opsClient, d1Store, supaOps] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/worker.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/core.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/ops-client.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/d1-store.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'supabase/functions/_shared/operations.js')).href)
  ]);
  return { workerMod, coreMod, opsClient, d1Store, supaOps };
}

function createBotD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(ROOT, 'order-bot/cloudflare/schema.sql'), 'utf8'));
  return {
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

function createLiveV33Ops(pg, supaOps) {
  const r2Store = new Map();
  const stats = { preparePayloads: [], putKeys: [], createPayloads: [] };

  const verifyStagedUploads = async ({ actor, requestId, samples = [], bills = [] }) => {
    const check = (item, kind) => {
      const bucket = kind === 'sample' ? 'order-images' : 'settlement-bills';
      const filePath = String(item?.path || '').trim();
      const expiresAt = Number(item?.expiresAt);
      const proof = String(item?.proof || '').trim();
      const storage = item?.storage === 'r2' ? 'r2' : 'supabase';
      const expected = evidenceSignature(actor, requestId, bucket, filePath, expiresAt, storage);
      if (expected !== proof) throw new Error('UPLOAD_CLAIM_INVALID');
      const objectKey = `${bucket}/${filePath}`;
      if (!r2Store.has(objectKey)) throw new Error('R2_UPLOAD_NOT_READY');
      return `r2://${R2_BUCKET}/${objectKey}`;
    };
    return {
      samples: samples.map(s => check(s, 'sample')),
      previews: samples.map(s => (s.preview ? check(s.preview, 'sample') : '')).filter(Boolean),
      bills: bills.map(b => check(b, 'bill'))
    };
  };

  const fetcher = async (url, init = {}) => {
    const urlStr = String(url || '');
    if (urlStr.startsWith(`https://r2-mock.meehoasg.test/${R2_BUCKET}/`) && String(init.method || 'GET').toUpperCase() === 'PUT') {
      const objectKey = new URL(urlStr).pathname.slice(`/${R2_BUCKET}/`.length);
      stats.putKeys.push(objectKey);
      r2Store.set(objectKey, { bytes: new Uint8Array(init.body) });
      return new Response('', { status: 200 });
    }
    const hdrs = init.headers || {};
    if ((hdrs.Authorization || hdrs.authorization) !== `Bearer ${VALID_JWT}` || hdrs.apikey !== VALID_JWT) {
      return new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), { status: 401 });
    }
    const body = JSON.parse(init.body || '{}');
    const { name, payload = {} } = body;
    const sess = (await pg.query(
      'select s.username, s.expires_at, u.display_name, u.role, u.active from public.app_sessions s join public.app_users u on u.username = s.username where s.token_hash = $1 limit 1',
      [sha256Hex(String(payload.token || '').trim())]
    )).rows[0];
    if (!sess || !sess.active) return new Response(JSON.stringify({ ok: false, code: 'AUTH_REQUIRED' }), { status: 200 });
    const user = { username: sess.username, display_name: sess.display_name, role: sess.role, active: sess.active };

    if (name === 'getOrderRules') {
      return new Response(JSON.stringify({ ok: false, message: 'Thao tác không được hỗ trợ.' }), { status: 200 });
    }
    if (name === 'prepareOrderUploads') {
      stats.preparePayloads.push(payload);
      const expiresAt = Date.now() + 14 * 60 * 1000;
      const tickets = [];
      for (let i = 0; i < Number(payload.samples || 0); i++) {
        const filePath = `${crypto.randomUUID()}.jpg`;
        const previewPath = filePath.replace(/\.jpg$/, '.preview.jpg');
        tickets.push({
          kind: 'sample',
          path: filePath,
          storage: 'r2',
          expiresAt,
          proof: evidenceSignature(user.username, payload.requestId, 'order-images', filePath, expiresAt, 'r2'),
          uploadUrl: `https://r2-mock.meehoasg.test/${R2_BUCKET}/order-images/${filePath}?sig=1`,
          preview: {
            path: previewPath,
            storage: 'r2',
            expiresAt,
            proof: evidenceSignature(user.username, payload.requestId, 'order-images', previewPath, expiresAt, 'r2'),
            uploadUrl: `https://r2-mock.meehoasg.test/${R2_BUCKET}/order-images/${previewPath}?sig=1`
          }
        });
      }
      for (let i = 0; i < Number(payload.bills || 0); i++) {
        const filePath = `${crypto.randomUUID()}.jpg`;
        tickets.push({
          kind: 'bill',
          path: filePath,
          storage: 'r2',
          expiresAt,
          proof: evidenceSignature(user.username, payload.requestId, 'settlement-bills', filePath, expiresAt, 'r2'),
          uploadUrl: `https://r2-mock.meehoasg.test/${R2_BUCKET}/settlement-bills/${filePath}?sig=1`
        });
      }
      return new Response(JSON.stringify({ ok: true, tickets }), { status: 200 });
    }
    if (name === 'createOrder') {
      stats.createPayloads.push(payload);
      const opService = supaOps.createOperationService({
        db: async (ep, _q, _m, rpcBody) => {
          if (ep === 'rpc/mee_ops_lookup') {
            return (await pg.query('select public.mee_ops_lookup($1,$2,$3,$4) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint])).rows[0].res;
          }
          if (ep === 'rpc/mee_ops_mutate') {
            return (await pg.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint, JSON.stringify(rpcBody.p_input)])).rows[0].res;
          }
          throw new Error(ep);
        },
        one: async () => null,
        uploadImages: async (files, bucket) => files.map(() => `r2://${R2_BUCKET}/${bucket}/${crypto.randomUUID()}.jpg`),
        verifyStagedUploads,
        sha256: async (s) => sha256Hex(s),
        newId: (prefix) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
      });
      const res = await opService.run('createOrder', payload, user);
      if (res.ok && res.orderId) {
        const row = (await pg.query('select *, public.mee_ops_total(orders) total, public.mee_ops_paid(orders) paid, public.mee_ops_debt(orders) debt from public.orders where id = $1', [res.orderId])).rows[0];
        res.order = {
          id: row.id,
          updatedAt: row.updated_at.toISOString(),
          customer: row.customer,
          phone: row.phone,
          flower: row.flower,
          note: row.note,
          tagNoteFree: row.tag_note_free,
          date: row.order_date instanceof Date ? row.order_date.toISOString().slice(0, 10) : String(row.order_date),
          time: String(row.order_time).slice(0, 5),
          shipping: row.shipping,
          flowerTotal: Number(row.flower_total),
          totalDue: Number(row.total),
          payment: row.payment,
          paid: Number(row.paid),
          debt: Number(row.debt),
          fullPaid: Boolean(row.full_paid),
          fullPaidBillUrls: row.full_paid_bill_urls || [],
          card: Boolean(row.card),
          cardQty: Number(row.card_qty),
          sale: 'C Mụi',
          saleUsername: row.sale,
          imageUrls: row.image_urls || []
        };
      }
      return new Response(JSON.stringify(res), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, message: 'Thao tác không được hỗ trợ.' }), { status: 200 });
  };

  return { fetcher, r2Store, stats };
}

function makeWebhookReq(update) {
  return new Request('https://meehoa-order-bot.meehoasg.workers.dev/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify(update)
  });
}

describe('Operational Fixes: Full Paid Bill Flow, Tag Note Free vs Card, and Concise UX', () => {
  test('1. Full Paid requires bill photo ONLY for Full Paid, accepts bill photo on Telegram, uploads via prepareOrderUploads to full_paid_bill_urls, and rejects bill on non-Full Paid', async () => {
    const { workerMod, d1Store, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const ops = createLiveV33Ops(pg, supaOps);
    const sent = [];
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);

    const env = {
      ENVIRONMENT: 'production',
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'tok',
      TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID),
      OPS_API_URL: PROD_OPS_URL,
      OPS_TOKEN: CMUI_SESSION,
      OPS_SUPABASE_ANON_KEY: VALID_JWT,
      OPS_SERVICE: { fetch: ops.fetcher },
      TELEGRAM_FETCHER: async (url, init = {}) => {
        const u = String(url);
        if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/x.jpg', file_size: jpegBytes.length } }));
        if (u.includes('/file/bot')) return new Response(jpegBytes, { status: 200 });
        if (u.includes('/sendMessage')) {
          sent.push(JSON.parse(init.body || '{}'));
          return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
        }
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
    };

    try {
      // A. Bankfull / Deposit draft MUST reject bill photo cleanly explaining bills are only for Full Paid
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80001,
        message: {
          message_id: 1, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID },
          photo: [{ file_id: 'f_bf', file_unique_id: 'u_bf' }],
          caption: 'Mẫu: Ly 1 bông\nBankfull 260k\nKhách: Minh\n28/11/2026\n16h\nGhé lấy'
        }
      }), env);
      const bankfullButtons = sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text);
      assert.ok(bankfullButtons.includes('Tạo đơn'), 'Bankfull must NOT require bill photo');

      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80002,
        message: {
          message_id: 2, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID },
          photo: [{ file_id: 'f_bf_bill', file_unique_id: 'u_bf_bill' }],
          caption: 'Ảnh bill'
        }
      }), env);
      assert.match(sent.at(-1).text, /chưa ở trạng thái Full Paid.*không đính kèm ảnh bill/i);

      // B. Full Paid draft requires bill photo -> hides Tạo đơn until bill is sent
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80003,
        message: {
          message_id: 3, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID },
          photo: [{ file_id: 'f_fp_sample', file_unique_id: 'u_fp_sample' }],
          caption: 'Mẫu: Bó hồng đỏ\nFullpaid 280k\nKhách: Gia Huy\n28/11/2026\n15h\nGhé lấy'
        }
      }), env);
      const fpBeforeBillMsg = sent.at(-1);
      const fpButtonsBefore = fpBeforeBillMsg.reply_markup.inline_keyboard.flat().map(b => b.text);
      assert.ok(!fpButtonsBefore.includes('Tạo đơn'), 'Full Paid without bill must NOT show Tạo đơn');
      assert.match(fpBeforeBillMsg.text, /ảnh bill thanh toán/);

      // C. Owner sends bill photo with caption "Ảnh bill" -> ACCEPTED & shows Tạo đơn immediately!
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80004,
        message: {
          message_id: 4, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID },
          photo: [{ file_id: 'f_fp_bill', file_unique_id: 'u_fp_bill' }],
          caption: 'Ảnh bill'
        }
      }), env);
      const fpAfterBillMsg = sent.at(-1);
      const fpButtonsAfter = fpAfterBillMsg.reply_markup.inline_keyboard.flat().map(b => b.text);
      assert.ok(fpButtonsAfter.includes('Tạo đơn'), 'Full Paid with sample + bill MUST show Tạo đơn immediately');

      // D. Owner confirms -> OPS v33 creates real Full Paid order with sample (.jpg + .preview.jpg) AND bill in full_paid_bill_urls, debt = 0!
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80005,
        message: { message_id: 5, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/confirm' }
      }), env);

      assert.equal(ops.stats.preparePayloads.length, 1);
      assert.equal(ops.stats.preparePayloads[0].samples, 1);
      assert.equal(ops.stats.preparePayloads[0].bills, 1);
      assert.equal(ops.stats.putKeys.length, 3, 'Must PUT sample .preview.jpg, sample .jpg, and bill .jpg');
      assert.ok(ops.stats.putKeys.some(k => k.startsWith('order-images/') && k.endsWith('.preview.jpg')));
      assert.ok(ops.stats.putKeys.some(k => k.startsWith('settlement-bills/') && k.endsWith('.jpg')));

      const sentOrder = ops.stats.createPayloads[0].order;
      assert.equal(sentOrder.fullPaidRequested, true);
      assert.equal(sentOrder.payment, 'Đã thanh toán toàn bộ đơn');
      assert.equal(sentOrder.preuploadedSamples.length, 1);
      assert.equal(sentOrder.preuploadedBills.length, 1);
      assert.deepEqual(sentOrder.unverifiedBillFiles, []);

      const drafts = await d1Store.loadDrafts(botD1, OWNER_ID);
      const submitted = drafts[drafts.__active];
      assert.equal(submitted.status, 'submitted');
      const pgRow = (await pg.query('select full_paid, full_paid_total, full_paid_bill_urls, image_urls from public.orders where id = $1', [submitted.opsOrderId])).rows[0];
      assert.equal(pgRow.full_paid, true);
      assert.equal(Number(pgRow.full_paid_total), 280000);
      assert.equal(pgRow.full_paid_bill_urls.length, 1);
      assert.equal(pgRow.image_urls.length, 1);
      assert.ok(sent.at(-1).text.includes('Còn thu:</b> 0 đ'));
    } finally {
      await pg.close();
    }
  });

  test('2. Tag note free (multi-line) and Note NEVER trigger paid Thiệp (+10k), even if Gemini tries to extract cardText, and save to OPS tag_note_free', async () => {
    const { workerMod, d1Store, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const ops = createLiveV33Ops(pg, supaOps);
    const sent = [];
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x03, 0x04, 0xff, 0xd9]);

    // Maliciously simulate Gemini trying to misclassify Tag note free as cardText (+10k)!
    const geminiHallucinatingCard = async () => new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{
            text: JSON.stringify({
              customer: 'An',
              phone: '0986441540',
              flower: 'Ly mix như mẫu',
              cardText: 'One year down, forever to go. Happy 1st Wedding Anniversary, my love!',
              cardQty: 1
            })
          }]
        }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const env = {
      ENVIRONMENT: 'production',
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'tok',
      TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID),
      OPS_API_URL: PROD_OPS_URL,
      OPS_TOKEN: CMUI_SESSION,
      OPS_SUPABASE_ANON_KEY: VALID_JWT,
      OPS_SERVICE: { fetch: ops.fetcher },
      GEMINI_API_KEY: 'AIzaFakeKey',
      GEMINI_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_FETCHER: geminiHallucinatingCard,
      TELEGRAM_FETCHER: async (url, init = {}) => {
        const u = String(url);
        if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg', file_size: jpegBytes.length } }));
        if (u.includes('/file/bot')) return new Response(jpegBytes, { status: 200 });
        if (u.includes('/sendMessage')) {
          sent.push(JSON.parse(init.body || '{}'));
          return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
        }
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
    };

    try {
      // Exact caption from Owner Screenshot 3
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80101,
        message: {
          message_id: 11, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID },
          photo: [{ file_id: 'f_ss3', file_unique_id: 'u_ss3' }],
          caption: 'Ly mix như mẫu\nBankfull 450k\nAn\nSdt0986441540\n28/11/2026\n18h\nNhận tại shop\nTag note free: One year down, forever to go.\nHappy 1st Wedding Anniversary, my love! ❤'
        }
      }), env);

      const drafts1 = await d1Store.loadDrafts(botD1, OWNER_ID);
      const d1 = drafts1[drafts1.__active];
      assert.equal(Boolean(d1.fields.card), false, 'Tag note free must NEVER activate paid card (+10k)');
      assert.equal(d1.fields.cardText, undefined);
      assert.ok(d1.fields.tagNoteFree.includes('One year down, forever to go.'));
      assert.ok(d1.fields.tagNoteFree.includes('Happy 1st Wedding Anniversary, my love! ❤'));

      const summaryHtml = sent.at(-1).text;
      assert.ok(summaryHtml.includes('<b>Tag note free:</b>'));
      assert.ok(!summaryHtml.includes('Thiệp'), 'Summary must NOT show paid Thiệp');
      assert.ok(!summaryHtml.includes('460.000'), 'Total must stay 450.000 đ, not 460.000 đ');

      // Confirm and check OPS PostgreSQL stores tag_note_free with card=false and total=450000
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80102,
        message: { message_id: 12, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/confirm' }
      }), env);
      const drafts2 = await d1Store.loadDrafts(botD1, OWNER_ID);
      const pgRow = (await pg.query('select tag_note_free, card, card_qty, flower_total, public.mee_ops_total(orders) total from public.orders where id = $1', [drafts2[drafts2.__active].opsOrderId])).rows[0];
      assert.ok(pgRow.tag_note_free.includes('One year down, forever to go.'));
      assert.equal(pgRow.card, false);
      assert.equal(Number(pgRow.total), 450000);

      // Exact caption from Owner Screenshot 2 ("Tag note: Khách lấy thiệp trống đã thu 10k rồi") -> also goes to tagNoteFree, NOT auto +10k card!
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80103,
        message: {
          message_id: 13, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID },
          photo: [{ file_id: 'f_ss2', file_unique_id: 'u_ss2' }],
          caption: 'Mẫu: Ly 1 bông như mẫu\nBankfull 260k\nTên khách: Ngọc Tâm\nThời gian nhận hoa: - 16h\nngày 28/11/2026\nGhé lấy\nTag note: Khách lấy thiệp trống đã thu 10k rồi'
        }
      }), env);
      const drafts3 = await d1Store.loadDrafts(botD1, OWNER_ID);
      const d3 = drafts3[drafts3.__active];
      assert.equal(Boolean(d3.fields.card), false, 'Explicit Tag note: line must NOT auto-add +10k card');
      assert.equal(d3.fields.tagNoteFree, 'Khách lấy thiệp trống đã thu 10k rồi');
    } finally {
      await pg.close();
    }
  });

  test('3. Concise, clean message layout: zero raw *markdown*, zero R2 jargon, minimal icons, compact VN date', async () => {
    const { coreMod, workerMod } = await loadModules();
    const draft = {
      id: 'draft-000000-85ba73',
      status: 'pending',
      fields: {
        sale: 'cmui',
        customer: 'An',
        phone: '0986441540',
        flower: 'Ly mix như mẫu',
        flowerTotal: '450000',
        paymentState: 'bankfull',
        date: '2026-11-28',
        time: '18:00',
        shipping: 'Ghé lấy',
        tagNoteFree: 'Happy Anniversary!'
      },
      sampleRefs: [{ r2_key: 'order-images/s1.jpg' }],
      draftBillRefs: []
    };

    const plain = coreMod.draftSummary(draft);
    const formatted = workerMod.formatDraftSummaryHtml(draft);

    assert.ok(!plain.includes('*ĐƠN NHÁP'), 'Must not output raw markdown asterisks');
    assert.ok(!plain.includes('đã lưu trên R2'), 'Must not include technical R2 jargon');
    assert.ok(plain.includes('28/11/2026'), 'Must format date cleanly as DD/MM/YYYY');
    assert.ok(plain.includes('An · 0986441540'), 'Must group customer and phone on one concise line');
    assert.ok(plain.includes('18:00 · 28/11/2026 · Ghé lấy'), 'Must group time, date, and shipping on one concise line');
    assert.ok(!/[🧑‍💼👤📞🌸💰💳📅⏰🚚💌🎀✨📜🧮📷📋🆕💡]/u.test(plain), 'Must remove cluttered per-line icons');
    assert.ok(formatted.includes('<b>ĐƠN NHÁP #85ba73</b>'));
    assert.ok(formatted.includes('<b>Tag note free:</b> Happy Anniversary!'));
  });

  test('4. "Lưu ý khách" / "Lưu ý" / "Khách dặn" (with or without colon, multi-line, alongside Tag note free) saves cleanly into OPS orders.note (0 đ) and never triggers Thiệp (+10k)', async () => {
    const { workerMod, coreMod, d1Store, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const ops = createLiveV33Ops(pg, supaOps);
    const sent = [];
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x05, 0x06, 0xff, 0xd9]);

    const env = {
      ENVIRONMENT: 'production',
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'tok',
      TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID),
      OPS_API_URL: PROD_OPS_URL,
      OPS_TOKEN: CMUI_SESSION,
      OPS_SUPABASE_ANON_KEY: VALID_JWT,
      OPS_SERVICE: { fetch: ops.fetcher },
      TELEGRAM_FETCHER: async (url, init = {}) => {
        const u = String(url);
        if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/n.jpg', file_size: jpegBytes.length } }));
        if (u.includes('/file/bot')) return new Response(jpegBytes, { status: 200 });
        if (u.includes('/sendMessage')) {
          sent.push(JSON.parse(init.body || '{}'));
          return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
        }
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
    };

    try {
      // A. Caption with ALL 8 core fields + "Lưu ý khách:" (multi-line) + "Tag note free:" -> works 100% deterministically without Gemini!
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80201,
        message: {
          message_id: 21, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID },
          photo: [{ file_id: 'f_luuy1', file_unique_id: 'u_luuy1' }],
          caption: 'Khách: Minh Anh\nSĐT: 0909123456\nMẫu: Bó hồng pastel\nTổng 500k cọc 250k\n28/11/2026\n15h\nShop book ship\nĐịa chỉ: 123 Nguyễn Huệ Q1\nLưu ý khách: gói giấy màu kem, chọn hoa nụ tươi\nGiao gọi trước 15 phút\nTag note free: Chúc mừng sinh nhật!'
        }
      }), env);

      const drafts1 = await d1Store.loadDrafts(botD1, OWNER_ID);
      const d1 = drafts1[drafts1.__active];
      assert.ok(d1.fields.note.includes('gói giấy màu kem, chọn hoa nụ tươi'));
      assert.ok(d1.fields.note.includes('Giao gọi trước 15 phút'));
      assert.equal(d1.fields.tagNoteFree, 'Chúc mừng sinh nhật!');
      assert.equal(Boolean(d1.fields.card), false, 'Lưu ý khách & Tag note free must NEVER trigger +10k card');

      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 80202,
        message: { message_id: 22, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/confirm' }
      }), env);

      const drafts2 = await d1Store.loadDrafts(botD1, OWNER_ID);
      const pgRow = (await pg.query('select note, tag_note_free, card, public.mee_ops_total(orders) total from public.orders where id = $1', [drafts2[drafts2.__active].opsOrderId])).rows[0];
      assert.ok(pgRow.note.includes('gói giấy màu kem, chọn hoa nụ tươi'));
      assert.ok(pgRow.note.includes('Giao gọi trước 15 phút'));
      assert.equal(pgRow.tag_note_free, 'Chúc mừng sinh nhật!');
      assert.equal(pgRow.card, false);
      assert.equal(Number(pgRow.total), 500000);

      // B. Colon-less natural forms: "Lưu ý khách ..." and "Khách dặn ..."
      const parsedNatural = coreMod.applyFields({ id: 'd-nat', fields: {}, uncertainFields: {} }, 'Lưu ý khách không dùng giấy đen\nKhách dặn chụp ảnh trước khi giao');
      assert.ok(parsedNatural.draft.fields.note.includes('không dùng giấy đen'));
      assert.ok(parsedNatural.draft.fields.note.includes('chụp ảnh trước khi giao'));
      assert.equal(Boolean(parsedNatural.draft.fields.card), false);
      assert.equal(workerMod.textExplicitlyRequestsPaidCard('Lưu ý khách: ghi thiệp miễn phí không lấy thiệp trả phí'), false);
    } finally {
      await pg.close();
    }
  });
});
