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
const WEBHOOK_SECRET = 'inline_btn_test_secret_64hex';
const VALID_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.inlinebtn.sig';
const CMUI_SESSION = 'e'.repeat(64);

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function loadModules() {
  const [workerMod, coreMod, d1Store, supaOps] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/worker.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/core.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/d1-store.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'supabase/functions/_shared/operations.js')).href)
  ]);
  return { workerMod, coreMod, d1Store, supaOps };
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
    [hash(CMUI_SESSION)]
  );
  return pg;
}

function createLiveV33OpsFetcher(pg, supaOps, hooks = {}) {
  const stats = { createOrderCalls: 0, requestIds: [], uploadedSamples: [] };
  const fetcher = async (_url, init = {}) => {
    const hdrs = init.headers || {};
    if ((hdrs.Authorization || hdrs.authorization) !== `Bearer ${VALID_JWT}` || hdrs.apikey !== VALID_JWT) {
      return new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), { status: 401 });
    }
    const body = JSON.parse(init.body || '{}');
    const { name, payload = {} } = body;
    const tok = String(payload.token || '').trim();
    const sess = (await pg.query(
      'select s.username, s.expires_at, u.display_name, u.role, u.active from public.app_sessions s join public.app_users u on u.username = s.username where s.token_hash = $1 limit 1',
      [hash(tok)]
    )).rows[0];
    if (!sess || !sess.active || new Date(sess.expires_at).getTime() <= Date.now()) {
      return new Response(JSON.stringify({ ok: false, code: 'AUTH_REQUIRED', message: 'Phiên đăng nhập không hợp lệ.' }), { status: 200 });
    }
    const user = { username: sess.username, display_name: sess.display_name, role: sess.role, active: sess.active };

    // Live v33 does NOT expose getOrderRules
    if (name === 'getOrderRules') {
      return new Response(JSON.stringify({ ok: false, message: 'Thao tác không được hỗ trợ.' }), { status: 200 });
    }

    if (name === 'getOrder') {
      const row = (await pg.query('select * from public.orders where id = $1 limit 1', [String(payload.orderId || '').trim()])).rows[0];
      if (!row) return new Response(JSON.stringify({ ok: false, message: 'Không tìm thấy đơn.' }), { status: 200 });
      const fin = (await pg.query('select public.mee_ops_total(o) total, public.mee_ops_paid(o) paid, public.mee_ops_debt(o) debt from public.orders o where o.id = $1', [row.id])).rows[0];
      return new Response(JSON.stringify({
        ok: true,
        order: {
          id: row.id, updatedAt: row.updated_at.toISOString(), customer: row.customer, phone: row.phone,
          date: row.order_date instanceof Date ? row.order_date.toISOString().slice(0, 10) : String(row.order_date),
          time: String(row.order_time).slice(0, 5), flower: row.flower, note: row.note,
          shipping: row.shipping, address: row.address, flowerTotal: Number(row.flower_total),
          payment: row.payment, paid: Number(fin.paid), debt: Number(fin.debt), totalDue: Number(fin.total),
          sale: 'C Mụi', saleUsername: row.sale, imageUrls: row.image_urls || []
        }
      }), { status: 200 });
    }

    if (name === 'createOrder') {
      stats.createOrderCalls += 1;
      stats.requestIds.push(payload.requestId);
      if (typeof hooks.beforeCreateOrder === 'function') {
        const overrideRes = await hooks.beforeCreateOrder(stats.createOrderCalls, payload);
        if (overrideRes) return overrideRes;
      }

      const svc = supaOps.createOperationService({
        db: async (ep, _q, _m, rpcBody) => {
          if (ep === 'rpc/mee_ops_lookup') {
            return (await pg.query('select public.mee_ops_lookup($1,$2,$3,$4) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint])).rows[0].res;
          }
          if (ep === 'rpc/mee_ops_mutate') {
            return (await pg.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint, JSON.stringify(rpcBody.p_input)])).rows[0].res;
          }
          throw new Error(ep);
        },
        one: async (t, q) => t === 'orders' && q.id?.startsWith('eq.')
          ? ((await pg.query('select * from public.orders where id = $1 limit 1', [q.id.slice(3)])).rows[0] || null)
          : null,
        uploadImages: async (files, bucket) => files.map(() => {
          const uri = `r2://meehoasg-website-media/${bucket}/${crypto.randomUUID()}.jpg`;
          if (bucket === 'order-images') stats.uploadedSamples.push(uri);
          return uri;
        }),
        sha256: async (s) => hash(s),
        newId: (prefix) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
      });

      const r = await svc.run('createOrder', payload, user);
      if (typeof hooks.afterCreateOrder === 'function') {
        const overrideAfter = await hooks.afterCreateOrder(stats.createOrderCalls, r, payload);
        if (overrideAfter) return overrideAfter;
      }
      if (r.ok && r.orderId) {
        const row = (await pg.query('select *, public.mee_ops_total(orders) total, public.mee_ops_paid(orders) paid, public.mee_ops_debt(orders) debt from public.orders where id = $1', [r.orderId])).rows[0];
        r.order = {
          id: row.id, updatedAt: row.updated_at.toISOString(), customer: row.customer, phone: row.phone,
          date: row.order_date instanceof Date ? row.order_date.toISOString().slice(0, 10) : String(row.order_date),
          time: String(row.order_time).slice(0, 5), flower: row.flower, note: row.note,
          shipping: row.shipping, address: row.address, flowerTotal: Number(row.flower_total),
          payment: row.payment, paid: Number(row.paid), debt: Number(row.debt), totalDue: Number(row.total),
          sale: 'C Mụi', saleUsername: row.sale, imageUrls: row.image_urls || [],
          card: Boolean(row.card), cardQty: Number(row.card_qty), banner: Boolean(row.banner), bannerQty: Number(row.banner_qty),
          shipFee: Number(row.ship_fee), shipConfirmed: Boolean(row.ship_confirmed), fullPaid: Boolean(row.full_paid)
        };
      }
      return new Response(JSON.stringify(r), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: false, message: 'Unsupported' }), { status: 400 });
  };
  return { fetcher, stats };
}

