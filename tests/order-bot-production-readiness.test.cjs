const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function loadModules() {
  const [opsClient, workerMod, geminiMod, coreMod, d1Store, supaOps] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/ops-client.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/worker.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/gemini.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/core.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/d1-store.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'supabase/functions/_shared/operations.js')).href)
  ]);
  return { opsClient, workerMod, geminiMod, coreMod, d1Store, supaOps };
}

/**
 * Create an isolated Bot-only D1 (SQLite) matching `meehoa-order-bot-prod`
 * (contains ONLY bot_drafts, bot_processed_updates, bot_audit_logs — NO OPS `orders` table!).
 */
function createBotOnlyD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(ROOT, 'order-bot/cloudflare/schema.sql'), 'utf8'));
  return {
    sqlite,
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
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts) {
      const buf = value instanceof ArrayBuffer ? new Uint8Array(value) : (value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));
      objects.set(key, { body: buf, httpMetadata: opts?.httpMetadata || {} });
      return { key };
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { key, body: o.body, httpMetadata: o.httpMetadata, async arrayBuffer() { return o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength); } };
    },
    async delete(key) { objects.delete(key); }
  };
}

function makeWebhookReq(update, secret = 'prod_webhook_secret_64hex') {
  return new Request('https://meehoa-order-bot.meehoasg.workers.dev/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret
    },
    body: JSON.stringify(update)
  });
}

/**
 * Boot an isolated PGlite PostgreSQL instance matching the exact Production OPS schema.
 * When `includeUnverifiedBillMigrations = false`, matches LIVE Production `zxnfhshnavbmvdthrmrd`
 * BEFORE `20261121120000_unverified_bill_urls.sql` and `20261127000000_preserve_unverified_order_evidence.sql`.
 */
async function createIsolatedProdPg({ includeUnverifiedBillMigrations = false } = {}) {
  const db = new PGlite();
  await db.exec(
    'create role anon; create role authenticated; create role service_role; ' +
    'create schema storage; ' +
    'create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);'
  );
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  if (!includeUnverifiedBillMigrations) {
    await db.exec('alter table public.orders drop column if exists unverified_bill_urls;');
  }
  const migrationFiles = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).sort();
  for (const f of migrationFiles) {
    const isUnverifiedMig = f.startsWith('20261121120000_') || f.startsWith('20261127000000_');
    if (isUnverifiedMig && !includeUnverifiedBillMigrations) continue;
    await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8'));
  }
  await db.exec(
    "insert into public.app_users(username, password_hash, display_name, role, active) values " +
    "('admin', 'hash-admin', 'Meehoa_Manage', 'ADMIN', true), " +
    "('cmui', 'hash-cmui', 'C Mụi', 'THO_OPS', true), " +
    "('hien', 'hash-hien', 'Hiền', 'SALE', true);"
  );
  return db;
}

/**
 * Build a simulated Supabase Edge Gateway (`verify_jwt: true`) + `meehoasg-api-core` app layer
 * backed by an isolated PGlite database.
 */
