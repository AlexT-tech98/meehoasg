const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function loadModules() {
  const [opsClient, workerMod, geminiMod, coreMod, supaOps] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/ops-client.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/worker.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/cloudflare/gemini.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'order-bot/core.mjs')).href),
    import(pathToFileURL(path.join(ROOT, 'supabase/functions/_shared/operations.js')).href)
  ]);
  return { opsClient, workerMod, geminiMod, coreMod, supaOps };
}

/**
 * Boot an isolated PGlite PostgreSQL instance matching the exact Production OPS schema.
 * @param {object} opts
 * @param {boolean} [opts.includeUnverifiedBillMigrations=true] - Toggle 20261121120000 & 20261127000000
 */
async function createIsolatedProdPg({ includeUnverifiedBillMigrations = true } = {}) {
  const db = new PGlite();
  await db.exec(
    'create role anon; create role authenticated; create role service_role; ' +
    'create schema storage; ' +
    'create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);'
  );
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  if (!includeUnverifiedBillMigrations) {
    // Match exact live Production zxnfhshnavbmvdthrmrd pre-migration table (column not yet added)
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

describe('Production Readiness 1: Supabase Gateway Auth vs OPS App Session Separation', () => {
  test('separates Supabase Gateway JWT (apikey + Authorization) from opaque OPS app session (payload.token), enforcing valid, expired-session, and wrong-role paths', async () => {
    const { opsClient, workerMod, supaOps } = await loadModules();
    const db = await createIsolatedProdPg({ includeUnverifiedBillMigrations: true });
    try {
      const VALID_GATEWAY_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.mock_sig';
      const CMUI_SESSION = 'a'.repeat(64);
      const EXPIRED_SESSION = 'b'.repeat(64);
      const SALE_SESSION = 'c'.repeat(64);
      const PROD_OPS_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-api-core';

      await db.query(
        "insert into public.app_sessions(token_hash, username, expires_at) values ($1, 'cmui', now() + interval '30 days'), ($2, 'cmui', now() - interval '1 hour'), ($3, 'hien', now() + interval '30 days')",
        [hash(CMUI_SESSION), hash(EXPIRED_SESSION), hash(SALE_SESSION)]
      );

      let gatewayRejectCount = 0;
      let appExecCount = 0;
      const recordedHeaders = [];

      // Simulated Supabase Edge Gateway (verify_jwt: true) + meehoasg-api-core app layer backed by real PGlite
      const prodGatewayFetcher = async (url, init = {}) => {
        const hdrs = init.headers || {};
        recordedHeaders.push({ url, method: init.method, headers: hdrs });

        // 1. Supabase Gateway verify_jwt layer (runs BEFORE Edge Function code)
        const authHeader = hdrs.Authorization || hdrs.authorization || '';
        const apiKeyHeader = hdrs.apikey || '';
        if (authHeader !== `Bearer ${VALID_GATEWAY_JWT}` || apiKeyHeader !== VALID_GATEWAY_JWT) {
          gatewayRejectCount += 1;
          return new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // 2. Application layer: meehoasg-api-core session check
        appExecCount += 1;
        const body = JSON.parse(init.body || '{}');
        const name = body.name;
        const payload = body.payload || {};
        const token = String(payload.token || '').trim();
        const sessRes = await db.query(
          'select s.username, s.expires_at, u.display_name, u.role, u.active from public.app_sessions s join public.app_users u on u.username = s.username where s.token_hash = $1 limit 1',
          [hash(token)]
        );
        const sess = sessRes.rows[0];
        if (!sess || !sess.active || new Date(sess.expires_at).getTime() <= Date.now()) {
          return new Response(JSON.stringify({ ok: false, code: 'AUTH_REQUIRED', message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const user = { username: sess.username, display_name: sess.display_name, role: sess.role, active: sess.active };

        if (name === 'getOrderRules') {
          const rules = supaOps.buildOrderRules({});
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

        if (name === 'createOrder' || name === 'updateOrder') {
          const opService = supaOps.createOperationService({
            db: async (endpoint, _q, _m, rpcBody) => {
              if (endpoint === 'rpc/mee_ops_lookup') {
                const r = await db.query('select public.mee_ops_lookup($1,$2,$3,$4) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint]);
                return r.rows[0].res;
              }
              if (endpoint === 'rpc/mee_ops_mutate') {
                const r = await db.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint, JSON.stringify(rpcBody.p_input)]);
                return r.rows[0].res;
              }
              throw new Error(`Unexpected endpoint ${endpoint}`);
            },
            one: async (table, query) => {
              if (table === 'orders' && query.id?.startsWith('eq.')) {
                const r = await db.query('select * from public.orders where id = $1', [query.id.slice(3)]);
                return r.rows[0] || null;
              }
              return null;
            },
            uploadImages: async (files, bucket) => files.map((_, i) => `r2://meehoasg-website-media/${bucket}/mock-${Date.now()}-${i}.jpg`),
            sha256: async (s) => hash(s),
            newId: (prefix) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
          });
          const result = await opService.run(name, payload, user);
          if (result.ok && result.row) {
            const totRes = await db.query(
              'select public.mee_ops_total(o) as total_due, public.mee_ops_paid(o) as paid, public.mee_ops_debt(o) as debt from public.orders o where o.id = $1',
              [result.row.id]
            );
            const row = result.row;
            const fin = totRes.rows[0];
            result.order = {
              id: row.id,
              updatedAt: row.updated_at,
              customer: row.customer,
              phone: row.phone,
              date: row.order_date,
              time: row.order_time,
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
              banner: row.banner,
              bannerQty: Number(row.banner_qty),
              card: row.card,
              cardQty: Number(row.card_qty),
              shipFee: Number(row.ship_fee),
              shipConfirmed: Boolean(row.ship_confirmed),
              unverifiedBillUrls: row.unverified_bill_urls || []
            };
          }
          return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        return new Response(JSON.stringify({ ok: false, code: 'UNSUPPORTED' }), { status: 400 });
      };

      // Case A: Missing Gateway JWT (legacy Staging header style) -> Gateway MUST reject 401 BEFORE app executes
      const noJwtHealth = await opsClient.checkOpsHealth(PROD_OPS_URL, CMUI_SESSION, prodGatewayFetcher, { opsApiKey: '' });
      assert.equal(noJwtHealth.ok, false);
      assert.equal(noJwtHealth.httpStatus, 401);
      assert.equal(noJwtHealth.error, 'GATEWAY_UNAUTHORIZED');
      assert.equal(gatewayRejectCount, 1);
      assert.equal(appExecCount, 0);

      // Case B: Valid Gateway JWT + valid cmui THO_OPS session -> 200 OK
      const validHealth = await opsClient.checkOpsHealth(PROD_OPS_URL, CMUI_SESSION, prodGatewayFetcher, { opsApiKey: VALID_GATEWAY_JWT });
      assert.equal(validHealth.ok, true);
      assert.equal(validHealth.authMode, 'supabase_gateway_jwt+app_session');
      assert.equal(validHealth.schemaVersion, '2026-11-26.v3');
      assert.equal(validHealth.callerRole, 'THO_OPS');
      const lastHdr = recordedHeaders[recordedHeaders.length - 1].headers;
      assert.equal(lastHdr.apikey, VALID_GATEWAY_JWT);
      assert.equal(lastHdr.Authorization, `Bearer ${VALID_GATEWAY_JWT}`);
      assert.notEqual(lastHdr.Authorization, `Bearer ${CMUI_SESSION}`, 'App session token must NEVER be placed in Supabase Gateway Authorization header');

      // Case C: Valid Gateway JWT + EXPIRED cmui session -> AUTH_REQUIRED
      const expiredHealth = await opsClient.checkOpsHealth(PROD_OPS_URL, EXPIRED_SESSION, prodGatewayFetcher, { opsApiKey: VALID_GATEWAY_JWT });
      assert.equal(expiredHealth.ok, false);
      assert.equal(expiredHealth.error, 'AUTH_REQUIRED');

      // Case D: Valid Gateway JWT + valid cmui session creates order assigned to cmui
      const draft = {
        id: 'draft-prod-1',
        requestId: 'req-prod-cmui-1',
        fields: {
          customer: 'Lan Anh',
          phone: '0909888123',
          date: '2026-12-29',
          time: '16:00',
          flower: 'Kệ chúc mừng tông vàng',
          shipping: 'Shop book ship',
          address: '',
          flowerTotal: '500000',
          paymentState: 'deposit',
          depositAmount: '250000',
          sale: 'cmui',
          banner: true,
          bannerQty: 2,
          bannerText: 'Khai trương hồng phát'
        }
      };
      const created = await opsClient.callCreateOrder(PROD_OPS_URL, CMUI_SESSION, draft, [], [], prodGatewayFetcher, { opsApiKey: VALID_GATEWAY_JWT });
      assert.equal(created.ok, true);
      assert.equal(created.order.saleUsername, 'cmui');
      assert.equal(created.order.totalDue, 570000);
      assert.equal(created.order.paid, 250000);
      assert.equal(created.order.debt, 320000);
      assert.equal(created.order.shipConfirmed, false);

      // Case E: Wrong role — SALE (`hien`) cannot assign `cmui` on createOrder (forced to own username) and cannot edit `cmui`'s order (`NOT_OWNER`)
      const saleRules = await opsClient.fetchOpsOrderRules(PROD_OPS_URL, SALE_SESSION, prodGatewayFetcher, { forceRefresh: true, opsApiKey: VALID_GATEWAY_JWT });
      assert.equal(saleRules.caller.role, 'SALE');
      assert.equal(saleRules.caller.canAssignDefaultSale, false);

      const saleCreate = await opsClient.callCreateOrder(PROD_OPS_URL, SALE_SESSION, { ...draft, requestId: 'req-prod-sale-1' }, [], [], prodGatewayFetcher, { opsApiKey: VALID_GATEWAY_JWT });
      assert.equal(saleCreate.ok, true);
      assert.equal(saleCreate.order.saleUsername, 'hien', 'SALE actor must be forced to own sale username, never cmui');

      const saleEditCmuiOrder = await opsClient.callUpdateOrderPayment(
        PROD_OPS_URL,
        SALE_SESSION,
        created.orderId,
        created.order,
        'Đã cọc 300.000 đ',
        'req-prod-sale-edit-cmui',
        '',
        prodGatewayFetcher,
        { opsApiKey: VALID_GATEWAY_JWT }
      );
      assert.equal(saleEditCmuiOrder.ok, false);
      assert.equal(saleEditCmuiOrder.code, 'NOT_OWNER');

      // Case F: Worker `/status` endpoint reports Production metadata cleanly without leaking secrets
      const statusReq = new Request('https://meehoa-order-bot.meehoasg.workers.dev/status', { method: 'GET' });
      const statusRes = await workerMod.default.fetch(statusReq, {
        ENVIRONMENT: 'production',
        SERVICE_NAME: 'meehoa-order-bot',
        OPS_API_URL: PROD_OPS_URL,
        OPS_TOKEN: CMUI_SESSION,
        OPS_SUPABASE_ANON_KEY: VALID_GATEWAY_JWT,
        OPS_SERVICE: { fetch: prodGatewayFetcher },
        GEMINI_API_KEY: 'dummy-secret-never-leaked',
        GEMINI_MODEL: 'gemini-3.5-flash-lite',
        TELEGRAM_SECRET_TOKEN: 'dummy-webhook-secret',
        MEDIA_R2: {},
        DB: {
          prepare: () => ({
            first: async () => ({ alive: 1 }),
            all: async () => ({ results: [] })
          })
        }
      });
      assert.equal(statusRes.status, 200);
      const statusJson = await statusRes.json();
      assert.equal(statusJson.ok, true);
      assert.equal(statusJson.service, 'meehoa-order-bot');
      assert.equal(statusJson.environment, 'production');
      assert.equal(statusJson.opsConnected, true);
      assert.equal(statusJson.opsAuthMode, 'supabase_gateway_jwt+app_session');
      assert.equal(statusJson.opsGatewayKeyConfigured, true);
      assert.equal(statusJson.opsRuleSchemaVersion, '2026-11-26.v3');
      assert.equal(statusJson.opsCallerRole, 'THO_OPS');
      const statusText = JSON.stringify(statusJson);
      assert.ok(!statusText.includes(VALID_GATEWAY_JWT), 'Status must never leak gateway JWT');
      assert.ok(!statusText.includes(CMUI_SESSION), 'Status must never leak OPS_TOKEN');
      assert.ok(!statusText.includes('dummy-secret'), 'Status must never leak GEMINI_API_KEY');
    } finally {
      await db.close();
    }
  });
});

describe('Production Readiness 2: Form + API + Bot Rule Parity (Production-equivalent PostgreSQL)', () => {
  test('enforces Sale cmui, flowerTotal>0, 50% min deposit on flowerTotal only, qty-based accessories, explicit-only shipFee, address reminder-only, Full Paid guard, and phone_required toggle', async () => {
    const { coreMod, supaOps } = await loadModules();
    const db = await createIsolatedProdPg({ includeUnverifiedBillMigrations: true });
    try {
      const cmuiUser = { username: 'cmui', display_name: 'C Mụi', role: 'THO_OPS', active: true };
      const opService = supaOps.createOperationService({
        db: async (endpoint, _q, _m, rpcBody) => {
          if (endpoint === 'rpc/mee_ops_lookup') {
            return (await db.query('select public.mee_ops_lookup($1,$2,$3,$4) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint])).rows[0].res;
          }
          if (endpoint === 'rpc/mee_ops_mutate') {
            return (await db.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res', [rpcBody.p_actor, rpcBody.p_request_id, rpcBody.p_action, rpcBody.p_fingerprint, JSON.stringify(rpcBody.p_input)])).rows[0].res;
          }
          throw new Error(endpoint);
        },
        one: async (table, query) => {
          if (table === 'orders' && query.id?.startsWith('eq.')) {
            return (await db.query('select * from public.orders where id = $1', [query.id.slice(3)])).rows[0] || null;
          }
          return null;
        },
        uploadImages: async (files, bucket) => files.map((_, i) => `r2://meehoasg-website-media/${bucket}/img-${i}.jpg`),
        sha256: async (s) => hash(s),
        newId: (prefix) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
      });

      const baseOrder = {
        customer: 'Chị Hương',
        phone: '0909111222',
        date: '2026-12-29',
        time: '16:00',
        flower: 'Bó tulip trắng',
        shipping: 'Shop book ship',
        address: '',
        flowerTotal: 350000,
        payment: 'Chưa thanh toán (0 đ)',
        sale: 'cmui',
        card: false,
        banner: false,
        shipFeeActive: '0',
        shipFee: 0
      };

      // 1. flowerTotal = 0 -> FLOWER_TOTAL_REQUIRED
      const zeroFlower = await opService.run('createOrder', { requestId: 'parity-1', order: { ...baseOrder, flowerTotal: 0 } }, cmuiUser);
      assert.equal(zeroFlower.ok, false);
      assert.equal(zeroFlower.code, 'FLOWER_TOTAL_REQUIRED');

      // 2. Deposit < 50% (174,999 on 350,000 even with ship 100k + accessories 45k) -> DEPOSIT_BELOW_MIN_RATIO
      const lowDeposit = await opService.run('createOrder', {
        requestId: 'parity-2',
        order: { ...baseOrder, payment: 'Đã cọc 174.999 đ', shipFeeActive: '1', shipFee: 100000, card: true, cardQty: 1, cardText: 'Chúc mừng', banner: true, bannerQty: 1, bannerText: 'Khai trương' }
      }, cmuiUser);
      assert.equal(lowDeposit.ok, false);
      assert.equal(lowDeposit.code, 'DEPOSIT_BELOW_MIN_RATIO');

      // 3. Exact 50% (175,000 on 350,000) + qty>1 accessories (3 cards=30k + 2 banners=70k) + missing address + no shipFee -> PASS
      const okOrder = await opService.run('createOrder', {
        requestId: 'parity-3',
        order: {
          ...baseOrder,
          address: '',
          payment: 'Đã cọc 175.000 đ',
          card: true, cardQty: 3, cardText: 'Chúc mừng sinh nhật',
          banner: true, bannerQty: 2, bannerText: 'Khai trương hồng phát'
        }
      }, cmuiUser);
      assert.equal(okOrder.ok, true);
      const fin = (await db.query('select public.mee_ops_total(o) as total_due, public.mee_ops_paid(o) as paid, public.mee_ops_debt(o) as debt from public.orders o where o.id = $1', [okOrder.orderId])).rows[0];
      assert.equal(Number(fin.total_due), 450000); // 350k + 3*10k + 2*35k
      assert.equal(Number(fin.paid), 175000);
      assert.equal(Number(fin.debt), 275000);
      assert.equal(okOrder.row.sale, 'cmui');
      assert.equal(okOrder.row.ship_confirmed, false);
      assert.equal(Number(okOrder.row.ship_fee), 0);
      assert.equal(okOrder.row.address, '');

      // 4. Bot core validation using Production ORDER_VALIDATION_RULES (2026-11-26.v3): missing address is reminder-only, NOT blocking!
      const rules = supaOps.ORDER_VALIDATION_RULES;
      assert.equal(rules.schemaVersion, '2026-11-26.v3');
      assert.deepEqual(rules.conditionalRequired, []);
      assert.equal(rules.conditionalReminders[0].field, 'address');
      const botValidation = coreMod.validateOrderAgainstRules({
        fields: {
          customer: 'Chị Hương',
          flower: 'Bó tulip trắng',
          date: '2026-12-29',
          time: '16:00',
          shipping: 'Shop book ship',
          address: '',
          flowerTotal: '350000',
          sale: 'cmui'
        }
      }, rules);
      assert.deepEqual(botValidation.missing, [], 'Shop book ship without address must NOT block Bot /confirm');
      assert.deepEqual(botValidation.ruleErrors, []);
      assert.deepEqual(botValidation.unsupportedRules, []);
      assert.ok(botValidation.reminders.length > 0, 'Bot must still emit reminder for missing Shop book ship address');

      // 5. Full Paid without bill or without ship_confirmed on Shop book ship -> FULL_PAID_EVIDENCE_REQUIRED
      const fpNoBill = await opService.run('createOrder', {
        requestId: 'parity-4',
        order: { ...baseOrder, fullPaidRequested: true, imageFiles: [{ data: 'data:image/jpeg;base64,AA==' }], shipFeeActive: '1', shipFee: 35000 }
      }, cmuiUser);
      assert.equal(fpNoBill.ok, false);
      assert.equal(fpNoBill.code, 'FULL_PAID_EVIDENCE_REQUIRED');

      const fpNoShip = await opService.run('createOrder', {
        requestId: 'parity-5',
        order: { ...baseOrder, fullPaidRequested: true, imageFiles: [{ data: 'data:image/jpeg;base64,AA==' }], fullPaidBillFiles: [{ data: 'data:image/jpeg;base64,BB==' }], shipFeeActive: '0' }
      }, cmuiUser);
      assert.equal(fpNoShip.ok, false);
      assert.equal(fpNoShip.code, 'FULL_PAID_EVIDENCE_REQUIRED');

      // 6. phone_required toggle -> PHONE_REQUIRED
      const phoneRules = supaOps.buildOrderRules({ phoneRequired: true });
      assert.throws(
        () => supaOps.normalizeOperationOrder({ ...baseOrder, phone: '' }, cmuiUser, {}, phoneRules),
        (err) => err.code === 'PHONE_REQUIRED'
      );

      // 7. Production Form `html` aligns with rules (flowerTotal > 0, 50% deposit, qty-based card/banner, getOrderRules, [name="phone"])
      const prodHtml = fs.readFileSync(path.join(ROOT, 'html'), 'utf8');
      assert.ok(prodHtml.includes("gas('getOrderRules')"), 'Production Form must sync getOrderRules');
      assert.ok(prodHtml.includes('Tiền hoa bắt buộc và phải lớn hơn 0 đ.'), 'Production Form must block flowerTotal <= 0');
      assert.ok(prodHtml.includes('bannerQty*35000') && prodHtml.includes('qty*10000'), 'Production Form must compute accessories by qty');
      assert.ok(prodHtml.includes("form.querySelector('[name=\"phone\"]')"), 'Production Form must use [name="phone"] selector');
    } finally {
      await db.close();
    }
  });
});

describe('Production Readiness 3: Isolated PostgreSQL Migration Rehearsal (20261121120000 & 20261127000000)', () => {
  test('proves pre-migration gap for bill photos, rehearses applying both migrations in order + idempotently, preserves existing V3.1 orders, and verifies unverified_bill_urls create/update/retry', async () => {
    const { supaOps } = await loadModules();
    // 1. Boot isolated PG matching LIVE Production BEFORE 20261121120000 & 20261127000000
    const db = await createIsolatedProdPg({ includeUnverifiedBillMigrations: false });
    try {
      const colBefore = await db.query(
        "select column_name from information_schema.columns where table_schema='public' and table_name='orders' and column_name='unverified_bill_urls'"
      );
      assert.equal(colBefore.rows.length, 0, 'Pre-migration Production schema must not have unverified_bill_urls');

      // Seed existing Production orders (STANDARD with banner_qty=2 + WALK_IN) BEFORE migrations
      const preStandardOrder = supaOps.normalizeOperationOrder({
        customer: 'Khách hiện hữu',
        phone: '0908000111',
        date: '2026-11-26',
        time: '15:00',
        flower: 'Kệ chúc mừng',
        shipping: 'Shop book ship',
        address: '123 Lê Lợi',
        flowerTotal: 500000,
        payment: 'Đã cọc 250.000 đ',
        sale: 'cmui',
        banner: true,
        bannerQty: 2,
        bannerText: 'Chúc mừng',
        shipFeeActive: '0'
      }, { username: 'cmui', display_name: 'C Mụi', role: 'THO_OPS' });

      const preCreate = (await db.query(
        'select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res',
        ['cmui', 'pre-mig-1', 'createOrder', hash('pre-mig-1'), JSON.stringify({
          newOrderId: 'MEE-PREMIG00000001',
          order: preStandardOrder,
          fullPaidRequested: false,
          newImageUrls: ['r2://meehoasg-website-media/order-images/sample-pre.jpg'],
          newBillUrls: [],
          newUnverifiedBillUrls: ['r2://meehoasg-website-media/settlement-bills/dropped-before-mig.jpg']
        })]
      )).rows[0].res;
      assert.equal(preCreate.ok, true);
      assert.equal(preCreate.row.unverified_bill_urls, undefined, 'Pre-migration mee_ops_mutate silently drops newUnverifiedBillUrls');

      // 2. Apply migrations in exact required order: 20261121120000 -> 20261127000000
      const mig1Sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261121120000_unverified_bill_urls.sql'), 'utf8');
      const mig2Sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261127000000_preserve_unverified_order_evidence.sql'), 'utf8');
      await db.exec(mig1Sql);
      await db.exec(mig2Sql);

      // 3. Re-apply BOTH migrations to prove idempotency
      await db.exec(mig1Sql);
      await db.exec(mig2Sql);

      // 4. Verify pre-existing order preserved untouched with default unverified_bill_urls = []
      const existingAfter = (await db.query('select id, flower_total, banner_qty, unverified_bill_urls, public.mee_ops_total(orders) as total_due from public.orders where id = $1', ['MEE-PREMIG00000001'])).rows[0];
      assert.equal(Number(existingAfter.flower_total), 500000);
      assert.equal(Number(existingAfter.banner_qty), 2);
      assert.equal(Number(existingAfter.total_due), 570000);
      assert.deepEqual(existingAfter.unverified_bill_urls, []);

      // 5. Verify post-migration createOrder persists unverified_bill_urls without flipping full_paid/settled
      const postCreateInput = {
        newOrderId: 'MEE-POSTMIG0000001',
        order: preStandardOrder,
        fullPaidRequested: false,
        newImageUrls: ['r2://meehoasg-website-media/order-images/sample-post.jpg'],
        newBillUrls: [],
        newUnverifiedBillUrls: ['r2://meehoasg-website-media/settlement-bills/bill-1.jpg']
      };
      const postCreate = (await db.query(
        'select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res',
        ['cmui', 'post-mig-1', 'createOrder', hash('post-mig-1'), JSON.stringify(postCreateInput)]
      )).rows[0].res;
      assert.equal(postCreate.ok, true);
      assert.deepEqual(postCreate.row.unverified_bill_urls, ['r2://meehoasg-website-media/settlement-bills/bill-1.jpg']);
      assert.equal(postCreate.row.full_paid, false);
      assert.equal(postCreate.row.settled, false);

      // 6. Verify idempotent retry with same requestId returns single receipt without duplicating order
      const postRetry = (await db.query(
        'select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res',
        ['cmui', 'post-mig-1', 'createOrder', hash('post-mig-1'), JSON.stringify(postCreateInput)]
      )).rows[0].res;
      assert.equal(postRetry.ok, true);
      assert.equal(postRetry.idempotent, true);
      assert.equal(postRetry.orderId, 'MEE-POSTMIG0000001');

      // 7. Verify updateOrder appends additional unverified bill while preserving existing bill
      const postUpdate = (await db.query(
        'select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res',
        ['cmui', 'post-mig-upd-1', 'updateOrder', hash('post-mig-upd-1'), JSON.stringify({
          orderId: 'MEE-POSTMIG0000001',
          expectedUpdatedAt: postCreate.row.updated_at,
          order: { ...preStandardOrder, image_urls: postCreate.row.image_urls },
          fullPaidRequested: false,
          newImageUrls: [],
          newBillUrls: [],
          newUnverifiedBillUrls: ['r2://meehoasg-website-media/settlement-bills/bill-2.jpg']
        })]
      )).rows[0].res;
      assert.equal(postUpdate.ok, true);
      assert.deepEqual(postUpdate.row.unverified_bill_urls, [
        'r2://meehoasg-website-media/settlement-bills/bill-1.jpg',
        'r2://meehoasg-website-media/settlement-bills/bill-2.jpg'
      ]);
      assert.equal(postUpdate.row.full_paid, false);
    } finally {
      await db.close();
    }
  });
});

describe('Production Readiness 4: AI Local Phone PII Masking & Zero-Image Payload', () => {
  test('masks Vietnamese phone numbers locally before sending caption to Gemini and restores normalized phone after extraction', async () => {
    const { geminiMod } = await loadModules();
    const caption = 'Chị Lan Anh SĐT 0909.888.123 (dự phòng +84 912 345 678) đặt kệ chúc mừng tông vàng 650.000 đ, chiều 29/12 lúc 16:00 shop giao qua 88 Võ Văn Tần quận 3';

    const masked = geminiMod.maskLocalPiiForAi(caption);
    assert.equal(masked.phones.length, 2);
    assert.ok(masked.maskedText.includes('[PHONE_1]'));
    assert.ok(masked.maskedText.includes('[PHONE_2]'));
    assert.ok(!masked.maskedText.includes('0909'));
    assert.ok(!masked.maskedText.includes('912'));
    // Must not corrupt prices, dates, or times
    assert.ok(masked.maskedText.includes('650.000 đ'));
    assert.ok(masked.maskedText.includes('29/12'));
    assert.ok(masked.maskedText.includes('16:00'));

    let capturedBody = '';
    const mockFetcher = async (_url, init) => {
      capturedBody = String(init.body || '');
      const ssePayload = `data: ${JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: {
            parts: [{
              text: JSON.stringify({
                customer: 'Lan Anh',
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
      return new Response(ssePayload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    const res = await geminiMod.extractFieldsWithGeminiDetailed(
      'fake-paid-key',
      caption,
      'gemini-3.5-flash-lite',
      mockFetcher
    );
    assert.equal(res.ok, true);
    assert.equal(res.piiMaskedCount, 2);
    assert.ok(!capturedBody.includes('0909'), 'Raw primary phone must NEVER be sent to Gemini');
    assert.ok(!capturedBody.includes('912'), 'Raw secondary phone must NEVER be sent to Gemini');
    assert.ok(!capturedBody.includes('inlineData'), 'Images/bills must NEVER be sent to Gemini');
    assert.equal(res.fields.phone, '0909888123');
    assert.equal(res.fields.customer, 'Lan Anh');
    assert.equal(res.fields.flowerTotal, 650000);
  });
});

describe('Production Readiness 5: wrangler.production.toml Anti-Staging-Leakage Contract', () => {
  test('points strictly to dedicated Production resources with zero Staging leakage', () => {
    const prodTomlPath = path.join(ROOT, 'order-bot/cloudflare/wrangler.production.toml');
    assert.ok(fs.existsSync(prodTomlPath), 'wrangler.production.toml must exist');
    const content = fs.readFileSync(prodTomlPath, 'utf8');

    // Required Production values
    assert.match(content, /^name\s*=\s*"meehoa-order-bot"$/m);
    assert.match(content, /^workers_dev\s*=\s*true$/m);
    assert.match(content, /^ENVIRONMENT\s*=\s*"production"$/m);
    assert.match(content, /^OPS_API_URL\s*=\s*"https:\/\/zxnfhshnavbmvdthrmrd\.supabase\.co\/functions\/v1\/meehoasg-api-core"$/m);
    assert.match(content, /^ALLOWED_USER_IDS\s*=\s*"5252724920"$/m);
    assert.match(content, /^GEMINI_MODEL\s*=\s*"gemini-3\.5-flash-lite"$/m);
    assert.match(content, /^database_name\s*=\s*"meehoa-order-bot-prod"$/m);
    assert.match(content, /^bucket_name\s*=\s*"meehoa-order-bot-media-prod"$/m);

    // Strip comment lines before checking forbidden Staging references
    const activeLines = content.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/staging/i.test(activeLines), 'Active config lines must contain zero staging references');
    assert.ok(!activeLines.includes('16bf0134-64c6-43ea-8098-b40c95251667'), 'Must never bind Staging D1 ID');
    assert.ok(!activeLines.includes('meehoasg-media-staging'), 'Must never bind Staging R2 bucket');
    assert.ok(!activeLines.includes('c483e22ad8c546c5bdf4f6711098fd04'), 'Must never bind Staging KV ID');
    assert.ok(!activeLines.includes('OPS_SERVICE'), 'Must never bind Cloudflare Staging OPS_SERVICE');
  });
});