function createTelegramHarness() {
  const sent = [];
  const callbacksAnswered = [];
  const markupsEdited = [];
  let msgSeq = 100;

  const fetcher = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/sample.jpg', file_size: 400 } }), { status: 200 });
    }
    if (u.includes('/file/bot')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.includes('/sendMessage')) {
      const body = JSON.parse(init.body || '{}');
      const messageId = ++msgSeq;
      sent.push({ messageId, ...body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
    }
    if (u.includes('/answerCallbackQuery')) {
      const body = JSON.parse(init.body || '{}');
      callbacksAnswered.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (u.includes('/editMessageReplyMarkup')) {
      const body = JSON.parse(init.body || '{}');
      markupsEdited.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    if (u.includes('/getWebhookInfo')) {
      return new Response(JSON.stringify({
        ok: true,
        result: {
          url: 'https://meehoa-order-bot.meehoasg.workers.dev/webhook',
          pending_update_count: 0,
          allowed_updates: ['message', 'callback_query'],
          max_connections: 40
        }
      }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  return { fetcher, sent, callbacksAnswered, markupsEdited };
}

function flattenButtons(replyMarkup) {
  if (!replyMarkup?.inline_keyboard) return [];
  return replyMarkup.inline_keyboard.flat();
}

function findButton(msg, exactLabel) {
  return flattenButtons(msg?.reply_markup).find(b => b.text === exactLabel) || null;
}

function makeWebhookReq(body, secret = WEBHOOK_SECRET) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  return new Request('https://meehoa-order-bot.meehoasg.workers.dev/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

function makeMsgUpdate(updateId, msg, userId = OWNER_ID, chatType = 'private') {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: chatType },
      from: { id: userId },
      ...msg
    }
  };
}

function makeCallbackUpdate(updateId, callbackData, messageId = 101, userId = OWNER_ID, chatType = 'private') {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: userId },
      message: {
        message_id: messageId,
        chat: { id: userId, type: chatType }
      },
      data: callbackData
    }
  };
}

describe('Inline Buttons 1: Encoding, 64-byte Telegram Cap & State-Aware Keyboards', () => {
  test('encodes/parses all callback payloads <= 64 bytes and selects exact buttons by draft state', async () => {
    const { workerMod } = await loadModules();
    const uuid = crypto.randomUUID();

    for (const [action, extra] of [['cf', null], ['ed', null], ['cx', null], ['sh', 's'], ['sh', 'k'], ['sh', 'g'], ['nw', null]]) {
      const encoded = workerMod.encodeCallbackData(action, uuid, 42, extra);
      assert.ok(Buffer.byteLength(encoded, 'utf8') <= 64, `callback_data exceeds 64 bytes: ${encoded}`);
      const parsed = workerMod.parseCallbackData(encoded);
      assert.ok(parsed, `failed to parse ${encoded}`);
      assert.equal(parsed.action, action);
      assert.equal(parsed.draftId, uuid);
      assert.equal(parsed.version, 42);
    }
    assert.equal(workerMod.parseCallbackData('bad:data'), null);
    assert.equal(workerMod.parseCallbackData('ob:sh:x:' + uuid + ':1'), null);
    assert.equal(workerMod.parseCallbackData('ob:cf:' + uuid + ':0'), null);

    // Ready draft -> Tạo đơn, Sửa thông tin, Hủy nháp
    const readyDraft = {
      id: uuid,
      status: 'pending',
      version: 3,
      fields: {
        sale: 'cmui', customer: 'Khanh', flower: 'Bó hồng', flowerTotal: '350000',
        date: '2026-12-29', time: '16:00', shipping: 'Ghé lấy', paymentState: 'deposit', depositAmount: 200000
      },
      sampleRefs: [{ fileId: 'f1' }]
    };
    const readyButtons = flattenButtons(workerMod.buildDraftReplyMarkup(readyDraft));
    assert.deepEqual(readyButtons.map(b => b.text), ['Tạo đơn', 'Sửa thông tin', 'Hủy nháp']);
    for (const b of readyButtons) assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64);

    // Missing shipping -> Shop book ship, Khách tự book, Ghé lấy
    const noShipDraft = { ...readyDraft, fields: { ...readyDraft.fields, shipping: '' } };
    const shipButtons = flattenButtons(workerMod.buildDraftReplyMarkup(noShipDraft));
    assert.deepEqual(shipButtons.map(b => b.text), ['Shop book ship', 'Khách tự book', 'Ghé lấy']);

    // Has shipping, missing flowerTotal -> Sửa thông tin, Hủy nháp (NO Tạo đơn)
    const missingPriceDraft = { ...readyDraft, fields: { ...readyDraft.fields, flowerTotal: '' } };
    const incompleteButtons = flattenButtons(workerMod.buildDraftReplyMarkup(missingPriceDraft));
    assert.deepEqual(incompleteButtons.map(b => b.text), ['Sửa thông tin', 'Hủy nháp']);

    // Submitted -> Tạo đơn khác
    const submittedButtons = flattenButtons(workerMod.buildDraftReplyMarkup({ ...readyDraft, status: 'submitted' }));
    assert.deepEqual(submittedButtons.map(b => b.text), ['Tạo đơn khác']);

    // Confirming -> null
    assert.equal(workerMod.buildDraftReplyMarkup({ ...readyDraft, status: 'confirming' }), null);
  });
});