function createProdSupabaseEdgeMock({ db, supaOps, validGatewayJwt }) {
  const stats = { gatewayRejects: 0, appExecs: 0, opsCalls: [], uploadedSamples: [], uploadedBills: [] };

  const decorateRow = async (row) => {
    const fin = (await db.query(
      'select public.mee_ops_total(o) as total_due, public.mee_ops_paid(o) as paid, public.mee_ops_debt(o) as debt from public.orders o where o.id = $1',
      [row.id]
    )).rows[0];
    const isoDate = row.order_date instanceof Date ? row.order_date.toISOString().slice(0, 10) : String(row.order_date || '');
    const isoUpdatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || '');
    return {
      id: row.id,
      updatedAt: isoUpdatedAt,
      customer: row.customer,
      phone: row.phone,
      date: isoDate,
      time: String(row.order_time || '').slice(0, 5),
      flower: row.flower,
      note: row.note,
      shipping: row.shipping,
      address: row.address,
      flowerTotal: Number(row.flower_total),
      payment: row.payment,
      paid: Number(fin.paid),
      debt: Number(fin.debt),
      totalDue: Number(fin.total_due),
      sale: row.sale,
      saleUsername: row.sale,
      settled: Boolean(row.settled),
      fullPaid: Boolean(row.full_paid),
      fullPaidBillUrls: row.full_paid_bill_urls || [],
      unverifiedBillUrls: row.unverified_bill_urls || [],
      imageUrls: (row.image_urls || []).map((u) => `https://r2-signed.local/${encodeURIComponent(u)}`),
      driveUrls: row.image_urls || [],
      banner: Boolean(row.banner),
      bannerQty: Number(row.banner_qty),
      bannerText: row.banner_text || '',
      card: Boolean(row.card),
      cardQty: Number(row.card_qty),
      cardText: row.card_text || '',
      charmFee: Number(row.charm_fee || 0),
      charmText: row.charm_text || '',
      paperFee: Number(row.paper_fee || 0),
      paperText: row.paper_text || '',
      vat: Number(row.vat || 0),
      shipFee: Number(row.ship_fee),
      shipConfirmed: Boolean(row.ship_confirmed)
    };
  };

  const fetcher = async (url, init = {}) => {
    const hdrs = init.headers || {};
    const authHeader = hdrs.Authorization || hdrs.authorization || '';
    const apiKeyHeader = hdrs.apikey || '';

    // 1. Supabase Edge Gateway verify_jwt layer (runs BEFORE Edge Function code)
    if (authHeader !== `Bearer ${validGatewayJwt}` || apiKeyHeader !== validGatewayJwt) {
      stats.gatewayRejects += 1;
      return new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. meehoasg-api-core app layer
    stats.appExecs += 1;
    const body = JSON.parse(init.body || '{}');
    const name = body.name;
    const payload = body.payload || {};
    stats.opsCalls.push({ url, name, headers: hdrs, orderPayload: payload.order || null, requestId: payload.requestId || null });

    const token = String(payload.token || '').trim();
    const sess = (await db.query(
      'select s.username, s.expires_at, u.display_name, u.role, u.active from public.app_sessions s join public.app_users u on u.username = s.username where s.token_hash = $1 limit 1',
      [hash(token)]
    )).rows[0];
    if (!sess || !sess.active || new Date(sess.expires_at).getTime() <= Date.now()) {
      return new Response(JSON.stringify({ ok: false, code: 'AUTH_REQUIRED', message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const user = { username: sess.username, display_name: sess.display_name, role: sess.role, active: sess.active };

    if (name === 'getOrderRules') {
      const rules = await supaOps.loadOrderRules(null, {});
      return new Response(JSON.stringify({
        ok: true,
        rules,
        caller: {
          username: user.username,
          role: user.role,
          canAssignDefaultSale: user.role !== 'SALE' || user.username === 'cmui'
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (name === 'getOrder') {
      const row = (await db.query('select * from public.orders where id = $1', [String(payload.orderId || '').trim()])).rows[0];
      if (!row) return new Response(JSON.stringify({ ok: false, code: 'NOT_FOUND', message: 'Không tìm thấy đơn.' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, order: await decorateRow(row) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (name === 'createOrder' || name === 'updateOrder') {
      const opService = supaOps.createOperationService({
        db: async (endpoint, _q, _m, rpcBody) => {
          if (endpoint === 'rpc/mee_ops_lookup') {
            return (await db.query('select public.mee_ops_lookup($1,$2,$3,$4) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint])).rows[0].res;
          }
          if (endpoint === 'rpc/mee_ops_mutate') {
            return (await db.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint, JSON.stringify(rpcBody.p_input)])).rows[0].res;
          }
          throw new Error(`Unexpected RPC ${endpoint}`);
        },
        one: async (table, query) => {
          if (table === 'orders' && query.id?.startsWith('eq.')) {
            return (await db.query('select * from public.orders where id = $1', [query.id.slice(3)])).rows[0] || null;
          }
          return null;
        },
        uploadImages: async (files, bucket) => files.map((_, i) => {
          const uri = `r2://meehoasg-website-media/${bucket}/${crypto.randomUUID()}.jpg`;
          if (bucket === 'order-images') stats.uploadedSamples.push(uri);
          else stats.uploadedBills.push(uri);
          return uri;
        }),
        sha256: async (s) => hash(s),
        newId: (prefix) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
      });
      const result = await opService.run(name, payload, user);
      if (result.ok && result.orderId) {
        const committedRow = result.row || (await db.query('select * from public.orders where id = $1', [result.orderId])).rows[0];
        if (committedRow) result.order = await decorateRow(committedRow);
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: false, code: 'UNSUPPORTED' }), { status: 400 });
  };

  return { fetcher, stats };
}

describe('Production Readiness 1: Core Bot V1 Flow on Live-Equivalent PostgreSQL WITHOUT 20261121120000 & 20261127000000', () => {
  test('executes full sample photo + caption -> draft -> /confirm -> OPS createOrder + deposit + retry + getOrder + sample image + OPS Full Paid with ZERO dependency on unverified_bill_urls migrations', async () => {
    const { opsClient, workerMod, d1Store, supaOps } = await loadModules();
    // Exact current live Production PostgreSQL schema: NO 20261121120000, NO 20261127000000!
    const pg = await createIsolatedProdPg({ includeUnverifiedBillMigrations: false });
    const botD1 = createBotOnlyD1();
    const botR2 = createMockR2();

    try {
      // Confirm live pre-migration state: unverified_bill_urls column does NOT exist
      const colCheck = await pg.query(
        "select column_name from information_schema.columns where table_schema='public' and table_name='orders' and column_name='unverified_bill_urls'"
      );
      assert.equal(colCheck.rows.length, 0, 'Pre-migration Production DB must NOT have unverified_bill_urls');

      const VALID_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.prod_sig';
      const CMUI_SESSION = 'a'.repeat(64);
      const PROD_OPS_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-api-core';

      await pg.query(
        "insert into public.app_sessions(token_hash, username, expires_at) values ($1, 'cmui', now() + interval '30 days')",
        [hash(CMUI_SESSION)]
      );

      const { fetcher: opsFetcher, stats } = createProdSupabaseEdgeMock({ db: pg, supaOps, validGatewayJwt: VALID_JWT });
      const sentTg = [];
      let capturedGeminiBody = '';

      const tgFetcher = async (url, init = {}) => {
        if (String(url).includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/flower_sample.jpg', file_size: 1024 } }));
        }
        if (String(url).includes('/file/bot')) {
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), { headers: { 'content-type': 'image/jpeg' } });
        }
        if (String(url).includes('/sendMessage')) {
          sentTg.push(JSON.parse(init.body || '{}'));
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response('Not found', { status: 404 });
      };

      const geminiFetcher = async (_url, init = {}) => {
        capturedGeminiBody = String(init.body || '');
        const sse = `data: ${JSON.stringify({
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [{
                text: JSON.stringify({
                  customer: 'Lan Anh',
                  phone: '[PHONE_1]',
                  flower: 'kệ chúc mừng tông vàng',
                  flowerTotal: 500000,
                  paymentState: 'deposit',
                  depositAmount: 250000,
                  date: '29/12',
                  time: '16:00',
                  shipping: 'Shop book ship',
                  banner: true,
                  bannerQty: 2,
                  bannerText: 'Khai trương hồng phát'
                })
              }]
            }
          }]
        })}\n\n`;
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };

      const env = {
        ENVIRONMENT: 'production',
        SERVICE_NAME: 'meehoa-order-bot',
        DB: botD1,
        MEDIA_R2: botR2,
        BOT_TOKEN: 'prod_bot_token_fake',
        TELEGRAM_SECRET_TOKEN: 'prod_webhook_secret_64hex',
        ALLOWED_USER_IDS: '5252724920',
        OPS_API_URL: PROD_OPS_URL,
        OPS_TOKEN: CMUI_SESSION,
        OPS_SUPABASE_ANON_KEY: VALID_JWT,
        OPS_SERVICE: { fetch: opsFetcher },
        TELEGRAM_FETCHER: tgFetcher,
        GEMINI_API_KEY: 'fake_paid_gemini_key',
        GEMINI_MODEL: 'gemini-3.5-flash-lite',
        GEMINI_FETCHER: geminiFetcher
      };

      // Step 1: Sample flower photo + natural caption -> Bot creates pending draft
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 50001,
        message: {
          chat: { id: 5252724920, type: 'private' },
          from: { id: 5252724920 },
          photo: [{ file_id: 'sample_f1', file_unique_id: 'sample_u1' }],
          caption: 'Chị Lan Anh SĐT 0909.888.123 đặt kệ chúc mừng tông vàng 500k, đã cọc 250k, chiều 29/12 lúc 16h Shop book ship, kèm 2 banner: Khai trương hồng phát'
        }
      }), env);

      assert.ok(!capturedGeminiBody.includes('0909'), 'Raw phone must be masked before Gemini');
      assert.ok(capturedGeminiBody.includes('[PHONE_1]'), 'Placeholder [PHONE_1] must be sent to Gemini');
      assert.ok(!capturedGeminiBody.includes('inlineData'), 'Sample photo bytes must never be sent to Gemini');

      const drafts1 = await d1Store.loadDrafts(botD1, 5252724920);
      const d1 = drafts1[drafts1.__active];
      assert.equal(d1.status, 'pending');
      assert.equal(d1.fields.customer, 'Lan Anh');
      assert.equal(d1.fields.phone, '0909888123', 'Masked phone must be restored into draft');
      assert.equal(d1.fields.sale, 'cmui');
      assert.equal(d1.sampleRefs.length, 1);
      assert.equal(d1.draftBillRefs.length, 0);

      // Step 2: /confirm -> creates order on pre-migration Production PG with sample photo + deposit
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 50002,
        message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
      }), env);

      const drafts2 = await d1Store.loadDrafts(botD1, 5252724920);
      const d2 = drafts2[drafts2.__active];
      assert.equal(d2.status, 'submitted');
      assert.ok(d2.opsOrderId && d2.opsOrderId.startsWith('MEE-'));
      assert.equal(d2.paymentSynced, true);
      assert.equal(stats.uploadedSamples.length, 1, 'Sample photo must be uploaded to OPS order-images');
      assert.equal(stats.uploadedBills.length, 0, 'New-order /confirm must upload 0 unverified bills');

      const createCall = stats.opsCalls.find((c) => c.name === 'createOrder');
      assert.deepEqual(createCall.orderPayload.unverifiedBillFiles, [], 'createOrder must send empty unverifiedBillFiles');

      // Step 3: Read back order via OPS getOrder + verify sample photo, sale, bannerQty*35k, deposit, debt
      const readBack = await opsClient.callGetOrder(PROD_OPS_URL, CMUI_SESSION, d2.opsOrderId, opsFetcher, { opsApiKey: VALID_JWT });
      assert.equal(readBack.ok, true);
      assert.equal(readBack.order.saleUsername, 'cmui');
      assert.equal(readBack.order.flowerTotal, 500000);
      assert.equal(readBack.order.bannerQty, 2);
      assert.equal(readBack.order.totalDue, 570000);
      assert.equal(readBack.order.paid, 250000);
      assert.equal(readBack.order.debt, 320000);
      assert.equal(readBack.order.imageUrls.length, 1);
      assert.deepEqual(readBack.order.unverifiedBillUrls, []);

      // Step 4: Idempotent retry (repeat /confirm + direct createOrder with same requestId) -> 0 duplicate orders
      const opsCallsBeforeRepeat = stats.opsCalls.length;
      await workerMod.handleTelegramWebhook(makeWebhookReq({
        update_id: 50003,
        message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
      }), env);
      assert.equal(stats.opsCalls.length, opsCallsBeforeRepeat, 'Repeat /confirm on submitted draft must emit 0 OPS calls');

      const sampleExactDataUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')}`;
      const directRetry = await opsClient.callCreateOrder(PROD_OPS_URL, CMUI_SESSION, d2, [{ data: sampleExactDataUrl }], [], opsFetcher, { opsApiKey: VALID_JWT });
      assert.equal(directRetry.ok, true);
      assert.equal(directRetry.orderId, d2.opsOrderId);
      const countRows = (await pg.query('select count(*)::int as n from public.orders')).rows[0].n;
      assert.equal(countRows, 1, 'Idempotent retry must keep exactly 1 order row in PostgreSQL');

      // Step 5: Deposit update via syncOrderPaymentToOps (getOrder + updateOrder with OCC) -> succeeds without 2 migrations
      const paySync = await opsClient.syncOrderPaymentToOps({
        opsUrl: PROD_OPS_URL,
        opsToken: CMUI_SESSION,
        opsApiKey: VALID_JWT,
        orderId: d2.opsOrderId,
        expectedPayment: 'Đã cọc 300.000 đ',
        expectedPaid: 300000,
        requestId: `${d2.requestId}:pay-upd`,
        cleanNote: '',
        fetcher: opsFetcher
      });
      assert.equal(paySync.ok, true, JSON.stringify(paySync));
      assert.equal(paySync.order.paid, 300000);
      assert.equal(paySync.order.debt, 270000);

      // Step 6: Full Paid executed later directly at OPS (uses full_paid_bill_urls, NOT unverified_bill_urls) -> succeeds without 2 migrations
      const fpRes = await opsFetcher(PROD_OPS_URL, {
        method: 'POST',
        headers: opsClient.buildOpsHeaders(CMUI_SESSION, VALID_JWT),
        body: JSON.stringify({
          name: 'updateOrder',
          payload: {
            token: CMUI_SESSION,
            orderId: d2.opsOrderId,
            expectedUpdatedAt: paySync.order.updatedAt,
            requestId: `${d2.requestId}:ops-fullpaid`,
            order: {
              customer: paySync.order.customer,
              phone: paySync.order.phone,
              date: paySync.order.date,
              time: paySync.order.time,
              flower: paySync.order.flower,
              note: '',
              shipping: 'Shop book ship',
              address: '88 Võ Văn Tần, Quận 3',
              flowerTotal: 500000,
              payment: 'Đã thanh toán toàn bộ đơn',
              sale: 'cmui',
              banner: true,
              bannerQty: 2,
              bannerText: 'Khai trương hồng phát',
              shipFeeActive: '1',
              shipFee: 35000,
              fullPaidRequested: true,
              fullPaidBillFiles: [{ data: 'data:image/jpeg;base64,/9j/4AAQ' }]
            }
          }
        })
      });
      const fpJson = await fpRes.json();
      assert.equal(fpJson.ok, true, 'Full Paid at OPS must succeed on pre-migration schema using full_paid_bill_urls');
      assert.equal(fpJson.order.fullPaid, true);
      assert.equal(fpJson.order.debt, 0);
      assert.equal(fpJson.order.totalDue, 605000); // 500k + 70k + 35k ship
      assert.equal(fpJson.order.fullPaidBillUrls.length, 1);
    } finally {
      await pg.close();
    }
  });
});

describe('Production Readiness 2: Approved New-Order Bill Policy Regression (No Bills Attached in New Draft or /confirm)', () => {
  test('rejects bill photo attachment during new-order flow by default and guarantees /confirm never sends unverifiedBillFiles even on stale drafts', async () => {
    const { workerMod, d1Store } = await loadModules();
    const botD1 = createBotOnlyD1();
    const botR2 = createMockR2();
    const sentTg = [];
    const opsRequests = [];

    const tgFetcher = async (url, init = {}) => {
      if (String(url).includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/x.jpg', file_size: 512 } }));
      }
      if (String(url).includes('/file/bot')) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg' } });
      }
      if (String(url).includes('/sendMessage')) {
        sentTg.push(JSON.parse(init.body || '{}'));
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response('Not found', { status: 404 });
    };

    const opsFetcher = async (_url, init = {}) => {
      const body = JSON.parse(init.body || '{}');
      opsRequests.push(body);
      if (body.name === 'getOrderRules') {
        return new Response(JSON.stringify({ ok: true, rules: { schemaVersion: '2026-11-26.v3', phoneRequired: false, required: ['customer', 'flower', 'date', 'time', 'shipping', 'flowerTotal'], minDepositRatio: 0.5, conditionalRequired: [], conditionalReminders: [] } }));
      }
      if (body.name === 'createOrder') {
        return new Response(JSON.stringify({
          ok: true,
          orderId: 'MEE-NOBILL00000001',
          order: { id: 'MEE-NOBILL00000001', customer: 'Lan Anh', flower: 'Bó hồng', flowerTotal: 500000, totalDue: 500000, paid: 0, debt: 500000, sale: 'C Mụi', saleUsername: 'cmui' }
        }));
      }
      return new Response(JSON.stringify({ ok: true }));
    };

    const env = {
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'fake_tok',
      TELEGRAM_SECRET_TOKEN: 'prod_webhook_secret_64hex',
      ALLOWED_USER_IDS: '5252724920',
      OPS_API_URL: 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-api-core',
      OPS_TOKEN: 'a'.repeat(64),
      OPS_SUPABASE_ANON_KEY: 'jwt.mock.sig',
      OPS_SERVICE: { fetch: opsFetcher },
      TELEGRAM_FETCHER: tgFetcher
    };

    // 1. /new then try sending a bill photo -> must be refused cleanly, 0 R2 objects, 0 draftBillRefs
    await workerMod.handleTelegramWebhook(makeWebhookReq({
      update_id: 60001,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
    }), env);
    await workerMod.handleTelegramWebhook(makeWebhookReq({
      update_id: 60002,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'bill_f1', file_unique_id: 'bill_u1' }],
        caption: 'Bill chuyển khoản VCB 250k'
      }
    }), env);

    const draftsAfterBill = await d1Store.loadDrafts(botD1, 5252724920);
    const active = draftsAfterBill[draftsAfterBill.__active];
    assert.equal(active.draftBillRefs.length, 0, 'New-order flow must refuse attaching bill photos');
    assert.equal(botR2.objects.size, 0, 'Refused bill photo must NOT be stored in R2');
    assert.match(sentTg[sentTg.length - 1].text, /không đính kèm ảnh bill.*Full Paid/is);

    // 2. Even if a stale draft had legacy draftBillRefs seeded, /confirm must send unverifiedBillFiles: [] and never fail on missing D1 orders table
    active.fields = {
      customer: 'Lan Anh',
      flower: 'Bó hồng',
      date: '2026-12-29',
      time: '16:00',
      shipping: 'Ghé lấy',
      flowerTotal: '500000',
      sale: 'cmui'
    };
    active.draftBillRefs = [{ fileId: 'stale_bill', r2_key: 'settlement-bills/unverified-stale.jpg' }];
    await d1Store.saveDrafts(botD1, 5252724920, draftsAfterBill);

    await workerMod.handleTelegramWebhook(makeWebhookReq({
      update_id: 60003,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
    }), env);

    const createReq = opsRequests.find((r) => r.name === 'createOrder');
    assert.ok(createReq, 'createOrder must succeed');
    assert.deepEqual(createReq.payload.order.unverifiedBillFiles, [], '/confirm must NEVER send unverifiedBillFiles in default new-order flow');
    assert.ok(!String(createReq.payload.order.note || '').includes('bill chưa xác minh'));
  });
});

describe('Production Readiness 3: Supabase Gateway Auth vs OPS App Session & Role Separation', () => {
  test('enforces valid gateway JWT + cmui session, rejects missing JWT (401), expired session (AUTH_REQUIRED), and wrong role (SALE)', async () => {
    const { opsClient, workerMod, supaOps } = await loadModules();
    const pg = await createIsolatedProdPg({ includeUnverifiedBillMigrations: false });
    try {
      const VALID_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.mock_sig';
      const CMUI_SESSION = 'a'.repeat(64);
      const EXPIRED_SESSION = 'b'.repeat(64);
      const SALE_SESSION = 'c'.repeat(64);
      const PROD_OPS_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-api-core';

      await pg.query(
        "insert into public.app_sessions(token_hash, username, expires_at) values ($1, 'cmui', now() + interval '30 days'), ($2, 'cmui', now() - interval '1 hour'), ($3, 'hien', now() + interval '30 days')",
        [hash(CMUI_SESSION), hash(EXPIRED_SESSION), hash(SALE_SESSION)]
      );

      const { fetcher, stats } = createProdSupabaseEdgeMock({ db: pg, supaOps, validGatewayJwt: VALID_JWT });

      // Missing gateway JWT -> 401 BEFORE app executes
      const noJwt = await opsClient.checkOpsHealth(PROD_OPS_URL, CMUI_SESSION, fetcher, { opsApiKey: '' });
      assert.equal(noJwt.ok, false);
      assert.equal(noJwt.httpStatus, 401);
      assert.equal(noJwt.error, 'GATEWAY_UNAUTHORIZED');
      assert.equal(stats.gatewayRejects, 1);
      assert.equal(stats.appExecs, 0);

      // Valid gateway JWT + valid cmui session -> 200 OK
      const okHealth = await opsClient.checkOpsHealth(PROD_OPS_URL, CMUI_SESSION, fetcher, { opsApiKey: VALID_JWT });
      assert.equal(okHealth.ok, true);
      assert.equal(okHealth.authMode, 'supabase_gateway_jwt+app_session');
      assert.equal(okHealth.callerRole, 'THO_OPS');
      assert.equal(okHealth.schemaVersion, '2026-11-26.v3');

      // Valid gateway JWT + expired cmui session -> AUTH_REQUIRED
      const expHealth = await opsClient.checkOpsHealth(PROD_OPS_URL, EXPIRED_SESSION, fetcher, { opsApiKey: VALID_JWT });
      assert.equal(expHealth.ok, false);
      assert.equal(expHealth.error, 'AUTH_REQUIRED');

      // Wrong role: SALE (`hien`) cannot assign `cmui` and cannot edit `cmui`'s order (`NOT_OWNER`)
      const draft = {
        id: 'draft-role-1',
        requestId: 'req-role-cmui',
        fields: {
          customer: 'Lan Anh', phone: '0909888123', date: '2026-12-29', time: '16:00',
          flower: 'Kệ vàng', shipping: 'Shop book ship', address: '', flowerTotal: '500000',
          paymentState: 'deposit', depositAmount: '250000', sale: 'cmui'
        }
      };
      const cmuiOrder = await opsClient.callCreateOrder(PROD_OPS_URL, CMUI_SESSION, draft, [], [], fetcher, { opsApiKey: VALID_JWT });
      assert.equal(cmuiOrder.ok, true);
      assert.equal(cmuiOrder.order.saleUsername, 'cmui');

      const saleRules = await opsClient.fetchOpsOrderRules(PROD_OPS_URL, SALE_SESSION, fetcher, { forceRefresh: true, opsApiKey: VALID_JWT });
      assert.equal(saleRules.caller.role, 'SALE');
      assert.equal(saleRules.caller.canAssignDefaultSale, false);

      const saleOrder = await opsClient.callCreateOrder(PROD_OPS_URL, SALE_SESSION, { ...draft, requestId: 'req-role-sale' }, [], [], fetcher, { opsApiKey: VALID_JWT });
      assert.equal(saleOrder.ok, true);
      assert.equal(saleOrder.order.saleUsername, 'hien');

      const saleEdit = await opsClient.callUpdateOrderPayment(PROD_OPS_URL, SALE_SESSION, cmuiOrder.orderId, cmuiOrder.order, 'Đã cọc 300.000 đ', 'req-role-edit', '', fetcher, { opsApiKey: VALID_JWT });
      assert.equal(saleEdit.ok, false);
      assert.equal(saleEdit.code, 'NOT_OWNER');

      // /status reports Production state without leaking secrets
      const statusRes = await workerMod.default.fetch(new Request('https://meehoa-order-bot.meehoasg.workers.dev/status'), {
        ENVIRONMENT: 'production',
        SERVICE_NAME: 'meehoa-order-bot',
        OPS_API_URL: PROD_OPS_URL,
        OPS_TOKEN: CMUI_SESSION,
        OPS_SUPABASE_ANON_KEY: VALID_JWT,
        OPS_SERVICE: { fetch: fetcher },
        GEMINI_API_KEY: 'secret-never-shown',
        GEMINI_MODEL: 'gemini-3.5-flash-lite',
        TELEGRAM_SECRET_TOKEN: 'secret-webhook',
        MEDIA_R2: {},
        DB: { prepare: () => ({ first: async () => ({ alive: 1 }), all: async () => ({ results: [] }) }) }
      });
      const statusJson = await statusRes.json();
      assert.equal(statusJson.ok, true);
      assert.equal(statusJson.environment, 'production');
      assert.equal(statusJson.opsConnected, true);
      const rawStatus = JSON.stringify(statusJson);
      assert.ok(!rawStatus.includes(VALID_JWT) && !rawStatus.includes(CMUI_SESSION) && !rawStatus.includes('secret-never-shown'));
    } finally {
      await pg.close();
    }
  });
});

describe('Production Readiness 4: Form + API + Bot Rule Parity on Pre-Migration Production PG', () => {
  test('verifies all 7 approved rules across Form html, API operations.js/PG, and Bot core.mjs', async () => {
    const { coreMod, supaOps } = await loadModules();
    const pg = await createIsolatedProdPg({ includeUnverifiedBillMigrations: false });
    try {
      const cmuiUser = { username: 'cmui', display_name: 'C Mụi', role: 'THO_OPS', active: true };
      const opService = supaOps.createOperationService({
        db: async (endpoint, _q, _m, rpcBody) => {
          if (endpoint === 'rpc/mee_ops_lookup') {
            return (await pg.query('select public.mee_ops_lookup($1,$2,$3,$4) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint])).rows[0].res;
          }
          if (endpoint === 'rpc/mee_ops_mutate') {
            return (await pg.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint, JSON.stringify(rpcBody.p_input)])).rows[0].res;
          }
          throw new Error(endpoint);
        },
        one: async () => null,
        uploadImages: async (files, bucket) => files.map((_, i) => `r2://meehoasg-website-media/${bucket}/img-${i}.jpg`),
        sha256: async (s) => hash(s),
        newId: (prefix) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
      });

      const baseOrder = {
        customer: 'Chị Hương', phone: '0909111222', date: '2026-12-29', time: '16:00',
        flower: 'Bó tulip trắng', shipping: 'Shop book ship', address: '', flowerTotal: 350000,
        payment: 'Chưa thanh toán (0 đ)', sale: 'cmui', card: false, banner: false, shipFeeActive: '0', shipFee: 0
      };

      const zeroFlower = await opService.run('createOrder', { requestId: 'p4-1', order: { ...baseOrder, flowerTotal: 0 } }, cmuiUser);
      assert.equal(zeroFlower.code, 'FLOWER_TOTAL_REQUIRED');

      const lowDep = await opService.run('createOrder', {
        requestId: 'p4-2',
        order: { ...baseOrder, payment: 'Đã cọc 174.999 đ', shipFeeActive: '1', shipFee: 100000, card: true, cardQty: 1, cardText: 'A', banner: true, bannerQty: 1, bannerText: 'B' }
      }, cmuiUser);
      assert.equal(lowDep.code, 'DEPOSIT_BELOW_MIN_RATIO');

      const ok = await opService.run('createOrder', {
        requestId: 'p4-3',
        order: { ...baseOrder, payment: 'Đã cọc 175.000 đ', card: true, cardQty: 3, cardText: 'Thiệp', banner: true, bannerQty: 2, bannerText: 'Banner' }
      }, cmuiUser);
      assert.equal(ok.ok, true);
      const fin = (await pg.query('select public.mee_ops_total(o) as total_due, public.mee_ops_paid(o) as paid, public.mee_ops_debt(o) as debt from public.orders o where o.id = $1', [ok.orderId])).rows[0];
      assert.equal(Number(fin.total_due), 450000);
      assert.equal(Number(fin.paid), 175000);
      assert.equal(Number(fin.debt), 275000);

      // Bot validation with Production v3 rules: missing address is reminder-only
      const v = coreMod.validateOrderAgainstRules({
        fields: { customer: 'Hương', flower: 'Tulip', date: '2026-12-29', time: '16:00', shipping: 'Shop book ship', address: '', flowerTotal: '350000', sale: 'cmui' }
      }, supaOps.ORDER_VALIDATION_RULES);
      assert.deepEqual(v.missing, []);
      assert.ok(v.reminders.length > 0);

      // Full Paid guards
      const fpNoBill = await opService.run('createOrder', { requestId: 'p4-4', order: { ...baseOrder, fullPaidRequested: true, imageFiles: [{ data: 'data:image/jpeg;base64,AA==' }], shipFeeActive: '1', shipFee: 35000 } }, cmuiUser);
      assert.equal(fpNoBill.code, 'FULL_PAID_EVIDENCE_REQUIRED');
      const fpNoShip = await opService.run('createOrder', { requestId: 'p4-5', order: { ...baseOrder, fullPaidRequested: true, imageFiles: [{ data: 'data:image/jpeg;base64,AA==' }], fullPaidBillFiles: [{ data: 'data:image/jpeg;base64,BB==' }], shipFeeActive: '0' } }, cmuiUser);
      assert.equal(fpNoShip.code, 'FULL_PAID_EVIDENCE_REQUIRED');

      // Production Form HTML checks
      const prodHtml = fs.readFileSync(path.join(ROOT, 'html'), 'utf8');
      assert.ok(prodHtml.includes("gas('getOrderRules')"));
      assert.ok(prodHtml.includes('Tiền hoa bắt buộc và phải lớn hơn 0 đ.'));
      assert.ok(prodHtml.includes('bannerQty*35000') && prodHtml.includes('qty*10000'));
      assert.ok(prodHtml.includes("form.querySelector('[name=\"phone\"]')"));
    } finally {
      await pg.close();
    }
  });
});

describe('Production Readiness 5: AI Local Phone PII Masking Across Success, AI Error Fallback, and /reparse', () => {
  test('never sends raw phone to Gemini on failure or /reparse, preserves exact phone in draft on 503 fallback, and restores cleanly on /reparse', async () => {
    const { workerMod, d1Store } = await loadModules();
    const botD1 = createBotOnlyD1();
    const botR2 = createMockR2();
    const outboundGeminiBodies = [];
    let aiMode = 'fail503';

    const tgFetcher = async (url) => {
      if (String(url).includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/flower.jpg', file_size: 512 } }));
      if (String(url).includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg' } });
      if (String(url).includes('/sendMessage')) return new Response(JSON.stringify({ ok: true }));
      return new Response('Not found', { status: 404 });
    };

    const geminiFetcher = async (_url, init = {}) => {
      outboundGeminiBodies.push(String(init.body || ''));
      if (aiMode === 'fail503') {
        return new Response(JSON.stringify({ error: { code: 503, message: 'High demand' } }), { status: 503 });
      }
      const sse = `data: ${JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: {
            parts: [{
              text: JSON.stringify({
                customer: 'Thảo My',
                phone: '[PHONE_1]',
                flower: 'kệ chúc mừng tông vàng',
                flowerTotal: 650000,
                date: '29/12',
                time: '16:00',
                shipping: 'Shop book ship',
                address: '88 Võ Văn Tần quận 3'
              })
            }]
          }
        }]
      })}\n\n`;
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    const env = {
      DB: botD1,
      MEDIA_R2: botR2,
      BOT_TOKEN: 'fake_tok',
      TELEGRAM_SECRET_TOKEN: 'prod_webhook_secret_64hex',
      ALLOWED_USER_IDS: '5252724920',
      TELEGRAM_FETCHER: tgFetcher,
      GEMINI_API_KEY: 'fake_paid_key',
      GEMINI_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_FETCHER: geminiFetcher,
      GEMINI_OPTIONS: { maxRetries: 0, baseDelayMs: 0 }
    };

    // 1. Send photo + caption with formatted phone while Gemini is returning 503
    await workerMod.handleTelegramWebhook(makeWebhookReq({
      update_id: 70001,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'f_ai_err', file_unique_id: 'u_ai_err' }],
        caption: 'Khách Thảo My SĐT +84 909.888.123 đặt kệ chúc mừng tông vàng 650k, chiều 29/12 lúc 16h shop giao qua 88 Võ Văn Tần quận 3'
      }
    }), env);

    assert.equal(outboundGeminiBodies.length, 1);
    assert.ok(!outboundGeminiBodies[0].includes('909'), 'Raw phone must NOT leak to Gemini even on failed 503 request');
    assert.ok(outboundGeminiBodies[0].includes('[PHONE_1]'));

    // Local fallback on AI failure MUST still capture normalized phone into draft & keep pendingAiText
    const draftsAfterFail = await d1Store.loadDrafts(botD1, 5252724920);
    const failedDraft = draftsAfterFail[draftsAfterFail.__active];
    assert.equal(failedDraft.fields.phone, '0909888123', 'Local fallback must preserve exact phone into draft when AI returns 503');
    assert.ok(failedDraft.pendingAiText && failedDraft.pendingAiText.includes('909'), 'pendingAiText kept locally in D1 for /reparse');

    // 2. Gemini recovers -> user runs /reparse -> raw phone STILL masked on /reparse, restored cleanly along with all AI fields
    aiMode = 'ok';
    await workerMod.handleTelegramWebhook(makeWebhookReq({
      update_id: 70002,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/reparse' }
    }), env);

    assert.equal(outboundGeminiBodies.length, 2);
    assert.ok(!outboundGeminiBodies[1].includes('909'), 'Raw phone must NOT leak to Gemini during /reparse');
    assert.ok(outboundGeminiBodies[1].includes('[PHONE_1]'));
    assert.ok(!outboundGeminiBodies[1].includes('inlineData'), 'Photos must never be sent to Gemini during /reparse');

    const draftsAfterReparse = await d1Store.loadDrafts(botD1, 5252724920);
    const reparsedDraft = draftsAfterReparse[draftsAfterReparse.__active];
    assert.equal(reparsedDraft.fields.phone, '0909888123');
    assert.equal(reparsedDraft.fields.customer, 'Thảo My');
    assert.equal(reparsedDraft.fields.flower, 'kệ chúc mừng tông vàng');
    assert.equal(reparsedDraft.fields.flowerTotal, '650000');
    assert.equal(reparsedDraft.fields.address, '88 Võ Văn Tần quận 3');
  });
});

describe('Production Readiness 6: wrangler.production.toml Anti-Staging-Leakage Contract', () => {
  test('points strictly to dedicated Production resources with zero Staging leakage', () => {
    const prodTomlPath = path.join(ROOT, 'order-bot/cloudflare/wrangler.production.toml');
    assert.ok(fs.existsSync(prodTomlPath), 'wrangler.production.toml must exist');
    const content = fs.readFileSync(prodTomlPath, 'utf8');

    assert.match(content, /^name\s*=\s*"meehoa-order-bot"$/m);
    assert.match(content, /^workers_dev\s*=\s*true$/m);
    assert.match(content, /^ENVIRONMENT\s*=\s*"production"$/m);
    assert.match(content, /^OPS_API_URL\s*=\s*"https:\/\/zxnfhshnavbmvdthrmrd\.supabase\.co\/functions\/v1\/meehoasg-api-core"$/m);
    assert.match(content, /^ALLOWED_USER_IDS\s*=\s*"5252724920"$/m);
    assert.match(content, /^GEMINI_MODEL\s*=\s*"gemini-3\.5-flash-lite"$/m);
    assert.match(content, /^database_name\s*=\s*"meehoa-order-bot-prod"$/m);
    assert.match(content, /^bucket_name\s*=\s*"meehoa-order-bot-media-prod"$/m);

    const activeLines = content.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/staging/i.test(activeLines), 'Active config lines must contain zero staging references');
    assert.ok(!activeLines.includes('16bf0134-64c6-43ea-8098-b40c95251667'), 'Must never bind Staging D1 ID');
    assert.ok(!activeLines.includes('meehoasg-media-staging'), 'Must never bind Staging R2 bucket');
    assert.ok(!activeLines.includes('c483e22ad8c546c5bdf4f6711098fd04'), 'Must never bind Staging KV ID');
    assert.ok(!activeLines.includes('OPS_SERVICE'), 'Must never bind Cloudflare Staging OPS_SERVICE');
  });
});