describe('Inline Buttons 2: Photo + Caption -> Tạo đơn (OPS v33 Parity) -> Tạo đơn khác + Fallback Commands', () => {
  test('creates exact OPS v33 order via Tạo đơn button with Sale cmui, sample photo, deposit & debt, then shows Tạo đơn khác', async () => {
    const { workerMod, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    try {
      const botD1 = createBotD1();
      const botR2 = createMockR2();
      const tg = createTelegramHarness();
      const ops = createLiveV33OpsFetcher(pg, supaOps);
      const env = {
        ENVIRONMENT: 'production', SERVICE_NAME: 'meehoa-order-bot',
        DB: botD1, MEDIA_R2: botR2, BOT_TOKEN: 'tok', TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
        ALLOWED_USER_IDS: String(OWNER_ID), OPS_API_URL: PROD_OPS_URL, OPS_TOKEN: CMUI_SESSION,
        OPS_SUPABASE_ANON_KEY: VALID_JWT, OPS_SERVICE: { fetch: ops.fetcher }, TELEGRAM_FETCHER: tg.fetcher
      };

      // 1. Owner sends sample photo + full caption
      const res1 = await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(1001, {
        photo: [{ file_id: 'f1', file_unique_id: 'u1' }],
        caption: 'Khanh Test 0909888123\nmẫu: bó hồng test\nTổng 350k cọc 200k\n29/12 lúc 16h\nGhé lấy\nghi chú: [TEST BTN]'
      })), env);
      assert.equal(res1.status, 200);

      const summaryMsg = tg.sent.at(-1);
      const createBtn = findButton(summaryMsg, 'Tạo đơn');
      const editBtn = findButton(summaryMsg, 'Sửa thông tin');
      const cancelBtn = findButton(summaryMsg, 'Hủy nháp');
      assert.ok(createBtn && editBtn && cancelBtn, 'Complete draft must render Tạo đơn, Sửa thông tin, Hủy nháp');

      // 2. Owner taps Tạo đơn
      const res2 = await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(1002, createBtn.callback_data, summaryMsg.messageId)),
        env
      );
      assert.equal(res2.status, 200);
      assert.equal(ops.stats.createOrderCalls, 1);
      assert.ok(tg.callbacksAnswered.some(c => c.callback_query_id === 'cb_1002'));
      assert.ok(tg.markupsEdited.some(m => m.message_id === summaryMsg.messageId));

      const dbOrders = (await pg.query('select *, public.mee_ops_total(orders) total, public.mee_ops_paid(orders) paid, public.mee_ops_debt(orders) debt from public.orders')).rows;
      assert.equal(dbOrders.length, 1);
      assert.equal(dbOrders[0].sale, 'cmui');
      assert.equal(dbOrders[0].customer, 'Khanh Test');
      assert.equal(dbOrders[0].image_urls.length, 1);
      assert.equal(Number(dbOrders[0].flower_total), 350000);
      assert.equal(Number(dbOrders[0].paid), 200000);
      assert.equal(Number(dbOrders[0].debt), 150000);
      assert.equal(dbOrders[0].full_paid, false);

      const successMsg = tg.sent.at(-1);
      assert.ok(successMsg.text.includes(dbOrders[0].id));
      assert.ok(successMsg.text.includes('C Mụi'));
      assert.ok(successMsg.text.includes('200.000 đ'));
      assert.ok(successMsg.text.includes('150.000 đ'));
      const newOrderBtn = findButton(successMsg, 'Tạo đơn khác');
      assert.ok(newOrderBtn, 'Success reply must render Tạo đơn khác button');

      // 3. Tapping Tạo đơn khác starts a clean draft ready for the next order
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(1003, newOrderBtn.callback_data, successMsg.messageId)),
        env
      );
      assert.ok(tg.sent.at(-1).text.includes('Đã tạo đơn nháp mới'));

      // 4. Sending photo + caption directly ALSO works for a new order (and fallback /show + /confirm still work)
      await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(1004, {
        photo: [{ file_id: 'f2', file_unique_id: 'u2' }],
        caption: 'Minh Anh 0911222333\nmẫu: bó tulip\nTổng 500k cọc 250k\n30/12 lúc 10h\nGhé lấy'
      })), env);
      await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(1005, { text: '/show' })), env);
      assert.ok(findButton(tg.sent.at(-1), 'Tạo đơn'), '/show fallback must also attach current draft buttons');
      await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(1006, { text: '/confirm' })), env);
      assert.equal(ops.stats.createOrderCalls, 2);
      assert.ok(findButton(tg.sent.at(-1), 'Tạo đơn khác'), '/confirm fallback also renders Tạo đơn khác');
    } finally {
      await pg.close();
    }
  });
});

describe('Inline Buttons 3: Sửa thông tin Flow & Stale Version Invalidation', () => {
  test('guides plain-text edit, reprints updated summary + new version buttons, and blocks old version buttons', async () => {
    const { workerMod, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    try {
      const botD1 = createBotD1();
      const botR2 = createMockR2();
      const tg = createTelegramHarness();
      const ops = createLiveV33OpsFetcher(pg, supaOps);
      const env = {
        ENVIRONMENT: 'production', SERVICE_NAME: 'meehoa-order-bot',
        DB: botD1, MEDIA_R2: botR2, BOT_TOKEN: 'tok', TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
        ALLOWED_USER_IDS: String(OWNER_ID), OPS_API_URL: PROD_OPS_URL, OPS_TOKEN: CMUI_SESSION,
        OPS_SUPABASE_ANON_KEY: VALID_JWT, OPS_SERVICE: { fetch: ops.fetcher }, TELEGRAM_FETCHER: tg.fetcher
      };

      await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(2001, {
        photo: [{ file_id: 'f1', file_unique_id: 'u1' }],
        caption: 'Lan Anh 0901234567\nmẫu: bó hồng pastel\nTổng 350k cọc 200k\n29/12 lúc 14h\nGhé lấy'
      })), env);
      const v1Summary = tg.sent.at(-1);
      const oldCreateBtn = findButton(v1Summary, 'Tạo đơn');
      const editBtn = findButton(v1Summary, 'Sửa thông tin');
      assert.ok(oldCreateBtn && editBtn);

      // Click Sửa thông tin -> receives clear plain-text guidance
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(2002, editBtn.callback_data, v1Summary.messageId)),
        env
      );
      assert.match(tg.sent.at(-1).text, /tin nhắn thường/i);

      // Owner sends normal text edit -> Bot updates exact draft & shows updated summary + fresh buttons
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeMsgUpdate(2003, { text: 'giá 500k\ncọc 250k\ngiờ 17h' })),
        env
      );
      const v2Summary = tg.sent.at(-1);
      assert.ok(v2Summary.text.includes('500.000 đ'));
      assert.ok(v2Summary.text.includes('17:00'));
      assert.ok(v2Summary.text.includes('ĐƠN NHÁP'));
      const newCreateBtn = findButton(v2Summary, 'Tạo đơn');
      assert.ok(newCreateBtn);
      assert.notEqual(newCreateBtn.callback_data, oldCreateBtn.callback_data, 'Draft edit must increment button version');

      // Clicking OLD Tạo đơn button -> rejected as stale, 0 OPS writes, directs back to latest summary
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(2004, oldCreateBtn.callback_data, v1Summary.messageId)),
        env
      );
      assert.equal(ops.stats.createOrderCalls, 0);
      assert.match(tg.sent.at(-1).text, /hết hiệu lực/i);
      assert.equal(findButton(tg.sent.at(-1), 'Tạo đơn')?.callback_data, newCreateBtn.callback_data);

      // Clicking NEW Tạo đơn button -> creates 1 order with updated fields
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(2005, newCreateBtn.callback_data, v2Summary.messageId)),
        env
      );
      assert.equal(ops.stats.createOrderCalls, 1);
      const row = (await pg.query('select *, public.mee_ops_paid(orders) paid, public.mee_ops_debt(orders) debt from public.orders')).rows[0];
      assert.equal(Number(row.flower_total), 500000);
      assert.equal(Number(row.paid), 250000);
      assert.equal(Number(row.debt), 250000);
      assert.equal(String(row.order_time).slice(0, 5), '17:00');
    } finally {
      await pg.close();
    }
  });
});

describe('Inline Buttons 4: Missing Shipping Buttons & Shop Book Ship Address Reminder', () => {
  test('shows 3 shipping buttons when missing, reminds address on Shop book ship, and prompts exact remaining fields', async () => {
    const { workerMod } = await loadModules();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const tg = createTelegramHarness();
    const env = {
      ENVIRONMENT: 'production', SERVICE_NAME: 'meehoa-order-bot',
      DB: botD1, MEDIA_R2: botR2, BOT_TOKEN: 'tok', TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID), TELEGRAM_FETCHER: tg.fetcher
    };

    // Case A: Missing BOTH shipping AND flowerTotal (no address)
    await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(3001, {
      photo: [{ file_id: 'f1', file_unique_id: 'u1' }],
      caption: 'Khách Thảo My 0909111222\nbó hoa hồng đỏ\n29/12 lúc 16h'
    })), env);
    const msg1 = tg.sent.at(-1);
    const shopBtn = findButton(msg1, 'Shop book ship');
    const selfBtn = findButton(msg1, 'Khách tự book');
    const pickupBtn = findButton(msg1, 'Ghé lấy');
    assert.ok(shopBtn && selfBtn && pickupBtn, 'Missing shipping must display all 3 shipping buttons');
    assert.equal(findButton(msg1, 'Tạo đơn'), null);

    // Tap Shop book ship -> updates shipping, reminds address, asks exact missing field (tiền hoa), still NO Tạo đơn
    await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(3002, shopBtn.callback_data, msg1.messageId)),
      env
    );
    const msg2 = tg.sent.at(-1);
    assert.ok(msg2.text.includes('Shop book ship'));
    assert.match(msg2.text, /chưa có địa chỉ|bổ sung địa chỉ/i);
    assert.match(msg2.text, /tiền hoa/i);
    assert.equal(findButton(msg2, 'Tạo đơn'), null, 'Must not show Tạo đơn while flowerTotal is missing');
    assert.ok(findButton(msg2, 'Sửa thông tin') && findButton(msg2, 'Hủy nháp'));

    // Clicking old shipping button again -> stale rejection
    await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(3003, pickupBtn.callback_data, msg1.messageId)),
      env
    );
    assert.match(tg.sent.at(-1).text, /hết hiệu lực/i);

    // Provide missing flowerTotal -> now ready with Tạo đơn + address reminder preserved
    await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(3004, { text: 'giá 500k' })), env);
    const msg4 = tg.sent.at(-1);
    assert.ok(findButton(msg4, 'Tạo đơn'), 'Once flowerTotal supplied, Tạo đơn must appear');
    assert.match(msg4.text, /Nhắc bổ sung: địa chỉ giao hàng \(Shop book ship\)/);

    // Case B: Missing ONLY shipping -> tap Ghé lấy -> immediately shows 3 ready buttons with no address reminder
    await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(3005, {
      photo: [{ file_id: 'f2', file_unique_id: 'u2' }],
      caption: 'Khách Mai 0912345678\nbó cúc họa mi 400k\n30/12 lúc 11h'
    })), env);
    const msg5 = tg.sent.at(-1);
    const pickupBtn2 = findButton(msg5, 'Ghé lấy');
    assert.ok(pickupBtn2);
    await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(3006, pickupBtn2.callback_data, msg5.messageId)),
      env
    );
    const msg6 = tg.sent.at(-1);
    assert.ok(msg6.text.includes('Ghé lấy'));
    assert.ok(!/Nhắc bổ sung: địa chỉ/.test(msg6.text));
    assert.deepEqual(flattenButtons(msg6.reply_markup).map(b => b.text), ['Tạo đơn', 'Sửa thông tin', 'Hủy nháp']);
  });
});

describe('Inline Buttons 5: Hủy nháp, Replaced Draft Invalidation & Owner-Only Security', () => {
  test('cancels draft + cleans R2, blocks stale buttons from cancelled/replaced drafts, and denies non-owners/groups', async () => {
    const { workerMod, d1Store } = await loadModules();
    const botD1 = createBotD1();
    const botR2 = createMockR2();
    const tg = createTelegramHarness();
    const env = {
      ENVIRONMENT: 'production', SERVICE_NAME: 'meehoa-order-bot',
      DB: botD1, MEDIA_R2: botR2, BOT_TOKEN: 'tok', TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
      ALLOWED_USER_IDS: String(OWNER_ID), TELEGRAM_FETCHER: tg.fetcher
    };

    // Create Draft A
    await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(4001, {
      photo: [{ file_id: 'f1', file_unique_id: 'u1' }],
      caption: 'Khách A 0901111222\nbó hồng 400k\n29/12 10h\nGhé lấy'
    })), env);
    const msgA = tg.sent.at(-1);
    const createBtnA = findButton(msgA, 'Tạo đơn');
    const cancelBtnA = findButton(msgA, 'Hủy nháp');
    assert.equal(botR2._map.size, 1);

    // Non-owner tries clicking Hủy nháp -> rejected with alert, draft & R2 untouched!
    const unauthRes = await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(4002, cancelBtnA.callback_data, msgA.messageId, 999999999, 'private')),
      env
    );
    assert.equal(unauthRes.status, 200);
    assert.ok(tg.callbacksAnswered.some(c => c.callback_query_id === 'cb_4002' && c.show_alert === true));
    assert.equal(botR2._map.size, 1);

    // Group chat callback -> ignored, draft untouched!
    const grpRes = await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(4003, cancelBtnA.callback_data, msgA.messageId, OWNER_ID, 'group')),
      env
    );
    assert.equal(grpRes.status, 200);
    assert.equal(botR2._map.size, 1);

    // Wrong webhook secret on callback -> HTTP 403
    const badSecRes = await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(4004, cancelBtnA.callback_data, msgA.messageId), 'wrong_secret'),
      env
    );
    assert.equal(badSecRes.status, 403);

    // Owner clicks Hủy nháp -> draft deleted & R2 cleaned up
    await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(4005, cancelBtnA.callback_data, msgA.messageId)),
      env
    );
    assert.equal(botR2._map.size, 0, 'Cancelled draft R2 sample photo must be cleaned up');
    assert.ok(findButton(tg.sent.at(-1), 'Tạo đơn khác'));

    // Clicking old Tạo đơn from cancelled Draft A -> stale error
    await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(4006, createBtnA.callback_data, msgA.messageId)),
      env
    );
    assert.match(tg.sent.at(-1).text, /hết hiệu lực/i);

    // Create Draft B, then replace active with Draft C (new customer) -> old Draft B button rejected & points to Draft C
    await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(4007, {
      photo: [{ file_id: 'f2', file_unique_id: 'u2' }],
      caption: 'Chị Bảo 0902222333\nbó hồng B 400k\n29/12 10h\nGhé lấy'
    })), env);
    const msgB = tg.sent.at(-1);
    const createBtnB = findButton(msgB, 'Tạo đơn');

    await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(4008, {
      photo: [{ file_id: 'f3', file_unique_id: 'u3' }],
      caption: 'Anh Cường 0903333444\nbó hồng C 550k\n30/12 15h\nGhé lấy'
    })), env);
    const msgC = tg.sent.at(-1);
    const createBtnC = findButton(msgC, 'Tạo đơn');

    await workerMod.handleTelegramWebhook(
      makeWebhookReq(makeCallbackUpdate(4009, createBtnB.callback_data, msgB.messageId)),
      env
    );
    const staleRedirect = tg.sent.at(-1);
    assert.match(staleRedirect.text, /hết hiệu lực/i);
    assert.ok(staleRedirect.text.includes('Cường'), 'Must guide Owner to current active Draft C');
    assert.equal(findButton(staleRedirect, 'Tạo đơn')?.callback_data, createBtnC.callback_data);

    const stored = await d1Store.loadDrafts(botD1, OWNER_ID);
    assert.ok(String(stored[stored.__active].fields.customer).includes('Cường'));
  });
});

describe('Inline Buttons 6: Anti-Duplicate (Double Tap, Update Replay, Concurrent /confirm) & OPS Error Retry', () => {
  test('guarantees strictly 1 OPS order across double-tap, replayed callback update, concurrent button+/confirm, and OPS error retry', async () => {
    const { workerMod, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    try {
      // --- Part A: Double-tap + Telegram replay + Concurrent button vs /confirm ---
      const botD1 = createBotD1();
      const botR2 = createMockR2();
      const tg = createTelegramHarness();
      const ops = createLiveV33OpsFetcher(pg, supaOps, {
        beforeCreateOrder: async () => {
          await new Promise(r => setTimeout(r, 80));
          return null;
        }
      });
      const env = {
        ENVIRONMENT: 'production', SERVICE_NAME: 'meehoa-order-bot',
        DB: botD1, MEDIA_R2: botR2, BOT_TOKEN: 'tok', TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
        ALLOWED_USER_IDS: String(OWNER_ID), OPS_API_URL: PROD_OPS_URL, OPS_TOKEN: CMUI_SESSION,
        OPS_SUPABASE_ANON_KEY: VALID_JWT, OPS_SERVICE: { fetch: ops.fetcher }, TELEGRAM_FETCHER: tg.fetcher
      };

      await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(5001, {
        photo: [{ file_id: 'f1', file_unique_id: 'u1' }],
        caption: 'Khách Race 0909123456\nmẫu: bó hồng race\nTổng 500k cọc 250k\n29/12 15h\nGhé lấy'
      })), env);
      const summary = tg.sent.at(-1);
      const createBtn = findButton(summary, 'Tạo đơn');

      // Fire button Tạo đơn + duplicate button tap + /confirm command concurrently!
      await Promise.all([
        workerMod.handleTelegramWebhook(makeWebhookReq(makeCallbackUpdate(5002, createBtn.callback_data, summary.messageId)), env),
        workerMod.handleTelegramWebhook(makeWebhookReq(makeCallbackUpdate(5003, createBtn.callback_data, summary.messageId)), env),
        workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(5004, { text: '/confirm' })), env)
      ]);

      // Replay exact same update_id 5002 from Telegram
      const replayRes = await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(5002, createBtn.callback_data, summary.messageId)),
        env
      );
      assert.equal(replayRes.status, 200);
      assert.equal(await replayRes.text(), 'OK: Already Processed');

      // Sequential second tap on the same button after submission
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(5005, createBtn.callback_data, summary.messageId)),
        env
      );
      assert.match(tg.sent.at(-1).text, /hết hiệu lực|đã được tạo/i);

      assert.equal(ops.stats.createOrderCalls, 1, 'Double-tap + replay + concurrent /confirm must invoke createOrder ONCE');
      assert.equal((await pg.query('select count(*)::int as c from public.orders')).rows[0].c, 1);

      // --- Part B: OPS fails on first attempt, then lost-response timeout on second -> retry reuses fixed requestId ---
      let attempt = 0;
      const opsRetry = createLiveV33OpsFetcher(pg, supaOps, {
        beforeCreateOrder: async () => {
          attempt += 1;
          if (attempt === 1) {
            return new Response(JSON.stringify({ ok: false, message: 'OPS tạm lỗi 503' }), { status: 503 });
          }
          return null;
        },
        afterCreateOrder: async () => {
          // On attempt 2, OPS commits to PG, then simulates lost response (HTTP 502)
          if (attempt === 2) {
            return new Response('Bad Gateway', { status: 502 });
          }
          return null;
        }
      });
      const envRetry = { ...env, OPS_SERVICE: { fetch: opsRetry.fetcher } };

      await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(5101, {
        photo: [{ file_id: 'f2', file_unique_id: 'u2' }],
        caption: 'Khách Retry 0909654321\nmẫu: bó ly\nTổng 600k cọc 300k\n30/12 16h\nGhé lấy'
      })), envRetry);
      const retrySum1 = tg.sent.at(-1);
      const retryBtn1 = findButton(retrySum1, 'Tạo đơn');

      // Attempt 1: OPS returns 503 -> draft kept, fresh Tạo đơn button provided
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(5102, retryBtn1.callback_data, retrySum1.messageId)),
        envRetry
      );
      const errMsg1 = tg.sent.at(-1);
      assert.match(errMsg1.text, /Không thể tạo đơn|503/);
      const retryBtn2 = findButton(errMsg1, 'Tạo đơn');
      assert.ok(retryBtn2, 'Failed confirm must preserve draft and render a fresh Tạo đơn button for retry');

      // Attempt 2: OPS commits in DB, then response lost (502) -> draft kept with same requestId + fresh button
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(5103, retryBtn2.callback_data, errMsg1.messageId)),
        envRetry
      );
      const errMsg2 = tg.sent.at(-1);
      const retryBtn3 = findButton(errMsg2, 'Tạo đơn');
      assert.ok(retryBtn3);

      // Attempt 3: Retry via fresh Tạo đơn button -> same requestId hits mee_ops_lookup -> returns receipt cleanly with ZERO duplicates!
      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(5104, retryBtn3.callback_data, errMsg2.messageId)),
        envRetry
      );
      assert.equal(opsRetry.stats.createOrderCalls, 3);
      assert.equal(new Set(opsRetry.stats.requestIds).size, 1, 'All retries must reuse the exact same idempotency requestId');
      assert.equal((await pg.query('select count(*)::int as c from public.orders')).rows[0].c, 2, 'Exactly 1 order for Race + 1 order for Retry');
      assert.ok(findButton(tg.sent.at(-1), 'Tạo đơn khác'), 'Idempotent retry recovery succeeds and shows Tạo đơn khác');
    } finally {
      await pg.close();
    }
  });
});

describe('Inline Buttons 7: Deposit <50% Guard, Accessories Qty, Verbatim Caption & Webhook allowed_updates', () => {
  test('enforces >=50% deposit before showing Tạo đơn, preserves verbatim caption, and surfaces allowed_updates in /status', async () => {
    const { workerMod, supaOps } = await loadModules();
    const pg = await createPreMigrationOpsPg();
    try {
      const botD1 = createBotD1();
      const botR2 = createMockR2();
      const tg = createTelegramHarness();
      const ops = createLiveV33OpsFetcher(pg, supaOps);
      const outboundGemini = [];
      const env = {
        ENVIRONMENT: 'production', SERVICE_NAME: 'meehoa-order-bot',
        DB: botD1, MEDIA_R2: botR2, BOT_TOKEN: 'tok', TELEGRAM_SECRET_TOKEN: WEBHOOK_SECRET,
        ALLOWED_USER_IDS: String(OWNER_ID), OPS_API_URL: PROD_OPS_URL, OPS_TOKEN: CMUI_SESSION,
        OPS_SUPABASE_ANON_KEY: VALID_JWT, OPS_SERVICE: { fetch: ops.fetcher }, TELEGRAM_FETCHER: tg.fetcher,
        GEMINI_API_KEY: 'AIzaFakeFreeKey', GEMINI_MODEL: 'gemini-3.5-flash-lite',
        GEMINI_FETCHER: async (_u, init = {}) => {
          outboundGemini.push(String(init.body || ''));
          return new Response(`data: ${JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
              customer: 'Chị Hương', phone: '0909.555.666', flower: 'bó tulip vàng', flowerTotal: 500000,
              date: '29/12', time: '16:00', shipping: 'Ghé lấy', cardQty: 2, cardText: 'Chúc mừng', bannerQty: 1, bannerText: 'Khai trương'
            }) }] } }]
          })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        },
        GEMINI_OPTIONS: { maxRetries: 0, baseDelayMs: 0 }
      };

      // Photo + caption with <50% deposit (100k on 500k flower)
      await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(6001, {
        photo: [{ file_id: 'f1', file_unique_id: 'u1' }],
        caption: 'Chị Hương 0909.555.666 bó tulip vàng 500k, 2 thiệp Chúc mừng, 1 banner Khai trương, cọc 100k, 29/12 16h Ghé lấy'
      })), env);
      const badDepMsg = tg.sent.at(-1);
      assert.equal(findButton(badDepMsg, 'Tạo đơn'), null, 'Must NOT show Tạo đơn when deposit < 50% flowerTotal');
      assert.ok(outboundGemini.length === 0 || (outboundGemini[0].includes('0909.555.666') && !outboundGemini[0].includes('[PHONE_')));

      // Owner corrects deposit to 250k (exact 50%) -> Tạo đơn appears -> create order & check totals/debt
      await workerMod.handleTelegramWebhook(makeWebhookReq(makeMsgUpdate(6002, { text: 'cọc 250k' })), env);
      const okDepMsg = tg.sent.at(-1);
      const createBtn = findButton(okDepMsg, 'Tạo đơn');
      assert.ok(createBtn, 'Tạo đơn must appear once deposit reaches 50%');

      await workerMod.handleTelegramWebhook(
        makeWebhookReq(makeCallbackUpdate(6003, createBtn.callback_data, okDepMsg.messageId)),
        env
      );
      const row = (await pg.query('select *, public.mee_ops_total(orders) total, public.mee_ops_paid(orders) paid, public.mee_ops_debt(orders) debt from public.orders')).rows[0];
      assert.equal(row.sale, 'cmui');
      assert.equal(Number(row.total), 555000); // 500k + 2*10k + 1*35k
      assert.equal(Number(row.paid), 250000);
      assert.equal(Number(row.debt), 305000);

      // /status surfaces webhookInfo.allowed_updates including callback_query
      const statusRes = await (await workerMod.default.fetch(new Request('https://meehoa-order-bot.meehoasg.workers.dev/status'), env)).json();
      assert.deepEqual(statusRes.webhookInfo.allowed_updates, ['message', 'callback_query']);

      // activate-webhook.sh requests both message and callback_query
      const activateScript = fs.readFileSync(path.join(ROOT, 'order-bot/cloudflare/activate-webhook.sh'), 'utf8');
      assert.ok(activateScript.includes('"allowed_updates":["message","callback_query"]'));
    } finally {
      await pg.close();
    }
  });
});
