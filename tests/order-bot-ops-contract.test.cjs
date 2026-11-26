/**
 * MEEHOA Order Bot V1 — OPS Contract, Fail-Closed Security, R2 Image Scale & Financial Invariant Tests
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function createMockD1() {
  const sqlite = new DatabaseSync(':memory:');
  const schema = fs.readFileSync('order-bot/cloudflare/schema.sql', 'utf8');
  sqlite.exec(schema);
  sqlite.exec('CREATE TABLE IF NOT EXISTS orders (row_key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));');

  const makeStmt = (sql, boundArgs = []) => ({
    bind(...args) {
      return makeStmt(sql, args);
    },
    first: async () => sqlite.prepare(sql).get(...boundArgs) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...boundArgs), success: true, meta: { changes: 0 } }),
    run: async () => {
      const info = sqlite.prepare(sql).run(...boundArgs);
      return { success: true, meta: { changes: Number(info.changes || 0) } };
    }
  });

  return {
    sqlite,
    prepare(sql) {
      return makeStmt(sql);
    }
  };
}

function createMockR2({ failPut = false, failGet = false } = {}) {
  const objects = new Map();
  const deleted = [];
  return {
    objects,
    deleted,
    async put(key, buffer, options = {}) {
      if (failPut) throw new Error('R2 write unavailable');
      objects.set(key, {
        key,
        body: buffer,
        buffer,
        httpMetadata: options.httpMetadata || { contentType: 'image/jpeg' },
        async arrayBuffer() {
          if (buffer instanceof ArrayBuffer) return buffer;
          if (ArrayBuffer.isView(buffer)) {
            return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
          }
          return buffer;
        }
      });
      return { key };
    },
    async get(key) {
      if (failGet) throw new Error('R2 read unavailable');
      return objects.get(key) || null;
    },
    async delete(key) {
      deleted.push(key);
      objects.delete(key);
    }
  };
}

function makeWebhookRequest(body, headers = {}) {
  return new Request('https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'staging_secret_token_123',
      ...headers
    },
    body: JSON.stringify(body)
  });
}

// ---------------------------------------------------------------------------
// 1. Canonical OPS Normalization & Strict Financial Invariant Contract
// ---------------------------------------------------------------------------

test('Contract 1: Cloudflare Bot payload is accepted by canonical OPS normalization across all 4 payment states with owner-verified OPS payment mapping', async () => {
  const { callCreateOrder } = await import('../order-bot/cloudflare/ops-client.mjs');
  const { normalizeOperationOrder } = await import('../supabase/functions/_shared/operations.js');

  const states = [
    { paymentState: 'unpaid', expectedPayment: 'Chưa thanh toán' },
    { paymentState: 'deposit', depositAmount: 325000, expectedPayment: 'Đã cọc 325.000 đ' },
    { paymentState: 'bankfull', reportedPaidAmount: 650000, expectedPayment: 'Đã thanh toán đủ tiền hoa (Full)' },
    { paymentState: 'fullpaid', expectedPayment: 'Chưa thanh toán' }
  ];

  for (const st of states) {
    let payload;
    const draft = {
      requestId: `fixed-request-${st.paymentState}`,
      fields: {
        customer: 'Lan',
        date: '2026-12-05',
        time: '09:30',
        flower: 'Bó hồng',
        flowerTotal: 650000,
        shipping: 'Ghé lấy',
        card: true,
        cardQty: 2,
        cardText: 'Chúc mừng',
        ...st
      }
    };
    const response = await callCreateOrder(
      'https://staging.example/api-core',
      'test-session',
      draft,
      [{ data: 'data:image/jpeg;base64,YQ==' }],
      [],
      async (_url, options) => {
        payload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ ok: true, orderId: 'MEE-TEST' }) };
      }
    );
    assert.equal(response.ok, true);
    const normalized = normalizeOperationOrder(payload.payload.order, { username: 'sale1', role: 'SALE' });
    assert.equal(normalized.order_date, '2026-12-05');
    assert.equal(normalized.order_time, '09:30');
    assert.equal(normalized.flower_total, 650000);
    assert.equal(normalized.card_qty, 2);
    assert.equal(normalized.payment, st.expectedPayment, `OPS payment must match owner-verified mapping for ${st.paymentState}`);
    assert.equal(payload.payload.order.fullPaidRequested, false);
    assert.ok(!String(payload.payload.order.note || '').includes('[Khách báo:'), 'Must not pollute note with [Khách báo: ...]');
    assert.equal(payload.payload.requestId, `fixed-request-${st.paymentState}`);
    assert.equal(payload.payload.order.imageFiles.length, 1);
  }
});

// ---------------------------------------------------------------------------
// 2. Webhook Auth & Runtime Fail-Closed Guards
// ---------------------------------------------------------------------------

test('Contract 2: Webhook rejects requests when secret is absent, empty, or mismatched', async () => {
  const { verifyWebhookSecret } = await import('../order-bot/cloudflare/telegram.mjs');
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');

  assert.equal(verifyWebhookSecret(new Request('https://example.test/webhook'), undefined), false);
  assert.equal(verifyWebhookSecret(new Request('https://example.test/webhook'), ''), false);
  assert.equal(
    verifyWebhookSecret(
      new Request('https://example.test/webhook', { headers: { 'x-telegram-bot-api-secret-token': 'abc' } }),
      'abd'
    ),
    false
  );
  assert.equal(
    verifyWebhookSecret(
      new Request('https://example.test/webhook', { headers: { 'x-telegram-bot-api-secret-token': 'secret_1234567890' } }),
      'secret_1234567890'
    ),
    true
  );

  // Full handler returns 403 when TELEGRAM_SECRET_TOKEN is not configured
  const resNoSecret = await handleTelegramWebhook(
    makeWebhookRequest({ update_id: 1, message: { text: '/new' } }),
    { DB: createMockD1(), BOT_TOKEN: 'tok' }
  );
  assert.equal(resNoSecret.status, 403);

  // Full handler returns 503 when DB or BOT_TOKEN is missing
  const resNoDb = await handleTelegramWebhook(
    makeWebhookRequest({ update_id: 1, message: { text: '/new' } }),
    { TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123', BOT_TOKEN: 'tok' }
  );
  assert.equal(resNoDb.status, 503);

  const resNoBot = await handleTelegramWebhook(
    makeWebhookRequest({ update_id: 1, message: { text: '/new' } }),
    { TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123', DB: createMockD1() }
  );
  assert.equal(resNoBot.status, 503);
});

// ---------------------------------------------------------------------------
// 3. D1 Read Failure Must Preserve Drafts (Never Return {} & Overwrite)
// ---------------------------------------------------------------------------

test('Contract 3: D1 read failure throws in loadDrafts and returns HTTP 503 without marking update processed or overwriting drafts', async () => {
  const { loadDrafts, saveDrafts, isUpdateProcessed } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');

  const failingDb = {
    prepare() {
      throw new Error('D1 unavailable');
    }
  };
  await assert.rejects(loadDrafts(failingDb, 42), /D1 unavailable/);

  // Seed real mock D1 with an existing draft, then inject read failure ONLY on loadDrafts SELECT
  const realDb = createMockD1();
  const originalDrafts = {
    __active: 'draft-important-1',
    'draft-important-1': {
      id: 'draft-important-1',
      status: 'pending',
      fields: { customer: 'Khách Quan Trọng', flower: 'Lan hồ điệp' },
      sampleRefs: [],
      draftBillRefs: []
    }
  };
  await saveDrafts(realDb, 5252724920, originalDrafts);

  const flakyDb = {
    prepare(sql) {
      if (sql.includes('SELECT active_draft_id, drafts_json FROM bot_drafts')) {
        return {
          bind() {
            return {
              async first() {
                throw new Error('D1 transient read error');
              }
            };
          }
        };
      }
      return realDb.prepare(sql);
    }
  };

  const sentMessages = [];
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const res = await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99001,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
    }),
    {
      DB: flakyDb,
      BOT_TOKEN: 'fake_bot_token',
      TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
      ALLOWED_USER_IDS: '5252724920'
    }
  );

  assert.equal(res.status, 503, 'D1 failure must return HTTP 503 for Telegram retry');
  assert.equal(await isUpdateProcessed(realDb, 99001), false, 'Failed update must NOT be marked processed');

  // Verify original draft in D1 was completely untouched (NOT overwritten with empty {})
  const preserved = await loadDrafts(realDb, 5252724920);
  assert.equal(preserved.__active, 'draft-important-1');
  assert.equal(preserved['draft-important-1'].fields.customer, 'Khách Quan Trọng');
});

// ---------------------------------------------------------------------------
// 4. R2 Failure, Missing Media Binding, & D1-Save-After-R2 Rollback
// ---------------------------------------------------------------------------

test('Contract 4: R2 save failure or missing R2 binding rejects photo without mutating draft; D1 save failure rolls back R2 object', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const failingR2 = createMockR2({ failPut: true });
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s1.jpg', file_size: 1024 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    }
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const envFailR2 = {
    DB: db,
    MEDIA_R2: failingR2,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99101,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
    }),
    envFailR2
  );

  // Send photo when R2 put fails
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99102,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'f_fail_r2', file_unique_id: 'u_fail_r2' }]
      }
    }),
    envFailR2
  );

  let drafts = await loadDrafts(db, 5252724920);
  let active = drafts[drafts.__active];
  assert.equal(active.sampleRefs.length, 0, 'Photo must NOT be added to draft when R2 save fails');
  assert.match(sentMessages[sentMessages.length - 1].text, /Chưa lưu được ảnh/);

  // Send photo when MEDIA_R2 is unbound
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99103,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'f_no_r2', file_unique_id: 'u_no_r2' }]
      }
    }),
    { ...envFailR2, MEDIA_R2: undefined }
  );

  drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts[drafts.__active].sampleRefs.length, 0);
  assert.match(sentMessages[sentMessages.length - 1].text, /Kho ảnh chưa sẵn sàng/);

  // D1 saveDrafts fails after R2 upload succeeded -> newly uploaded R2 object must be deleted
  const goodR2 = createMockR2();
  const failSaveDb = {
    prepare(sql) {
      if (sql.includes('INSERT INTO bot_drafts') && sql.includes('ON CONFLICT(user_id) DO UPDATE')) {
        return {
          bind() {
            return {
              async run() {
                throw new Error('D1 write failed');
              }
            };
          }
        };
      }
      return db.prepare(sql);
    }
  };

  const resSaveFail = await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99104,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'f_orphan', file_unique_id: 'u_orphan' }]
      }
    }),
    { ...envFailR2, DB: failSaveDb, MEDIA_R2: goodR2 }
  );

  assert.equal(resSaveFail.status, 503);
  assert.equal(goodR2.objects.size, 0, 'Orphaned R2 object must be rolled back when D1 save fails');
  assert.equal(goodR2.deleted.length, 1);
});

// ---------------------------------------------------------------------------
// 5. Image Scale Near 5MB, R2-Only D1 Storage, Telegram Expiry Resilience, & R2 Read Failure
// ---------------------------------------------------------------------------

test('Contract 5: Multiple ~4.5MB images keep D1 JSON tiny, survive Telegram expiry via R2, and link bills cleanly without hitting 12MB HTTP limit', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const orderId = 'MEE-SCALE-5MB';
  await db.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?)').bind(
    orderId,
    JSON.stringify({ id: orderId, payment: 'Chưa thanh toán', full_paid: false, unverified_bill_urls: [] })
  ).run();

  const bigBytes = new Uint8Array(4_500_000);
  bigBytes[0] = 0xff;
  bigBytes[1] = 0xd8;
  bigBytes[2] = 0xff;
  bigBytes[3] = 0xe0;

  let telegramExpired = false;
  let capturedOpsBodyBytes = 0;
  let capturedOpsPayload = null;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) {
      if (telegramExpired) {
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request: file expired' }));
      }
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/big.jpg', file_size: bigBytes.byteLength } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(bigBytes);
    }
    if (url.includes('/api-core')) {
      capturedOpsBodyBytes = Buffer.byteLength(opts.body, 'utf8');
      capturedOpsPayload = JSON.parse(opts.body);
      return new Response(JSON.stringify({ ok: true, orderId }));
    }
    if (url.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99201,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99202,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        text: 'Tên: Anh Khoa\nHoa: Kệ hoa lan 2tr\nNgày: 2026-12-12\nGiờ: 10:00\nShip: Ghé lấy'
      }
    }),
    env
  );

  // Upload 1 sample photo (~4.5MB) and 1 bill photo (~4.5MB) -> combined base64 (~12MB) exceeds 11.5MB HTTP limit
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99203,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'big_sample_1', file_unique_id: 'u_big_s1' }]
      }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99204,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'big_bill_1', file_unique_id: 'u_big_b1' }],
        caption: 'bill chuyển khoản'
      }
    }),
    env
  );

  // Verify D1 stored JSON is tiny (< 4 KB) with NO base64 data_url
  const row = await db.prepare('SELECT drafts_json FROM bot_drafts WHERE user_id = ?').bind(5252724920).first();
  assert.ok(row.drafts_json.length < 4096, `D1 row must stay tiny without base64, got ${row.drafts_json.length} bytes`);
  assert.ok(!row.drafts_json.includes('data:image/'), 'D1 JSON must never contain base64 image data');

  // Now expire Telegram getFile completely -> /confirm must still succeed reading durably from R2!
  telegramExpired = true;

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99205,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
    }),
    env
  );

  assert.ok(capturedOpsPayload, 'OPS createOrder must succeed from R2 even after Telegram file expiry');
  assert.ok(capturedOpsBodyBytes < 12 * 1024 * 1024, 'HTTP payload must stay safely below OPS 12MB limit');
  assert.equal(capturedOpsPayload.payload.order.imageFiles.length, 1);
  assert.ok(capturedOpsPayload.payload.order.note.includes('Đính kèm 1 bill chưa xác minh'));

  // Verify bill was still linked in D1 orders from R2
  const orderRow = await db.prepare('SELECT data FROM orders WHERE row_key = ?').bind(orderId).first();
  const orderData = JSON.parse(orderRow.data);
  assert.equal(orderData.unverified_bill_urls.length, 1);
  assert.match(orderData.unverified_bill_urls[0], /^supabase:\/\/settlement-bills\/unverified-/);

  const finalDrafts = await loadDrafts(db, 5252724920);
  assert.equal(finalDrafts[finalDrafts.__active].status, 'submitted');
});

test('Contract 6: Missing or unreadable R2 object during /confirm aborts BEFORE calling OPS and preserves draft', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  let opsCalls = 0;
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s1.jpg', file_size: 100 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    }
    if (url.includes('/api-core')) {
      const payload = JSON.parse(opts.body);
      if (payload.name === 'getOrderRules') return new Response('Not found', { status: 404 });
      opsCalls++;
      return new Response(JSON.stringify({ ok: true, orderId: 'MEE-SHOULD-NOT-CREATE' }));
    }
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99301,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99302,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        text: 'Tên: Chị Vy\nHoa: Bó cúc 400k\nNgày: 2026-12-12\nGiờ: 10:00\nShip: Ghé lấy'
      }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99303,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 's_vanish', file_unique_id: 'u_vanish' }]
      }
    }),
    env
  );

  // Delete the R2 object before /confirm to simulate missing R2 evidence
  r2.objects.clear();

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99304,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
    }),
    env
  );

  assert.equal(opsCalls, 0, 'OPS must NOT be called if any R2 image is missing');
  const drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts[drafts.__active].status, 'confirmed', 'Draft must rollback to confirmed for retry');
  assert.match(sentMessages[sentMessages.length - 1].text, /Không đọc được ảnh mẫu/);
});

// ---------------------------------------------------------------------------
// 6. Safe R2 Cleanup on /cancel (Never Deletes Images Attached to Orders)
// ---------------------------------------------------------------------------

test('Contract 7: /cancel cleans up cancelled draft R2 images but NEVER deletes images attached to an OPS order or another draft', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/x.jpg', file_size: 128 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    }
    if (url.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99401,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99402,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'cancel_sample', file_unique_id: 'u_can_s1' }]
      }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99403,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'cancel_bill', file_unique_id: 'u_can_b1' }],
        caption: 'bill'
      }
    }),
    env
  );

  const beforeCancel = await loadDrafts(db, 5252724920);
  const draft = beforeCancel[beforeCancel.__active];
  const sampleKey = draft.sampleRefs[0].r2_key;
  const billKey = draft.draftBillRefs[0].r2_key;

  // Simulate billKey already linked to an existing OPS order in D1
  await db.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?)').bind(
    'MEE-EXISTING-ORDER',
    JSON.stringify({ id: 'MEE-EXISTING-ORDER', unverified_bill_urls: [`supabase://${billKey}`] })
  ).run();

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99404,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/cancel' }
    }),
    env
  );

  assert.equal(r2.objects.has(sampleKey), false, 'Unreferenced sample image of cancelled draft must be cleaned up');
  assert.equal(r2.objects.has(billKey), true, 'Image referenced by an OPS order MUST NEVER be deleted on /cancel');
});

// ---------------------------------------------------------------------------
// 7. HTML Escaping, Sanitized /status Diagnostics, & AI/Parser Anti-Guessing
// ---------------------------------------------------------------------------

test('Contract 8: HTML characters in customer/flower/order fields are escaped in Telegram HTML messages, and /status never leaks raw errors or IP', async () => {
  const workerMod = await import('../order-bot/cloudflare/worker.mjs');
  const { handleTelegramWebhook } = workerMod;
  const worker = workerMod.default;

  const db = createMockD1();
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/api-core')) {
      return new Response(JSON.stringify({ ok: true, orderId: 'MEE-<1>&2' }));
    }
    if (url.includes('/health')) {
      throw new Error('SECRET_INTERNAL_STACK_12345');
    }
    if (url.includes('/getWebhookInfo')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            url: 'https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook',
            pending_update_count: 0,
            ip_address: '1.2.3.4',
            last_error_message: 'raw secret technical error'
          }
        })
      );
    }
    return new Response('Not found', { status: 404 });
  };

  // Test /status sanitization
  const statusRes = await worker.fetch(new Request('https://meehoa-order-bot-staging.meehoasg.workers.dev/status'), {
    DB: db,
    MEDIA_R2: createMockR2(),
    TELEGRAM_BOT_TOKEN: '123456789:SUPER_SECRET_TOKEN_VALUE',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123'
  });
  assert.equal(statusRes.status, 200);
  const statusText = await statusRes.text();
  assert.ok(!statusText.includes('SECRET_INTERNAL_STACK_12345'), 'Must not leak raw error messages');
  assert.ok(!statusText.includes('SUPER_SECRET_TOKEN_VALUE'), 'Must not leak bot token');
  assert.ok(!statusText.includes('1.2.3.4'), 'Must not leak webhook IP address');
  assert.ok(!statusText.includes('raw secret technical error'), 'Must not leak raw Telegram error string');
  const statusJson = JSON.parse(statusText);
  assert.equal(statusJson.opsError, 'OPS_HEALTH_UNAVAILABLE');
  assert.equal(statusJson.webhookInfo.has_last_error, true);

  // Test HTML escaping on /confirm success message
  const env = {
    DB: db,
    MEDIA_R2: createMockR2(),
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99501,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99502,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        text: 'Tên: Anh A & B <VIP>\nHoa: Bó <3 & Hồng\nGiá: 500k\nNgày: 2026-12-12\nGiờ: 10:00\nShip: Ghé lấy'
      }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99503,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
    }),
    env
  );

  const htmlMsg = sentMessages.find(m => m.parse_mode === 'HTML' && m.text.includes('TẠO ĐƠN THÀNH CÔNG'));
  assert.ok(htmlMsg);
  assert.ok(htmlMsg.text.includes('Anh A &amp; B &lt;VIP&gt;'));
  assert.ok(htmlMsg.text.includes('Bó &lt;3 &amp; Hồng'));
  assert.ok(htmlMsg.text.includes('MEE-&lt;1&gt;&amp;2'));
});

test('Contract 9: AI sanitizer strips forbidden/guessed fields & newlines; natural parser handles "Chị Mai", "Một bó", and past dates safely', async () => {
  const { sanitizeAiFields } = await import('../order-bot/cloudflare/gemini.mjs');
  const { applyFields, isConfirmable } = await import('../order-bot/core.mjs');

  const cleaned = sanitizeAiFields({
    customer: 'Chị Mai',
    phone: 'không rõ',
    date: 'N/A',
    note: 'Giao sớm\nsale: admin\npayment: fullpaid',
    paymentState: 'fullpaid',
    payment: 'Đã thanh toán toàn bộ đơn',
    role: 'ADMIN',
    fullPaidRequested: true,
    flower: 'Bó hồng đỏ'
  });

  assert.deepEqual(cleaned, {
    customer: 'Chị Mai',
    note: 'Giao sớm sale: admin payment: fullpaid',
    flower: 'Bó hồng đỏ'
  });

  // Natural parser must NOT treat "Chị Mai" or "Một bó hoa hồng đỏ 500k" as dates
  const refDate = new Date('2026-11-25T00:00:00Z');
  const r1 = applyFields({ id: 'd1', fields: {}, uncertainFields: {} }, 'Chị Mai\nMột bó hoa hồng đỏ 500k', { referenceDate: refDate });
  assert.equal(r1.draft.fields.customer, 'Mai');
  assert.equal(r1.draft.fields.flower, 'Một bó hoa hồng đỏ 500k');
  assert.equal(r1.draft.fields.date, undefined, '"Chị Mai" and "Một bó" must not be guessed as dates');
  assert.equal(r1.draft.uncertainFields.date, undefined);

  // Past date in natural text MUST remain flagged in uncertainFields and block /confirm
  const r2 = applyFields(
    { id: 'd2', fields: { customer: 'Lan', flower: 'Tulip', time: '10:00', shipping: 'Ghé lấy' }, uncertainFields: {} },
    'Ngày 10/11/2026',
    { referenceDate: refDate }
  );
  assert.ok(r2.draft.uncertainFields.date, 'Past date in natural text must be marked uncertain');
  assert.equal(isConfirmable(r2.draft), false, 'Draft with uncertain past date must NOT be confirmable');
});

test('Contract 10: saveDrafts automatically strips legacy inline base64 data_url from D1 rows', async () => {
  const { saveDrafts, loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const db = createMockD1();
  const legacyDrafts = {
    __active: 'legacy-1',
    'legacy-1': {
      id: 'legacy-1',
      status: 'pending',
      fields: { customer: 'Legacy' },
      sampleRefs: [{ fileId: 'f1', r2_key: 'order-images/sample-legacy-1-abc.jpg', data_url: 'data:image/jpeg;base64,' + 'A'.repeat(20000) }],
      draftBillRefs: [{ fileId: 'f2', r2_key: 'settlement-bills/unverified-legacy-1-def.jpg', data_url: 'data:image/jpeg;base64,' + 'B'.repeat(20000) }]
    }
  };
  await saveDrafts(db, 5252724920, legacyDrafts);
  const row = await db.prepare('SELECT drafts_json FROM bot_drafts WHERE user_id = ?').bind(5252724920).first();
  assert.ok(!row.drafts_json.includes('data:image/'), 'Persisted D1 JSON must strip legacy data_url');
  assert.ok(row.drafts_json.length < 1024);
  const loaded = await loadDrafts(db, 5252724920);
  assert.equal(loaded['legacy-1'].sampleRefs[0].r2_key, 'order-images/sample-legacy-1-abc.jpg');
  assert.equal(loaded['legacy-1'].sampleRefs[0].data_url, undefined);
});

// ---------------------------------------------------------------------------
// 8. Photo + Caption Draft Isolation, Exact Staging Bug Repro, Ambiguity & /new
// ---------------------------------------------------------------------------

test('Contract 11: Exact staging caption ("Tổng 350k cọc 200k / Như + 0394200327 / 27/11 & 13h30 / địa chỉ nhận / note") isolates into new draft without mixing old draft #d4a39f', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts, saveDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft, requiredMissing } = await import('../order-bot/core.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  const opsCalls = [];

  // Seed existing draft #d4a39f ("Test Ảnh 26/11", "Bó hoa thử nghiệm", 400k, 1 photo)
  const oldDraftId = '11111111-2222-4333-8444-555555d4a39f';
  const oldPhotoKey = `order-images/sample-${oldDraftId}-oldpic01.jpg`;
  await r2.put(oldPhotoKey, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]), { httpMetadata: { contentType: 'image/jpeg' } });
  await saveDrafts(db, 5252724920, {
    __active: oldDraftId,
    [oldDraftId]: {
      id: oldDraftId,
      status: 'pending',
      fields: {
        customer: 'Test Ảnh 26/11',
        flower: 'Bó hoa thử nghiệm',
        flowerTotal: '400000',
        date: '2026-12-05',
        time: '10:00',
        shipping: 'Ghé lấy'
      },
      sampleRefs: [{ fileId: 'old_photo_1', r2_key: oldPhotoKey, uri: `supabase://${oldPhotoKey}`, mimeType: 'image/jpeg' }],
      draftBillRefs: [],
      createdAt: '2026-11-26T04:00:00.000Z'
    }
  });

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/nhu_sample.jpg', file_size: 2048 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]));
    }
    if (url.includes('/api-core')) {
      const payload = JSON.parse(opts.body);
      if (payload.name === 'getOrderRules') return new Response('Not found', { status: 404 });
      opsCalls.push(payload);
      if (payload.name === 'createOrder') {
        const o = payload.payload.order;
        const paid = o.payment === 'Đã cọc 200.000 đ' ? 200000 : 0;
        const total = Number(o.flowerTotal) || 350000;
        return new Response(JSON.stringify({
          ok: true,
          orderId: 'MEE-NHU-001',
          order: {
            id: 'MEE-NHU-001',
            customer: o.customer,
            flower: o.flower,
            date: o.date,
            time: o.time,
            shipping: o.shipping,
            flowerTotal: total,
            totalDue: total,
            payment: o.payment,
            paid,
            debt: Math.max(0, total - paid)
          }
        }));
      }
      return new Response(JSON.stringify({ ok: true, orderId: 'MEE-NHU-001' }));
    }
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // Use the literal caption reported on staging
  const literalCaption = `Tổng 350k cọc 200k
Như + 0394200327
27/11 & 13h30
địa chỉ nhận: 102/34c Phan Huy Ích, P. Tân Sơn
note: “Chúc mừng ngày nhận bằng thật rạng rỡ!”`;

  const resPhoto = await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99601,
      message: {
        message_id: 10,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'nhu_photo_1', file_unique_id: 'uniq_nhu_1' }],
        caption: literalCaption
      }
    }),
    env
  );
  assert.equal(resPhoto.status, 200);

  const drafts = await loadDrafts(db, 5252724920);
  const draftIds = Object.keys(drafts).filter(k => !k.startsWith('__'));
  assert.equal(draftIds.length, 2, 'Old draft must be kept separate and a brand-new draft must be created');

  // 1. Old draft #d4a39f MUST remain 100% untouched
  const preservedOld = drafts[oldDraftId];
  assert.ok(preservedOld);
  assert.equal(preservedOld.fields.customer, 'Test Ảnh 26/11');
  assert.equal(preservedOld.fields.flower, 'Bó hoa thử nghiệm');
  assert.equal(preservedOld.fields.flowerTotal, '400000');
  assert.equal(preservedOld.sampleRefs.length, 1, 'Old draft must NOT receive the new photo');
  assert.equal(preservedOld.sampleRefs[0].fileId, 'old_photo_1');

  // 2. New active draft MUST contain ONLY the new order's parsed data
  const newDraft = activeDraft(drafts);
  assert.notEqual(newDraft.id, oldDraftId);
  assert.equal(newDraft.fields.customer, 'Như');
  assert.equal(newDraft.fields.phone, '0394200327');
  assert.equal(newDraft.fields.flowerTotal, '350000');
  assert.equal(newDraft.fields.paymentState, 'deposit');
  assert.equal(newDraft.fields.depositAmount, 200000);
  assert.equal(newDraft.fields.time, '13:30');
  assert.match(newDraft.fields.date || '', /^\d{4}-11-27$/);
  assert.equal(newDraft.fields.address, '102/34c Phan Huy Ích, P. Tân Sơn');
  assert.equal(newDraft.fields.note, '“Chúc mừng ngày nhận bằng thật rạng rỡ!”');
  // STRICT NO-GUESSING: flower and shipping must NOT be inherited from old draft or guessed
  assert.equal(newDraft.fields.flower, undefined, 'Must NOT inherit or guess flower');
  assert.equal(newDraft.fields.shipping, undefined, 'Must NOT inherit or guess shipping');
  assert.equal(newDraft.sampleRefs.length, 1);
  assert.equal(newDraft.sampleRefs[0].fileId, 'nhu_photo_1');
  assert.equal(newDraft.sampleRefs[0].data_url, undefined);

  // 3. Reply summary shows 350k, deposit 200k, remaining 150k, OPS sync preview, and missing fields
  const photoReply = sentMessages[sentMessages.length - 1].text;
  assert.ok(photoReply.includes('d4a39f'), 'Must mention old draft was preserved');
  assert.ok(photoReply.includes('350.000 đ'));
  assert.ok(photoReply.includes('Đã cọc 200.000 đ'));
  assert.ok(photoReply.includes('còn lại: 150.000 đ'));
  assert.ok(!photoReply.includes('[Khách báo:'));
  assert.ok(photoReply.includes('mẫu hoa'));
  assert.ok(photoReply.includes('hình thức ship'));

  // 4. /confirm MUST be blocked while flower and shipping are missing (zero OPS calls)
  const missing = requiredMissing(newDraft);
  assert.ok(missing.includes('mẫu hoa'));
  assert.ok(missing.includes('hình thức ship'));

  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99602,
      message: { message_id: 11, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
    }),
    env
  );
  assert.equal(opsCalls.length, 0, '/confirm must be blocked when flower & shipping are missing');

  // 5. Duplicate Telegram delivery of the same update_id must be ignored cleanly
  const resDup = await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99601,
      message: {
        message_id: 10,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'nhu_photo_1', file_unique_id: 'uniq_nhu_1' }],
        caption: literalCaption
      }
    }),
    env
  );
  assert.equal(resDup.status, 200);
  assert.match(await resDup.text(), /Already Processed/);
  const draftsAfterDup = await loadDrafts(db, 5252724920);
  assert.equal(Object.keys(draftsAfterDup).filter(k => !k.startsWith('__')).length, 2, 'Duplicate update_id must not create 3rd draft');

  // 6. Supplement missing flower + shipping, then /confirm -> OPS gets exact 350k, unpaid payment, deposit in note, 1 photo
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99603,
      message: {
        message_id: 12,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        text: 'mẫu hoa: Bó hướng dương tốt nghiệp\nhình thức: Shop book ship'
      }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99604,
      message: { message_id: 13, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
    }),
    env
  );

  assert.equal(opsCalls.length, 1);
  const sentOrder = opsCalls[0].payload.order;
  assert.equal(sentOrder.customer, 'Như');
  assert.equal(sentOrder.phone, '0394200327');
  assert.equal(sentOrder.flower, 'Bó hướng dương tốt nghiệp');
  assert.equal(sentOrder.flowerTotal, 350000);
  assert.equal(sentOrder.shipping, 'Shop book ship');
  assert.equal(sentOrder.address, '102/34c Phan Huy Ích, P. Tân Sơn');
  assert.equal(sentOrder.payment, 'Đã cọc 200.000 đ', 'OPS payment must record owner-verified deposit');
  assert.equal(sentOrder.fullPaidRequested, false);
  assert.ok(!String(sentOrder.note || '').includes('[Khách báo:'), 'Must not add [Khách báo: ...] to note');
  assert.equal(sentOrder.imageFiles.length, 1);

  // 7. Repeating /confirm on submitted draft must NEVER create a duplicate order
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99605,
      message: { message_id: 14, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
    }),
    env
  );
  assert.equal(opsCalls.length, 1, 'Duplicate /confirm must not create second OPS order');
});

test('Contract 12: Supplementary photo attaches to active draft; ambiguous conflicting photo+caption asks user instead of silently merging', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/p.jpg', file_size: 1024 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5]));
    }
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // Start directly by sending 1 sample photo with caption (no /new needed!)
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99701,
      message: {
        message_id: 1,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'p_init', file_unique_id: 'u_init' }],
        caption: 'khách: Chị An\nhoa: Bó hồng đỏ 500k\ngiờ: 10:00\nship: Ghé lấy'
      }
    }),
    env
  );

  let drafts = await loadDrafts(db, 5252724920);
  const draft1Id = activeDraft(drafts).id;
  assert.equal(drafts[draft1Id].sampleRefs.length, 1);
  assert.equal(drafts[draft1Id].fields.customer, 'Chị An');

  // 1. Supplementary photo (short non-order label "góc chụp khác") -> safely attaches to same draft
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99702,
      message: {
        message_id: 2,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'p_supp', file_unique_id: 'u_supp' }],
        caption: 'góc chụp khác'
      }
    }),
    env
  );

  drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts.__active, draft1Id, 'Supplementary photo must keep same active draft');
  assert.equal(drafts[draft1Id].sampleRefs.length, 2);

  // 2. Ambiguous photo+caption (conflicting flower & price without customer/phone) -> asks user, does NOT mutate draft1!
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99703,
      message: {
        message_id: 3,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'p_ambig', file_unique_id: 'u_ambig' }],
        caption: 'Giỏ hoa lan hồ điệp 1.2tr'
      }
    }),
    env
  );

  drafts = await loadDrafts(db, 5252724920);
  assert.ok(drafts.__pendingPhoto, 'Ambiguous photo must be held in __pendingPhoto');
  assert.equal(drafts[draft1Id].sampleRefs.length, 2, 'Active draft must NOT be mutated while ambiguous');
  assert.equal(drafts[draft1Id].fields.flower, 'Bó hồng đỏ 500k');
  assert.equal(drafts[draft1Id].fields.flowerTotal, '500000');
  assert.match(sentMessages[sentMessages.length - 1].text, /\/new_from_photo/);
  assert.match(sentMessages[sentMessages.length - 1].text, /\/attach/);

  // 3. Operator picks "1" (create new draft from pending photo) -> creates clean draft 2, leaves draft 1 untouched, cleans pending R2 key
  const pendingKey = drafts.__pendingPhoto.r2_key;
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99704,
      message: { message_id: 4, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '1' }
    }),
    env
  );

  drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts.__pendingPhoto, undefined);
  assert.equal(r2.objects.has(pendingKey), false, 'Temporary pending R2 key must be cleaned up after move');
  const draft2 = activeDraft(drafts);
  assert.notEqual(draft2.id, draft1Id);
  assert.equal(draft2.fields.flower, 'Giỏ hoa lan hồ điệp 1.2tr');
  assert.equal(draft2.fields.flowerTotal, '1200000');
  assert.equal(draft2.fields.customer, undefined, 'New draft must NOT inherit customer from draft 1');
  assert.equal(draft2.sampleRefs.length, 1);
  assert.equal(r2.objects.has(draft2.sampleRefs[0].r2_key), true);

  // Draft 1 still completely intact
  assert.equal(drafts[draft1Id].fields.customer, 'Chị An');
  assert.equal(drafts[draft1Id].sampleRefs.length, 2);

  // 4. Operator can also explicitly choose /attach (2) when updating same draft with a new sample photo
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99705,
      message: {
        message_id: 5,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'p_attach_update', file_unique_id: 'u_attach_upd' }],
        caption: 'Giỏ hoa lan hồ điệp trắng 1.5tr'
      }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99706,
      message: { message_id: 6, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/attach' }
    }),
    env
  );
  drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts.__active, draft2.id);
  assert.equal(drafts[draft2.id].sampleRefs.length, 2);
  assert.equal(drafts[draft2.id].fields.flowerTotal, '1500000');
});

test('Contract 13: Repeated /new on empty draft does not spawn duplicate drafts; text amendment updates active draft cleanly', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // Press /new 3 times rapidly
  for (let i = 1; i <= 3; i++) {
    await handleTelegramWebhook(
      makeWebhookRequest({
        update_id: 99800 + i,
        message: { message_id: i, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
      }),
      env
    );
  }

  let drafts = await loadDrafts(db, 5252724920);
  const ids = Object.keys(drafts).filter(k => !k.startsWith('__'));
  assert.equal(ids.length, 1, 'Repeated /new on empty draft must keep exactly 1 draft');
  assert.match(sentMessages[sentMessages.length - 1].text, /đang mở sẵn/);

  // Text amendment updates active draft without creating another draft
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99810,
      message: {
        message_id: 10,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        text: 'Tổng 350k cọc 200k\nNhư + 0394200327\nđịa chỉ nhận: 102/34c Phan Huy Ích'
      }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 99811,
      message: {
        message_id: 11,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        text: 'tổng: 420k\nđịa chỉ nhận: 99 Nguyễn Huệ, Q.1'
      }
    }),
    env
  );

  drafts = await loadDrafts(db, 5252724920);
  assert.equal(Object.keys(drafts).filter(k => !k.startsWith('__')).length, 1);
  const d = drafts[drafts.__active];
  assert.equal(d.fields.customer, 'Như');
  assert.equal(d.fields.flowerTotal, '420000');
  assert.equal(d.fields.depositAmount, 200000);
  assert.equal(d.fields.address, '99 Nguyễn Huệ, Q.1');
  assert.equal(d.fields.shipping, undefined, 'Address alone must never guess shipping');
});

// ---------------------------------------------------------------------------
// Helpers for Real OPS Runtime Integration Contracts (createCore + D1 + R2)
// ---------------------------------------------------------------------------

async function sha256Hex(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createRealOpsHarness() {
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const sqlite = new DatabaseSync(':memory:');
  const opsBase = process.env.OPS_RUNTIME_DIR
    ? path.resolve(process.env.OPS_RUNTIME_DIR)
    : path.resolve(__dirname, '..', 'cloudflare-migration');
  const schemaPath = fs.existsSync(path.join(opsBase, 'schema', 'schema.sql'))
    ? path.join(opsBase, 'schema', 'schema.sql')
    : path.join(opsBase, 'generated', 'schema.sql');
  const opsSchema = fs.readFileSync(schemaPath, 'utf8');
  const botSchema = fs.readFileSync(path.resolve(__dirname, '..', 'order-bot', 'cloudflare', 'schema.sql'), 'utf8');
  sqlite.exec(opsSchema);
  sqlite.exec(botSchema);

  const db = {
    sqlite,
    prepare(sql) {
      const bindStmt = (boundArgs = []) => ({
        bind(...args) {
          return bindStmt(args);
        },
        first: async () => sqlite.prepare(sql).get(...boundArgs) || null,
        all: async () => ({ results: sqlite.prepare(sql).all(...boundArgs), success: true, meta: { changes: 0 } }),
        run: async () => {
          const info = sqlite.prepare(sql).run(...boundArgs);
          return { success: true, meta: { changes: Number(info.changes || 0) } };
        }
      });
      return bindStmt([]);
    },
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const stmt of stmts || []) {
          out.push(await stmt.run());
        }
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    }
  };

  const r2 = createMockR2();
  const opsToken = 'a'.repeat(64);
  const tokenHash = await sha256Hex(opsToken);

  await db.prepare('INSERT INTO app_users(row_key, data) VALUES (?, ?)')
    .bind('cmui', JSON.stringify({ username: 'cmui', display_name: 'C Mụi', role: 'ADMIN', active: true }))
    .run();
  await db.prepare('INSERT INTO app_sessions(row_key, data) VALUES (?, ?)')
    .bind(tokenHash, JSON.stringify({ token_hash: tokenHash, username: 'cmui', expires_at: '2099-12-31T23:59:59.000Z' }))
    .run();

  const { createCore } = await import(pathToFileURL(path.join(opsBase, 'runtime', 'core.js')).href);
  const rawOpsHandler = createCore({
    DB: db,
    MEDIA_R2: r2,
    MEDIA_SIGNING_KEY: 'staging-media-signing-key',
    LEGACY_PASSWORD_SALT: 'MEE-FLOWER-V4'
  });
  // Cloudflare Service Binding fetch(url, init) accepts both Request and (url, init); wrap core handler accordingly.
  const opsHandler = (input, init) => rawOpsHandler(input instanceof Request ? input : new Request(input, init));

  async function callOpsApi(name, payload) {
    const res = await opsHandler(new Request('https://meehoasg-ops-staging.meehoasg.workers.dev/api-core', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, payload: { token: opsToken, ...payload } })
    }));
    return res.json();
  }

  return { db, r2, opsToken, opsHandler, callOpsApi };
}

test('Contract 14: End-to-end Bot -> Real OPS Runtime records unpaid, partial deposit (350k/200k), deposit==total, and reconciles Debt/Dashboard/KPI/FullPaid', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { db, r2, opsToken, opsHandler, callOpsApi } = await createRealOpsHarness();
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/sample.jpg', file_size: 1024 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
    }
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: opsToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: { fetch: opsHandler },
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const sendMsg = async (updateId, msg) => handleTelegramWebhook(
    makeWebhookRequest({ update_id: updateId, message: { message_id: updateId, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, ...msg } }),
    env
  );

  // Order A: Unpaid (500k)
  await sendMsg(14001, { text: '/new' });
  await sendMsg(14002, {
    photo: [{ file_id: 'p_a1', file_unique_id: 'u_a1' }],
    caption: 'khách: Khách An\nhoa: Bó hồng 500k\nngày: 2026-12-20\ngiờ: 10h\nship: Ghé lấy\nchưa thanh toán'
  });
  await sendMsg(14003, { text: '/confirm' });

  // Order B: Deposit 200k on 350k flowerTotal (exact staging scenario)
  await sendMsg(14004, {
    photo: [{ file_id: 'p_b1', file_unique_id: 'u_b1' }],
    caption: 'Tổng 350k cọc 200k\nNhư + 0394200327\n20/12/2026 & 13h30\nhoa: Bó hướng dương\nship: Ghé lấy'
  });
  await sendMsg(14005, { text: '/confirm' });
  const replyOrderB = sentMessages[sentMessages.length - 1].text;
  assert.ok(replyOrderB.includes('Đã cọc 200.000 đ'), 'Telegram reply must reflect actual OPS deposit status');
  assert.ok(replyOrderB.includes('200.000 đ'), 'Telegram reply must show paid amount from OPS');
  assert.ok(replyOrderB.includes('150.000 đ'), 'Telegram reply must show remaining debt from OPS');

  // Order C: Deposit == Total (350k/350k)
  await sendMsg(14006, {
    photo: [{ file_id: 'p_c1', file_unique_id: 'u_c1' }],
    caption: 'Tổng 350k cọc 350k\nNgọc + 0909111222\n20/12/2026 & 16h\nhoa: Bó tulip\nship: Ghé lấy'
  });
  await sendMsg(14007, { text: '/confirm' });

  const ordersRes = await callOpsApi('getOrders', { start: '2026-12-20', end: '2026-12-20' });
  assert.equal(ordersRes.ok, true);
  assert.equal(ordersRes.items.length, 3);

  const ordA = ordersRes.items.find(o => o.customer === 'Khách An');
  const ordB = ordersRes.items.find(o => o.customer === 'Như');
  const ordC = ordersRes.items.find(o => o.customer === 'Ngọc');

  assert.equal(ordA.payment, 'Chưa thanh toán');
  assert.equal(ordA.paid, 0);
  assert.equal(ordA.debt, 500000);
  assert.equal(ordA.paymentVerified, false);

  assert.equal(ordB.payment, 'Đã cọc 200.000 đ');
  assert.equal(ordB.paid, 200000);
  assert.equal(ordB.debt, 150000);
  assert.equal(ordB.fullPaid, false);
  assert.equal(ordB.paymentVerified, false);
  assert.ok(!String(ordB.note || '').includes('[Khách báo:'));

  assert.equal(ordC.payment, 'Đã cọc 350.000 đ');
  assert.equal(ordC.paid, 350000);
  assert.equal(ordC.debt, 0);
  assert.equal(ordC.paymentVerified, false);

  // Move all 3 orders to Đã giao through valid OPS state transitions to inspect Debt & Financial reports
  for (const ord of [ordA, ordB, ordC]) {
    const r0 = await callOpsApi('updateStatus', {
      orderId: ord.id,
      expectedUpdatedAt: ord.updatedAt,
      status: 'Đã bó',
      requestId: `req-pack-${ord.id}`
    });
    assert.equal(r0.ok, true, `updateStatus Đã bó failed: ${r0.message}`);
    const r1 = await callOpsApi('updateStatus', {
      orderId: ord.id,
      expectedUpdatedAt: r0.order.updatedAt,
      status: 'Đã giao',
      requestId: `req-deliver-${ord.id}`
    });
    assert.equal(r1.ok, true, `updateStatus Đã giao failed: ${r1.message}`);
  }

  const dash = await callOpsApi('getDashboardSummary', { start: '2026-12-20', end: '2026-12-20' });
  assert.equal(dash.ok, true);
  assert.equal(dash.summary.orders, 3);
  assert.equal(dash.summary.grossRevenue, 1200000);
  assert.equal(dash.summary.debt, 650000, 'Total debt = 500k (unpaid) + 150k (350k-200k deposit) + 0 (350k-350k)');
  assert.equal(dash.summary.settledRevenue, 0, 'Deposits are NOT full-settled revenue until settlement/Full Paid');
  assert.equal(dash.summary.unsettledRevenue, 1200000);

  const debtReview = await callOpsApi('getDebtReview', { start: '2026-12-20', end: '2026-12-20' });
  assert.equal(debtReview.ok, true);
  assert.equal(debtReview.items.length, 2, 'Only orders with debt > 0 appear in Debt Review');
  assert.equal(debtReview.summary.debt, 650000);

  const kpi = await callOpsApi('getKpi', { month: '2026-12' });
  assert.equal(kpi.ok, true);
  assert.equal(kpi.items.length, 0, 'Commission KPI must stay 0 before settlement/Full Paid verification');

  const fpReport = await callOpsApi('getFullPaidReport', { month: '2026-12' });
  assert.equal(fpReport.ok, true);
  assert.equal(fpReport.items.length, 0, 'Full Paid report must not include deposit/sample orders');
});

test('Contract 15: Over-deposit (> total) is blocked until corrected; editing money after deposit recalculates remaining cleanly and preserves OPS images on update', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { syncOrderPaymentToOps } = await import('../order-bot/cloudflare/ops-client.mjs');
  const { db, r2, opsToken, opsHandler, callOpsApi } = await createRealOpsHarness();

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s.jpg', file_size: 1024 } }));
    if (url.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]));
    if (url.includes('/sendMessage')) return new Response(JSON.stringify({ ok: true }));
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: opsToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: { fetch: opsHandler },
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const sendMsg = async (updateId, msg) => handleTelegramWebhook(
    makeWebhookRequest({ update_id: updateId, message: { message_id: updateId, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, ...msg } }),
    env
  );

  // 1. Over-deposit (500k on 350k total) flags uncertainFields and blocks /confirm
  await sendMsg(15001, {
    photo: [{ file_id: 'p_over', file_unique_id: 'u_over' }],
    caption: 'Tổng 350k cọc 500k\nKhách Test Over\n20/12/2026 & 14h\nhoa: Bó baby\nship: Ghé lấy'
  });
  let drafts = await loadDrafts(db, 5252724920);
  let draft = drafts[drafts.__active];
  assert.ok(draft.uncertainFields.depositAmount, 'Over-deposit must be flagged in uncertainFields');

  await sendMsg(15002, { text: '/confirm' });
  let ordersRes = await callOpsApi('getOrders', { start: '2026-12-20', end: '2026-12-20' });
  assert.equal(ordersRes.items.length, 0, '/confirm must be blocked while depositAmount > totalDue');

  // 2. Fix deposit to 200k (>= 50% of 350k) then edit flowerTotal to 450k -> 200k < 225k (50%) gets flagged; fixing deposit to 250k passes
  await sendMsg(15003, { text: 'cọc: 200k' });
  drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts[drafts.__active].uncertainFields.depositAmount, undefined);

  await sendMsg(15004, { text: 'tiền hoa: 450k' });
  drafts = await loadDrafts(db, 5252724920);
  draft = drafts[drafts.__active];
  assert.ok(draft.uncertainFields.depositAmount, '200k on 450k (<50%) must be flagged after flowerTotal increases');

  await sendMsg(15005, { text: 'cọc: 250k' });
  drafts = await loadDrafts(db, 5252724920);
  draft = drafts[drafts.__active];
  assert.equal(draft.uncertainFields.depositAmount, undefined);
  assert.equal(draft.fields.depositAmount, 250000);
  assert.equal(draft.fields.flowerTotal, '450000');

  await sendMsg(15006, { text: '/confirm' });
  ordersRes = await callOpsApi('getOrders', { start: '2026-12-20', end: '2026-12-20' });
  assert.equal(ordersRes.items.length, 1);
  assert.equal(ordersRes.items[0].paid, 250000);
  assert.equal(ordersRes.items[0].debt, 200000);
  assert.equal(ordersRes.items[0].imageUrls.length, 1);

  // 3. Updating payment afterwards via valid OPS updateOrder preserves existing sample image URLs
  const updatedSync = await syncOrderPaymentToOps({
    opsUrl: env.OPS_API_URL,
    opsToken,
    orderId: ordersRes.items[0].id,
    expectedPayment: 'Đã cọc 300.000 đ',
    expectedPaid: 300000,
    requestId: 'req-edit-deposit-300',
    fetcher: opsHandler
  });
  assert.equal(updatedSync.ok, true, `syncOrderPaymentToOps should succeed: ${updatedSync.message}`);
  assert.equal(updatedSync.order.paid, 300000);
  assert.equal(updatedSync.order.debt, 150000);
  assert.equal(updatedSync.order.imageUrls.length, 1, 'Existing order sample image must be preserved across updateOrder');
});

test('Contract 16: Step-2 failure & double-deposit lock: no duplicate order on retry, /retry_payment repairs legacy pre-deposit order cleanly', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { db, r2, opsToken, opsHandler, callOpsApi } = await createRealOpsHarness();
  const sentMessages = [];
  let failUpdateOnce = true;

  // Wrap real opsHandler to simulate Step-2 updateOrder failure on first attempt AND createOrder initially writing Chưa thanh toán
  const flakyOpsService = {
    async fetch(input, init) {
      const req = input instanceof Request ? input : new Request(input, init);
      const clone = req.clone();
      const body = await clone.json();
      if (body.name === 'createOrder') {
        // Simulate OPS temporarily returning Chưa thanh toán on create (forcing Step-2 payment sync path)
        body.payload.order.payment = 'Chưa thanh toán';
        return opsHandler(new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body) }));
      }
      if (body.name === 'updateOrder' && failUpdateOnce) {
        failUpdateOnce = false;
        return new Response(JSON.stringify({ ok: false, message: 'OPS timeout during deposit update' }), { status: 503 });
      }
      return opsHandler(req);
    }
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s.jpg', file_size: 1024 } }));
    if (url.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7]));
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: opsToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: flakyOpsService,
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const sendMsg = async (updateId, msg) => handleTelegramWebhook(
    makeWebhookRequest({ update_id: updateId, message: { message_id: updateId, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, ...msg } }),
    env
  );

  await sendMsg(16001, {
    photo: [{ file_id: 'p_step', file_unique_id: 'u_step' }],
    caption: 'Tổng 350k cọc 200k\nChị Retry\n20/12/2026 & 11h\nhoa: Bó hồng\nship: Ghé lấy\nnote: Chúc mừng [Khách báo: Đã cọc 200.000 đ]'
  });
  await sendMsg(16002, { text: '/confirm' });

  // Order created (1 total), deposit NOT yet synced, clear warning sent
  let ordersRes = await callOpsApi('getOrders', { start: '2026-12-20', end: '2026-12-20' });
  assert.equal(ordersRes.items.length, 1);
  assert.equal(ordersRes.items[0].paid, 0);
  const createdOrderId = ordersRes.items[0].id;
  assert.ok(sentMessages[sentMessages.length - 1].text.includes('/retry_payment'));

  let drafts = await loadDrafts(db, 5252724920);
  let draft = drafts[drafts.__active];
  assert.equal(draft.status, 'submitted');
  assert.equal(draft.opsOrderId, createdOrderId);
  assert.equal(draft.paymentSynced, false);

  // Run /retry_payment -> syncs deposit via updateOrder cleanly without creating 2nd order
  await sendMsg(16003, { text: '/retry_payment' });
  ordersRes = await callOpsApi('getOrders', { start: '2026-12-20', end: '2026-12-20' });
  assert.equal(ordersRes.items.length, 1, 'Retry MUST NOT create a second order');
  assert.equal(ordersRes.items[0].payment, 'Đã cọc 200.000 đ');
  assert.equal(ordersRes.items[0].paid, 200000);
  assert.equal(ordersRes.items[0].debt, 150000);
  assert.equal(ordersRes.items[0].note, 'Chúc mừng');
  assert.equal(ordersRes.items[0].imageUrls.length, 1);

  drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts[drafts.__active].paymentSynced, true);

  // Double-deposit lock: repeated /retry_payment or /confirm must NOT write updateOrder a second time
  const logsBefore = await db.prepare("SELECT COUNT(*) as cnt FROM activity_log WHERE json_extract(data, '$.action') = 'updateOrder'").first();
  await sendMsg(16004, { text: `/retry_payment ${createdOrderId}` });
  await sendMsg(16005, { text: '/confirm' });
  const logsAfter = await db.prepare("SELECT COUNT(*) as cnt FROM activity_log WHERE json_extract(data, '$.action') = 'updateOrder'").first();
  assert.equal(logsAfter.cnt, logsBefore.cnt, 'Double-deposit lock must block repeat updateOrder');
  assert.ok(sentMessages.some(m => m.text.includes('chặn ghi lặp')));
});

test('Contract 17: Crash/stuck-confirming recovery & Full Paid deferral: never auto-marks Full Paid from sample photo and keeps idempotency in OPS', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts, saveDrafts, findStaleConfirming, resetStaleConfirming } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { db, r2, opsToken, opsHandler, callOpsApi } = await createRealOpsHarness();
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s.jpg', file_size: 1024 } }));
    if (url.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5]));
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: opsToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: { fetch: opsHandler },
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // Seed a draft stuck in confirming after simulated worker interruption (requestId already fixed)
  const sampleKey = 'order-images/sample-crash-01.jpg';
  await r2.put(sampleKey, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5]), { httpMetadata: { contentType: 'image/jpeg' } });
  const stuckDraftId = 'draft-crash-recover-01';
  await saveDrafts(db, 5252724920, {
    __active: stuckDraftId,
    [stuckDraftId]: {
      id: stuckDraftId,
      status: 'confirming',
      requestId: 'req-crash-fixed-01',
      fields: {
        customer: 'Crash Recover',
        flower: 'Bó ly hồng',
        flowerTotal: '400000',
        date: '2026-12-21',
        time: '15:00',
        shipping: 'Ghé lấy',
        paymentState: 'deposit',
        depositAmount: 200000
      },
      sampleRefs: [{ fileId: 'f1', r2_key: sampleKey, uri: `supabase://${sampleKey}`, mimeType: 'image/jpeg' }],
      draftBillRefs: [],
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      createdAt: '2026-12-01T00:00:00.000Z'
    }
  });

  // Stale-confirming recovery resets status -> confirmed while keeping fixed requestId
  const stale = await findStaleConfirming(db, 15);
  assert.equal(stale.length, 1);
  assert.equal(await resetStaleConfirming(db, 5252724920, stuckDraftId), true);

  // Recovery /confirm finishes creating the single order with exact deposit
  await handleTelegramWebhook(
    makeWebhookRequest({ update_id: 17001, message: { message_id: 17001, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' } }),
    env
  );
  // Duplicate Telegram delivery of the same update_id or another /confirm creates zero duplicates
  await handleTelegramWebhook(
    makeWebhookRequest({ update_id: 17001, message: { message_id: 17001, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' } }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({ update_id: 17002, message: { message_id: 17002, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' } }),
    env
  );

  const ordersRes = await callOpsApi('getOrders', { start: '2026-12-21', end: '2026-12-21' });
  assert.equal(ordersRes.items.length, 1);
  assert.equal(ordersRes.items[0].paid, 200000);
  assert.equal(ordersRes.items[0].debt, 200000);

  // New Full Paid message with ONLY sample photo -> blocked at /confirm (must supply bill later at OPS / send bill)
  await handleTelegramWebhook(
    makeWebhookRequest({
      update_id: 17003,
      message: {
        message_id: 17003,
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        photo: [{ file_id: 'p_fp', file_unique_id: 'u_fp' }],
        caption: 'Khách Full\nhoa: Bó cúc 300k\nngày: 2026-12-22\ngiờ: 10h\nship: Ghé lấy\nfullpaid'
      }
    }),
    env
  );
  await handleTelegramWebhook(
    makeWebhookRequest({ update_id: 17004, message: { message_id: 17004, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' } }),
    env
  );
  const fpOrders = await callOpsApi('getOrders', { start: '2026-12-22', end: '2026-12-22' });
  assert.equal(fpOrders.items.length, 0, 'Full Paid with only sample photo must be blocked until bill is attached');
  const draftsNow = await loadDrafts(db, 5252724920);
  assert.equal(draftsNow[draftsNow.__active].fields.paymentState, 'fullpaid');
  assert.ok(sentMessages[sentMessages.length - 1].text.includes('ảnh bill'));
});

test('Contract 18: /retry_payment & /relink reject wrong, unknown, non-submitted, or ambiguous order codes without touching any order', async () => {
  const { handleTelegramWebhook, resolveSubmittedDraftTarget } = await import('../order-bot/cloudflare/worker.mjs');
  const { saveDrafts, loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { db, r2, opsToken, opsHandler } = await createRealOpsHarness();
  const sentMessages = [];
  const opsCalls = [];

  const trackedOpsService = {
    async fetch(input, init) {
      const req = input instanceof Request ? input : new Request(input, init);
      const clone = req.clone();
      opsCalls.push(await clone.json());
      return opsHandler(req);
    }
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // Seed 2 real OPS orders (including MEE-EDE8086A83B24D73-style unpaid reference & another sharing suffix "99")
  const ord1 = {
    id: 'MEE-EDE8086A83B24D99',
    updated_at: '2026-11-26T06:26:53.991Z',
    customer: 'Như',
    phone: '0394200327',
    order_date: '2026-11-27',
    order_time: '13:30',
    flower: 'Ly nhuộm xanh navy',
    note: 'Đơn đối chiếu',
    shipping: 'Shop book ship',
    address: '102/34c Phan huy ích, P. Tân Sơn',
    flower_total: 350000,
    payment: 'Chưa thanh toán',
    sale: 'cmui',
    card: false,
    card_qty: 0,
    card_text: '',
    banner: false,
    banner_text: '',
    charm_fee: 0,
    charm_text: '',
    paper_fee: 0,
    paper_text: '',
    vat: 0,
    ship_fee: 0,
    ship_confirmed: false,
    settled: false,
    full_paid: false,
    image_urls: ['supabase://order-images/sample-1.jpg'],
    unverified_bill_urls: []
  };
  const ord2 = {
    ...ord1,
    id: 'MEE-BBBBBBBBBBBBBB99',
    customer: 'Khách Hai',
    flower_total: 500000,
    updated_at: '2026-11-26T06:27:00.000Z'
  };
  await db.prepare('INSERT INTO orders(row_key, data) VALUES (?, ?)').bind(ord1.id, JSON.stringify(ord1)).run();
  await db.prepare('INSERT INTO orders(row_key, data) VALUES (?, ?)').bind(ord2.id, JSON.stringify(ord2)).run();

  const billKey = 'settlement-bills/unverified-test-bill.jpg';
  await r2.put(billKey, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]), { httpMetadata: { contentType: 'image/jpeg' } });

  const initialDrafts = {
    __active: 'draft-sub-01',
    'draft-sub-01': {
      id: 'draft-sub-01',
      status: 'submitted',
      opsOrderId: ord1.id,
      paymentSynced: false,
      submittedAt: '2026-11-26T06:26:54.000Z',
      fields: {
        customer: 'Như',
        flowerTotal: '350000',
        paymentState: 'deposit',
        depositAmount: 200000,
        note: 'Đơn đối chiếu'
      },
      draftBillRefs: [{ fileId: 'bill_1', r2_key: billKey, uri: `supabase://${billKey}` }]
    },
    'draft-sub-02': {
      id: 'draft-sub-02',
      status: 'submitted',
      opsOrderId: ord2.id,
      paymentSynced: false,
      submittedAt: '2026-11-26T06:27:01.000Z',
      fields: {
        customer: 'Khách Hai',
        flowerTotal: '500000',
        paymentState: 'deposit',
        depositAmount: 250000
      },
      draftBillRefs: [{ fileId: 'bill_2', r2_key: billKey, uri: `supabase://${billKey}` }]
    },
    'draft-pending-03': {
      id: 'draft-pending-03',
      status: 'pending',
      fields: { customer: 'Nháp Chưa Gửi', flowerTotal: '400000', paymentState: 'deposit', depositAmount: 200000 },
      draftBillRefs: []
    },
    'draft-foreign-04': {
      id: 'draft-foreign-04',
      userId: 999999999,
      status: 'submitted',
      opsOrderId: 'MEE-FOREIGN00000001',
      paymentSynced: false,
      fields: { customer: 'Foreign', flowerTotal: '400000', paymentState: 'deposit', depositAmount: 200000 },
      draftBillRefs: [{ fileId: 'bill_4', r2_key: billKey, uri: `supabase://${billKey}` }]
    }
  };
  // Set active draft to pending to verify omitting arg NEVER jumps to submitted drafts
  const draftsWithPendingActive = { ...initialDrafts, __active: 'draft-pending-03' };
  await saveDrafts(db, 5252724920, draftsWithPendingActive);

  // Unit assertions on resolveSubmittedDraftTarget strict exact OPS ID & active-only rules
  assert.deepEqual(
    { ok: resolveSubmittedDraftTarget(initialDrafts, 'MEE-WRONG-CODE', 5252724920).ok, reason: resolveSubmittedDraftTarget(initialDrafts, 'MEE-WRONG-CODE', 5252724920).reason },
    { ok: false, reason: 'NOT_FOUND' }
  );
  // Unique suffix of OPS ID MUST BE REJECTED
  assert.deepEqual(
    { ok: resolveSubmittedDraftTarget(initialDrafts, '8086A83B24D99', 5252724920).ok, reason: resolveSubmittedDraftTarget(initialDrafts, '8086A83B24D99', 5252724920).reason },
    { ok: false, reason: 'EXACT_OPS_ID_REQUIRED' }
  );
  // Ambiguous suffix MUST BE REJECTED
  assert.deepEqual(
    { ok: resolveSubmittedDraftTarget(initialDrafts, '99', 5252724920).ok, reason: resolveSubmittedDraftTarget(initialDrafts, '99', 5252724920).reason },
    { ok: false, reason: 'EXACT_OPS_ID_REQUIRED' }
  );
  // Full draft ID & short draft ID MUST BE REJECTED
  assert.deepEqual(
    { ok: resolveSubmittedDraftTarget(initialDrafts, 'draft-sub-01', 5252724920).ok, reason: resolveSubmittedDraftTarget(initialDrafts, 'draft-sub-01', 5252724920).reason },
    { ok: false, reason: 'EXACT_OPS_ID_REQUIRED' }
  );
  assert.deepEqual(
    { ok: resolveSubmittedDraftTarget(initialDrafts, 'sub-01', 5252724920).ok, reason: resolveSubmittedDraftTarget(initialDrafts, 'sub-01', 5252724920).reason },
    { ok: false, reason: 'EXACT_OPS_ID_REQUIRED' }
  );
  // Foreign draft MUST BE REJECTED
  assert.deepEqual(
    { ok: resolveSubmittedDraftTarget(initialDrafts, 'MEE-FOREIGN00000001', 5252724920).ok, reason: resolveSubmittedDraftTarget(initialDrafts, 'MEE-FOREIGN00000001', 5252724920).reason },
    { ok: false, reason: 'NOT_AUTHORIZED' }
  );
  // Omitting arg when active draft is pending MUST BE REJECTED (no fallback to submitted drafts)
  assert.deepEqual(
    { ok: resolveSubmittedDraftTarget(draftsWithPendingActive, '', 5252724920).ok, reason: resolveSubmittedDraftTarget(draftsWithPendingActive, '', 5252724920).reason },
    { ok: false, reason: 'ACTIVE_NOT_SUBMITTED' }
  );
  // Only exact full OPS ID (case-insensitive) OR active submitted draft without arg succeeds
  assert.equal(resolveSubmittedDraftTarget(initialDrafts, 'mee-ede8086a83b24d99', 5252724920).draft.id, 'draft-sub-01');
  assert.equal(resolveSubmittedDraftTarget(initialDrafts, '', 5252724920).draft.id, 'draft-sub-01');

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: opsToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: trackedOpsService,
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const sendCmd = (updateId, text) => handleTelegramWebhook(
    makeWebhookRequest({ update_id: updateId, message: { message_id: updateId, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text } }),
    env
  );

  // Wrong code, unique suffix, ambiguous suffix, full/short draft ID, foreign code, and omitted arg with non-submitted active draft MUST ALL make 0 OPS calls
  const badCommands = [
    '/retry_payment MEE-KHONG-TON-TAI',
    '/retry_payment 8086A83B24D99',
    '/retry_payment 99',
    '/retry_payment draft-sub-01',
    '/retry_payment sub-01',
    '/retry_payment MEE-FOREIGN00000001',
    '/retry_payment',
    '/relink MEE-KHONG-TON-TAI',
    '/relink 8086A83B24D99',
    '/relink 99',
    '/relink draft-sub-01',
    '/relink sub-01',
    '/relink MEE-FOREIGN00000001',
    '/relink'
  ];

  for (let i = 0; i < badCommands.length; i++) {
    const res = await sendCmd(18001 + i, badCommands[i]);
    assert.equal(res.status, 200);
    assert.ok(sentMessages[sentMessages.length - 1].text.includes('Không có đơn nào bị thay đổi'));
  }

  assert.equal(opsCalls.length, 0, 'Every invalid /retry_payment & /relink invocation must generate ZERO OPS calls');

  // Verify neither OPS order was altered in payment, note, unverified_bill_urls, or updated_at
  const row1 = JSON.parse((await db.prepare('SELECT data FROM orders WHERE row_key = ?').bind(ord1.id).first()).data);
  const row2 = JSON.parse((await db.prepare('SELECT data FROM orders WHERE row_key = ?').bind(ord2.id).first()).data);
  assert.equal(row1.payment, 'Chưa thanh toán');
  assert.equal(row1.updated_at, ord1.updated_at);
  assert.equal(row1.unverified_bill_urls.length, 0);
  assert.equal(row2.payment, 'Chưa thanh toán');
  assert.equal(row2.updated_at, ord2.updated_at);
  assert.equal(row2.unverified_bill_urls.length, 0);

  // Draft state remains untouched as well
  const draftsAfter = await loadDrafts(db, 5252724920);
  assert.equal(draftsAfter['draft-sub-01'].paymentSynced, false);
  assert.equal(draftsAfter['draft-sub-02'].paymentSynced, false);
});

test('Contract 19: Default sale is C Mụi (cmui), shown in summary, and persisted identically in OPS even when OPS token is ADMIN', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { cmdNew, isDraftEmpty, draftSummary } = await import('../order-bot/core.mjs');
  const { db, r2, opsHandler } = await createRealOpsHarness();
  const sentMessages = [];

  // Seed an ADMIN account + session so we prove bot explicitly sets sale="cmui" instead of relying on cmui token fallback
  const adminToken = 'b'.repeat(64);
  const adminTokenHash = await sha256Hex(adminToken);
  await db.prepare('INSERT INTO app_users(row_key, data) VALUES (?, ?)')
    .bind('al', JSON.stringify({ username: 'al', display_name: 'Alexx Tạ', role: 'ADMIN', active: true }))
    .run();
  await db.prepare('INSERT INTO app_sessions(row_key, data) VALUES (?, ?)')
    .bind(adminTokenHash, JSON.stringify({ token_hash: adminTokenHash, username: 'al', expires_at: '2099-12-31T23:59:59.000Z' }))
    .run();

  // Unit check: cmdNew assigns sale='cmui', keeps isDraftEmpty=true, and draftSummary shows C Mụi
  const created = cmdNew({}, '');
  const emptyDraft = created.drafts[created.drafts.__active];
  assert.equal(emptyDraft.fields.sale, 'cmui');
  assert.equal(isDraftEmpty(emptyDraft), true, 'New draft with default sale=cmui must still count as empty for /new dedup');
  assert.ok(draftSummary(emptyDraft).includes('C Mụi (cmui)'));

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s.jpg', file_size: 1024 } }));
    if (url.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3]));
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: adminToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: { fetch: opsHandler },
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const sendMsg = (id, msg) => handleTelegramWebhook(
    makeWebhookRequest({ update_id: id, message: { message_id: id, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, ...msg } }),
    env
  );

  await sendMsg(19001, { text: '/new' });
  await sendMsg(19002, {
    photo: [{ file_id: 'p_cmui', file_unique_id: 'u_cmui' }],
    caption: 'Khách Sale Test\nhoa: Bó hồng 500k\nngày: 2026-12-25\ngiờ: 10h\nship: Ghé lấy'
  });
  const summaryMsg = sentMessages[sentMessages.length - 1].text;
  assert.ok(summaryMsg.includes('C Mụi (cmui)'), 'Summary after photo+caption must show default sale C Mụi');

  await sendMsg(19003, { text: '/confirm' });
  const confirmMsg = sentMessages[sentMessages.length - 1].text;
  assert.ok(confirmMsg.includes('C Mụi') && confirmMsg.includes('cmui'), 'Confirm reply must verify OPS saved cmui');

  const stored = await opsHandler(new Request('https://meehoasg-ops-staging.meehoasg.workers.dev/api-core', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'getOrders', payload: { token: adminToken, start: '2026-12-25', end: '2026-12-25' } })
  })).then(r => r.json());
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].saleUsername, 'cmui', 'OPS must save canonical sale username cmui even when ADMIN token created order');
  assert.equal(stored.items[0].sale, 'C Mụi');

  const drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts[drafts.__active].fields.sale, 'cmui');
});

test('Contract 20: Mandatory flowerTotal (no 0đ auto-fill) and >=50% deposit threshold on flowerTotal only (excluding ship & accessories) in Bot & OPS', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { normalizeOperationOrder } = await import('../supabase/functions/_shared/operations.js');
  const { db, r2, opsToken, opsHandler, callOpsApi } = await createRealOpsHarness();
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s.jpg', file_size: 1024 } }));
    if (url.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4]));
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: opsToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: { fetch: opsHandler },
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const sendMsg = (id, msg) => handleTelegramWebhook(
    makeWebhookRequest({ update_id: id, message: { message_id: id, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, ...msg } }),
    env
  );

  // 1. Missing flowerTotal -> blocked at /confirm (must ask for flower price, never auto-fill 0 đ)
  await sendMsg(20001, {
    photo: [{ file_id: 'p_noprice', file_unique_id: 'u_noprice' }],
    caption: 'Khách Thiếu Giá\nhoa: Bó hướng dương\nngày: 2026-12-26\ngiờ: 11h\nship: Ghé lấy'
  });
  await sendMsg(20002, { text: '/confirm' });
  assert.ok(sentMessages[sentMessages.length - 1].text.includes('tiền hoa'), 'Must ask for flowerTotal');
  let opsList = await callOpsApi('getOrders', { start: '2026-12-26', end: '2026-12-26' });
  assert.equal(opsList.items.length, 0, 'Order missing flowerTotal must NOT reach OPS');

  // 2. flowerTotal=400k + card(2*10k=20k) + shipFee(50k) => totalDue=470k, but 50% threshold is strictly 200k (50% of 400k flowerTotal)!
  //    Deposit 199k (< 50% of 400k) -> MUST BE BLOCKED even though accessories + ship exist
  await sendMsg(20003, {
    text: 'tiền hoa: 400k\nship: Shop book ship\nđịa chỉ: 10 Nguyễn Huệ, Q.1\nphí ship: 50k\nsl thiệp: 2\nnội dung thiệp: Chúc mừng\ncọc: 199k'
  });
  await sendMsg(20004, { text: '/confirm' });
  assert.ok(sentMessages[sentMessages.length - 1].text.includes('50%'), 'Deposit < 50% of flowerTotal must be blocked');
  opsList = await callOpsApi('getOrders', { start: '2026-12-26', end: '2026-12-26' });
  assert.equal(opsList.items.length, 0);

  // Also verify backend normalizeOperationOrder blocks < 50% deposit independently
  assert.throws(
    () => normalizeOperationOrder({
      customer: 'X', flower: 'Y', date: '2026-12-26', time: '11:00',
      shipping: 'Shop book ship', flowerTotal: 400000, shipFeeActive: '1', shipFee: 50000,
      payment: 'Đã cọc 199.000 đ'
    }, { username: 'cmui', role: 'THO_OPS' }),
    /tối thiểu 50% tiền hoa/
  );

  // 3. Deposit exact 200k (exact 50% of 400k flowerTotal, even though < 50% of 470k total) -> MUST PASS!
  await sendMsg(20005, { text: 'cọc: 200k' });
  await sendMsg(20006, { text: '/confirm' });
  opsList = await callOpsApi('getOrders', { start: '2026-12-26', end: '2026-12-26' });
  assert.equal(opsList.items.length, 1, 'Exact 50% flowerTotal deposit must succeed');
  assert.equal(opsList.items[0].flowerTotal, 400000);
  assert.equal(opsList.items[0].paid, 200000);
  assert.equal(opsList.items[0].debt, 270000, 'Remaining debt = 400k + 20k card + 50k ship - 200k = 270k');
  assert.equal(opsList.items[0].saleUsername, 'cmui');
});

test('Contract 21: Bot dynamically enforces OPS shared getOrderRules on rule change without code/prompt changes and preserves draft on unsupported rules', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { clearOpsOrderRulesCache } = await import('../order-bot/cloudflare/ops-client.mjs');
  const { db, r2, opsToken, opsHandler, callOpsApi } = await createRealOpsHarness();
  const sentMessages = [];

  clearOpsOrderRulesCache();
  let opsRuleMode = 'require_phone';

  const ruleAwareOpsService = {
    async fetch(input, init) {
      const req = input instanceof Request ? input : new Request(input, init);
      const clone = req.clone();
      const body = await clone.json();
      if (body.name === 'getOrderRules') {
        if (opsRuleMode === 'require_phone') {
          return new Response(JSON.stringify({
            ok: true,
            rules: {
              schemaVersion: '2026-11-26.phone-req',
              saleDefault: 'cmui',
              saleDefaultName: 'C Mụi',
              required: ['customer', 'flower', 'date', 'time', 'shipping', 'flowerTotal', 'phone'],
              requireFlowerTotal: true,
              minDepositRatio: 0.5,
              enums: { shipping: ['Shop book ship', 'Khách tự book', 'Ghé lấy'] }
            }
          }));
        }
        if (opsRuleMode === 'unsupported_rule') {
          return new Response(JSON.stringify({
            ok: true,
            rules: {
              schemaVersion: '2026-12-01.future',
              required: ['customer', 'flower', 'date', 'time', 'shipping', 'flowerTotal', 'deliveryWindowCode'],
              supportedRuleFeatures: ['required_fields', 'future_delivery_window']
            }
          }));
        }
      }
      return opsHandler(req);
    }
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s.jpg', file_size: 1024 } }));
    if (url.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 6]));
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: opsToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: ruleAwareOpsService,
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const sendMsg = (id, msg) => handleTelegramWebhook(
    makeWebhookRequest({ update_id: id, message: { message_id: id, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, ...msg } }),
    env
  );

  // 1. Caption normally valid WITHOUT phone -> OPS switched getOrderRules to require phone -> /confirm blocks & asks for SĐT dynamically!
  await sendMsg(21001, {
    photo: [{ file_id: 'p_dyn', file_unique_id: 'u_dyn' }],
    caption: 'Khách Dynamic Rule\nhoa: Bó cúc 450k\nngày: 2026-12-27\ngiờ: 09h\nship: Ghé lấy'
  });
  await sendMsg(21002, { text: '/confirm' });

  const blockReply = sentMessages[sentMessages.length - 1].text;
  assert.ok(blockReply.includes('số điện thoại'), 'Bot must ask for phone dynamically when OPS adds phone to required rules');
  let opsList = await callOpsApi('getOrders', { start: '2026-12-27', end: '2026-12-27' });
  assert.equal(opsList.items.length, 0);

  // 2. While OPS briefly turns on an unsupported rule, bot preserves draft safely without calling OPS createOrder
  opsRuleMode = 'unsupported_rule';
  await sendMsg(21003, { text: 'sđt: 0909888777' });
  await sendMsg(21004, { text: '/confirm' });
  const unsupportedReply = sentMessages[sentMessages.length - 1].text;
  assert.ok(unsupportedReply.includes('chưa hỗ trợ'), 'Bot must hold draft cleanly on unsupported OPS rules');
  let drafts = await loadDrafts(db, 5252724920);
  assert.equal(drafts[drafts.__active].fields.phone, '0909888777');
  assert.equal(drafts[drafts.__active].status, 'pending');

  // 3. OPS back to supported require_phone rule -> since phone is already supplied, /confirm succeeds immediately!
  opsRuleMode = 'require_phone';
  await sendMsg(21005, { text: '/confirm' });
  opsList = await callOpsApi('getOrders', { start: '2026-12-27', end: '2026-12-27' });
  assert.equal(opsList.items.length, 1);
  assert.equal(opsList.items[0].phone, '0909888777');
  assert.equal(opsList.items[0].saleUsername, 'cmui');
});

// ─── Contract 22: cmui pre-confirm permission guard blocks SALE accounts that cannot assign cmui ───

test('Contract 22: /confirm blocks before createOrder when OPS caller cannot assign default sale (cmui); preserves draft', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts, saveDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  const opsRequests = [];

  // Create a "SALE" user named "otherSale" who cannot assign cmui
  let callerResponse = {
    ok: true,
    rules: {
      saleDefault: 'cmui',
      saleDefaultName: 'C Mụi',
      required: ['customer', 'flower', 'date', 'time', 'shipping', 'flowerTotal'],
      requireFlowerTotal: true,
      minDepositRatio: 0.5,
      depositBase: 'flowerTotal',
      supportedRuleFeatures: ['required_fields', 'conditional_required', 'min_deposit_ratio', 'flower_total_required', 'shipping_enum', 'sale_default']
    },
    caller: { username: 'otherSale', role: 'SALE', canAssignDefaultSale: false }
  };

  const trackedOpsService = {
    async fetch(url, opts) {
      opsRequests.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.name === 'getOrderRules') {
        return new Response(JSON.stringify(callerResponse), { status: 200 });
      }
      // createOrder should NEVER be reached
      if (body.name === 'createOrder') {
        return new Response(JSON.stringify({ ok: true, orderId: 'MEE-SHOULD-NOT-EXIST' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, message: 'unknown' }), { status: 200 });
    }
  };

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'fake_ops_token_other_sale',
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: trackedOpsService,
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // Override sendTelegramMessage
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('api.telegram.org')) {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      sentMessages.push({ url: urlStr, text: body.text || '' });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }));
    }
    return origFetch(url, opts);
  };

  try {
    const makeReq = (update) => new Request('https://bot.example.com/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'staging_secret_token_123'
      },
      body: JSON.stringify(update)
    });

    const sendMsg = (updateId, msg) => handleTelegramWebhook(
      makeReq({ update_id: updateId, message: { message_id: updateId, chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, ...msg } }),
      env
    );

    // Seed a complete draft ready for /confirm
    const photoFileId = 'AgACAgTest22Photo';
    r2.objects.set(`meehoa-bot/5252724920/sample-${photoFileId}`, {
      body: Buffer.from('fake-photo-data'),
      httpMetadata: { contentType: 'image/jpeg' }
    });

    const draftId = 'draft-sale-guard-01';
    const readyDraft = {
      id: draftId,
      status: 'pending',
      fields: {
        customer: 'Khách Test Sale Guard',
        flower: 'Bó hồng đỏ',
        date: '2026-12-01',
        time: '10:00',
        shipping: 'Ghé lấy',
        flowerTotal: 300000,
        sale: 'cmui',
        paymentState: 'unpaid'
      },
      sampleRefs: [{ r2_key: `meehoa-bot/5252724920/sample-${photoFileId}` }],
      createdAt: new Date().toISOString()
    };

    const drafts = { __active: draftId, [draftId]: readyDraft };
    await saveDrafts(db, 5252724920, drafts);

    // Try /confirm with SALE account that cannot assign cmui
    sentMessages.length = 0;
    opsRequests.length = 0;
    await sendMsg(22001, { text: '/confirm' });

    // 1. Bot must BLOCK before createOrder
    const createOrderCalls = opsRequests.filter(r => r.body?.name === 'createOrder');
    assert.equal(createOrderCalls.length, 0, 'createOrder must NOT be called when caller cannot assign cmui');

    // 2. Bot must warn user clearly
    const blockReply = sentMessages[sentMessages.length - 1].text;
    assert.ok(blockReply.includes('không có quyền') || blockReply.includes('không có quyền gán'), 'Must explain permission denial');
    assert.ok(blockReply.includes('cmui') || blockReply.includes('C Mụi'), 'Must mention cmui or C Mụi');

    // 3. Draft must be preserved (not deleted, not submitted)
    const afterDrafts = await loadDrafts(db, 5252724920);
    assert.ok(afterDrafts[draftId], 'Draft must still exist');
    assert.equal(afterDrafts[draftId].status, 'pending', 'Draft status must remain pending');
    assert.equal(afterDrafts[draftId].fields.customer, 'Khách Test Sale Guard', 'Draft fields preserved');

    // 4. Now test with ADMIN caller → should proceed normally
    callerResponse = {
      ...callerResponse,
      caller: { username: 'admin', role: 'ADMIN', canAssignDefaultSale: true }
    };
    sentMessages.length = 0;
    opsRequests.length = 0;
    await sendMsg(22002, { text: '/confirm' });

    const createCallsAdmin = opsRequests.filter(r => r.body?.name === 'createOrder');
    assert.equal(createCallsAdmin.length, 1, 'ADMIN caller should reach createOrder');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ─── Contract 23: Fake-conversation benchmark (Telegram → worker → real OPS core, fake Gemini) ───

test('Contract 23: conversation benchmark — keep "Như" on ship add-on, clean "Bó tulip trắng", explicit edit, split 2 orders, ask back, 350k/200k paid/debt from OPS, AI failure/quota fallback', async () => {
  const path = require('node:path');
  const { runConversationBenchmark } = await import('./helpers/conversation-benchmark.mjs');
  const root = path.resolve(__dirname, '..');
  const opsDir = process.env.OPS_RUNTIME_DIR ? path.resolve(process.env.OPS_RUNTIME_DIR) : path.join(root, 'cloudflare-migration');
  const results = await runConversationBenchmark(root, opsDir);
  const failed = results.filter(r => !r.pass);
  assert.equal(failed.length, 0, `Failed benchmark cases: ${JSON.stringify(failed, null, 2)}`);
  assert.equal(results.length, 7);
});

// ─── Contract 24: Repro 17:45 Hydrogen caption ("Khách Thảo My ... 650 ngàn ... 88 Võ Văn Tần quận 3") ───

test('Contract 24: Gemini 4 Hydrogen omits deprecated temperature, uses responseSchema + maxOutputTokens + SSE streaming, skips thought parts, routes AQ. keys to aiplatform as primary, falls back standard keys to aiplatform on 503, and logs full telemetry', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { buildGeminiRequestBody, extractFieldsWithGeminiDetailed } = await import('../order-bot/cloudflare/gemini.mjs');

  // 1. Verify Gemini 4 uses thinkingLevel="LOW", omits deprecated temperature, enforces responseSchema + maxOutputTokens=2048
  const hBody = buildGeminiRequestBody('test text', 'gemini-4-hydrogen');
  assert.equal(hBody.generationConfig.temperature, undefined);
  assert.equal(hBody.generationConfig.thinkingConfig?.thinkingLevel, 'LOW');
  assert.equal(hBody.generationConfig.thinkingConfig?.thinkingBudget, undefined);
  assert.equal(hBody.generationConfig.maxOutputTokens, 2048);
  assert.equal(hBody.generationConfig.responseSchema?.type, 'OBJECT');
  assert.ok(hBody.generationConfig.responseSchema?.properties?.customer);
  assert.ok(hBody.generationConfig.responseSchema?.properties?.flower);
  assert.ok(hBody.generationConfig.responseSchema?.properties?.flowerTotal);
  assert.ok(hBody.generationConfig.responseSchema?.properties?.shipping);
  assert.ok(hBody.generationConfig.responseSchema?.properties?.address);
  assert.equal(Object.keys(hBody.generationConfig.responseSchema.properties).length, 11);

  const fBody = buildGeminiRequestBody('test text', 'gemini-2.5-flash');
  assert.equal(fBody.generationConfig.temperature, 0.1);
  assert.equal(fBody.generationConfig.thinkingConfig, undefined);
  assert.equal(fBody.generationConfig.maxOutputTokens, 2048);

  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  const geminiRequests = [];

  const fullJson = JSON.stringify({
    customer: 'Thảo My',
    phone: null,
    flower: 'Kệ chúc mừng tông vàng',
    date: '29/12',
    time: '16:00',
    shipping: 'Shop book ship',
    address: '88 Võ Văn Tần, Quận 3',
    flowerTotal: 650000,
    note: null,
    cardText: null,
    bannerText: null
  });
  const half = Math.floor(fullJson.length / 2);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      const reqBody = JSON.parse(opts.body);
      geminiRequests.push({ url: u, body: reqBody });
      const ssePayload = [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'analyzing Vietnamese order...' }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson.slice(0, half) }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson.slice(half) }] }, finishReason: 'STOP' }] })}\n\n`
      ];
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          for (const chunk of ssePayload) controller.enqueue(enc.encode(chunk));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/tm.jpg', file_size: 1024 } }));
    if (u.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]));
    if (u.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const env = {
      DB: db,
      MEDIA_R2: r2,
      BOT_TOKEN: 'fake_bot_token',
      OPS_TOKEN: '',
      TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
      ALLOWED_USER_IDS: '5252724920',
      GEMINI_API_KEY: 'fake-hydrogen-key',
      GEMINI_MODEL: 'gemini-4-hydrogen'
    };

    const caption = 'Khách Thảo My đặt một kệ chúc mừng tông vàng 650 ngàn, chiều 29/12 lúc 16h shop giao qua 88 Võ Văn Tần quận 3';
    await handleTelegramWebhook(
      makeWebhookRequest({
        update_id: 24001,
        message: {
          message_id: 24001,
          date: 1795600000,
          chat: { id: 5252724920, type: 'private' },
          from: { id: 5252724920 },
          photo: [{ file_id: 'p_tm', file_unique_id: 'u_tm' }],
          caption
        }
      }),
      env
    );

    // 2. Hydrogen SSE endpoint called with thinkingLevel="LOW", no temperature, responseSchema & maxOutputTokens
    assert.equal(geminiRequests.length, 1);
    assert.ok(geminiRequests[0].url.includes('/models/gemini-4-hydrogen:streamGenerateContent?alt=sse'));
    assert.equal(geminiRequests[0].body.generationConfig.temperature, undefined);
    assert.equal(geminiRequests[0].body.generationConfig.thinkingConfig?.thinkingLevel, 'LOW');
    assert.equal(geminiRequests[0].body.generationConfig.maxOutputTokens, 2048);

    // 3. All 5 AI fields + date/time + Sale cmui present in pending draft (no OPS order created)
    const drafts = await loadDrafts(db, 5252724920);
    const active = drafts[drafts.__active];
    assert.equal(active.status, 'pending');
    assert.equal(active.fields.customer, 'Thảo My');
    assert.equal(active.fields.flower, 'Kệ chúc mừng tông vàng');
    assert.equal(active.fields.flowerTotal, '650000');
    assert.equal(active.fields.shipping, 'Shop book ship');
    assert.equal(active.fields.address, '88 Võ Văn Tần, Quận 3');
    assert.equal(active.fields.date, '2026-12-29');
    assert.equal(active.fields.time, '16:00');
    assert.equal(active.fields.sale, 'cmui');
    assert.equal((active.sampleRefs || []).length, 1);

    // 4. Telegram summary shows all 5 fields + C Mụi
    const reply = sentMessages[sentMessages.length - 1]?.text || '';
    for (const expected of ['Thảo My', 'Kệ chúc mừng tông vàng', '650.000', 'Shop book ship', '88 Võ Văn Tần, Quận 3', '2026-12-29', '16:00', 'C Mụi']) {
      assert.ok(reply.includes(expected), `Summary missing "${expected}": ${reply}`);
    }

    // 5. bot_audit_logs records geminiExtract telemetry with endpoint, headersMs, thoughtParts, textParts, finishReason
    const auditRow = await db.prepare("SELECT payload_json FROM bot_audit_logs WHERE action = 'geminiExtract' ORDER BY id DESC LIMIT 1").first();
    assert.ok(auditRow?.payload_json);
    const audit = JSON.parse(auditRow.payload_json);
    assert.equal(audit.model, 'gemini-4-hydrogen');
    assert.equal(audit.endpoint, 'generativelanguage');
    assert.equal(audit.ok, true);
    assert.equal(audit.status, 200);
    assert.ok(typeof audit.headersMs === 'number' && audit.headersMs >= 0);
    assert.equal(audit.thoughtParts, 1);
    assert.equal(audit.textParts, 2);
    assert.equal(audit.finishReason, 'STOP');
    assert.ok(audit.extractedKeys.includes('customer'));
    assert.ok(audit.extractedKeys.includes('flowerTotal'));

    // 6a. AQ. key → aiplatform.googleapis.com as PRIMARY (Vertex Express key routing)
    //     AQ. keys belong to Vertex Express: use aiplatform directly, NOT generativelanguage first.
    const aqUrls = [];
    const aqFetcher = async url => {
      const u = String(url);
      aqUrls.push(u);
      if (u.includes('aiplatform.googleapis.com')) {
        return new Response(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson }] }, finishReason: 'STOP' }] })}\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };
    const aqRes = await extractFieldsWithGeminiDetailed('AQ.testExpressKey', caption, 'gemini-4-hydrogen', aqFetcher);
    // Must call aiplatform FIRST (not generativelanguage) for AQ. keys
    assert.equal(aqUrls.length, 1, 'AQ. key must call aiplatform directly without trying generativelanguage first');
    assert.ok(aqUrls[0].includes('aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-hydrogen:streamGenerateContent?alt=sse'));
    assert.equal(aqRes.ok, true);
    assert.equal(aqRes.endpoint, 'aiplatform');
    assert.equal(aqRes.status, 200);
    assert.equal(aqRes.fields.customer, 'Thảo My');
    assert.equal(aqRes.fields.flowerTotal, 650000);

    // 6b. Standard key → generativelanguage primary, fallback to aiplatform on HTTP 503 (server overload)
    //     Root cause of lượt 18:18 (#b0dca9): generativelanguage returned 503 but old code only fell back on 400/401/403.
    const fbUrls503 = [];
    const fetcher503 = async url => {
      const u = String(url);
      fbUrls503.push(u);
      if (u.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand' } }),
          { status: 503 }
        );
      }
      if (u.includes('aiplatform.googleapis.com')) {
        return new Response(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson }] }, finishReason: 'STOP' }] })}\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };
    const fbRes503 = await extractFieldsWithGeminiDetailed('standard-key', caption, 'gemini-4-hydrogen', fetcher503);
    assert.equal(fbUrls503.length, 2, 'Standard key must fallback to aiplatform on 503');
    assert.ok(fbUrls503[0].includes('generativelanguage.googleapis.com'));
    assert.ok(fbUrls503[1].includes('aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-hydrogen:streamGenerateContent?alt=sse'));
    assert.equal(fbRes503.ok, true);
    assert.equal(fbRes503.endpoint, 'aiplatform');
    assert.equal(fbRes503.fields.customer, 'Thảo My');
    assert.equal(fbRes503.fields.flowerTotal, 650000);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Contract 25: Gemini retry + backoff on transient errors (503, 429), budget guard, Retry-After, /ai-probe isolation', async () => {
  const { extractFieldsWithGeminiDetailed, retryDelayMs, RETRYABLE_STATUSES, TOTAL_AI_BUDGET_MS } = await import('../order-bot/cloudflare/gemini.mjs');
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');

  const caption = 'Khách Thảo My đặt một kệ chúc mừng tông vàng 650 ngàn, chiều 29/12 lúc 16h shop giao qua 88 Võ Văn Tần quận 3';
  const fullJson = JSON.stringify({ customer: 'Thảo My', flower: 'kệ chúc mừng tông vàng', flowerTotal: 650000, shipping: 'Shop book ship', address: '88 Võ Văn Tần, Quận 3', date: '29/12', time: '16:00', phone: null, note: null, cardText: null, bannerText: null });

  // 1. retryDelayMs: exponential backoff
  assert.equal(retryDelayMs(0, 0), 1000);
  assert.equal(retryDelayMs(1, 0), 2000);
  assert.equal(retryDelayMs(2, 0), 4000);
  assert.equal(retryDelayMs(3, 0), 8000); // capped
  assert.equal(retryDelayMs(10, 0), 8000); // capped
  // Retry-After overrides backoff when larger
  assert.equal(retryDelayMs(0, 5000), 5000);
  // Retry-After smaller than backoff → use backoff
  assert.equal(retryDelayMs(2, 500), 4000);

  // 2. RETRYABLE_STATUSES contains expected codes
  assert.ok(RETRYABLE_STATUSES.has(503));
  assert.ok(RETRYABLE_STATUSES.has(429));
  assert.ok(RETRYABLE_STATUSES.has(500));
  assert.ok(RETRYABLE_STATUSES.has(502));
  assert.ok(RETRYABLE_STATUSES.has(504));
  assert.ok(!RETRYABLE_STATUSES.has(400));
  assert.ok(!RETRYABLE_STATUSES.has(401));
  assert.ok(!RETRYABLE_STATUSES.has(403));

  // 3. TOTAL_AI_BUDGET_MS is 55000
  assert.equal(TOTAL_AI_BUDGET_MS, 55000);

  // 4. AQ. key: 503 on aiplatform → retry → success (confirms retry on same endpoint)
  const aqRetryUrls = [];
  let aqRetryCount = 0;
  const aqRetryFetcher = async url => {
    const u = String(url);
    aqRetryUrls.push(u);
    if (u.includes('aiplatform.googleapis.com')) {
      aqRetryCount++;
      if (aqRetryCount < 2) {
        // First call returns 503; second returns success
        return new Response(
          JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'High demand' } }),
          { status: 503, headers: { 'Retry-After': '0' } }
        );
      }
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson }] }, finishReason: 'STOP' }] })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    return new Response('Not found', { status: 404 });
  };
  const aqRetryRes = await extractFieldsWithGeminiDetailed('AQ.testKey', caption, 'gemini-4-hydrogen', aqRetryFetcher);
  assert.equal(aqRetryRes.ok, true, 'AQ. key: should succeed after 1 retry on 503');
  assert.equal(aqRetryRes.retries, 1, 'Should record 1 retry');
  assert.equal(aqRetryRes.endpoint, 'aiplatform');
  assert.equal(aqRetryRes.fields?.customer, 'Thảo My');
  assert.equal(aqRetryRes.fields?.flowerTotal, 650000);

  // 5. Standard key: 503 twice → still retries → success
  let stdRetryCount = 0;
  const stdRetryFetcher = async url => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      stdRetryCount++;
      if (stdRetryCount < 3) {
        return new Response(
          JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'High demand' } }),
          { status: 503 }
        );
      }
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson }] }, finishReason: 'STOP' }] })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    // aiplatform only reached if retries exhausted
    return new Response(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson }] }, finishReason: 'STOP' }] })}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
  };
  const stdRetryRes = await extractFieldsWithGeminiDetailed('standard-key', caption, 'gemini-4-hydrogen', stdRetryFetcher);
  assert.equal(stdRetryRes.ok, true, 'Standard key: should succeed after 2 retries on 503');
  assert.equal(stdRetryRes.fields?.customer, 'Thảo My');

  // 6. Standard key: 429 → retry → 429 → retry → success (respects max 2 retries)
  let r429Count = 0;
  const fetcher429 = async url => {
    r429Count++;
    if (r429Count <= 2) {
      return new Response(
        JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
        { status: 429, headers: { 'Retry-After': '0' } }
      );
    }
    return new Response(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson }] }, finishReason: 'STOP' }] })}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
  };
  const res429 = await extractFieldsWithGeminiDetailed('standard-key', caption, 'gemini-4-hydrogen', fetcher429);
  assert.equal(res429.ok, true, '429 retry: should succeed after retries');

  // 7. 429 always (3 times exhausted) → ok:false, draft preserved
  let r429Always = 0;
  const fetcher429Always = async _url => {
    r429Always++;
    return new Response(
      JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
      { status: 429, headers: { 'Retry-After': '0' } }
    );
  };
  const res429Always = await extractFieldsWithGeminiDetailed('standard-key', caption, 'gemini-4-hydrogen', fetcher429Always);
  assert.equal(res429Always.ok, false, '429 exhausted: must return ok:false');
  assert.equal(res429Always.fields, null, '429 exhausted: fields must be null (draft preserved)');
  assert.equal(res429Always.status, 429);

  // 8. Timeout (AbortError) → ok:false, draft preserved
  const timeoutFetcher = async (_url, _opts) => {
    await new Promise(r => setTimeout(r, 60));
    throw new Error('The operation was aborted. AbortError');
  };
  const resTimeout = await extractFieldsWithGeminiDetailed('standard-key', caption, 'gemini-4-hydrogen', timeoutFetcher, 50);
  assert.equal(resTimeout.ok, false, 'timeout: must return ok:false');
  assert.equal(resTimeout.fields, null);

  // 9. Malformed JSON response → ok:false, draft preserved
  const malformedFetcher = async _url => {
    return new Response('not-json-at-all{{{', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const resMalformed = await extractFieldsWithGeminiDetailed('AQ.testKey', 'Caption bình thường', 'gemini-4-hydrogen', malformedFetcher);
  assert.equal(resMalformed.ok, false, 'malformed: must return ok:false (empty SSE → EMPTY_RESPONSE)');
  assert.equal(resMalformed.fields, null);

  // 10. /ai-probe route: 403 when OPS_TOKEN missing or wrong
  const probeNoToken = await (async () => {
    const req = new Request('https://bot.example.com/ai-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption })
    });
    // Import default export (the Worker object)
    const workerMod = await import('../order-bot/cloudflare/worker.mjs');
    const worker = workerMod.default;
    return worker.fetch(req, { GEMINI_API_KEY: 'AQ.testKey', OPS_TOKEN: 'correct-token', GEMINI_MODEL: 'gemini-4-hydrogen' });
  })();
  assert.equal(probeNoToken.status, 403, '/ai-probe: missing token → 403');

  // 11. /ai-probe route: 400 when caption missing
  const probeNoCaption = await (async () => {
    const req = new Request('https://bot.example.com/ai-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ops-token': 'correct-token' },
      body: JSON.stringify({ caption: '' })
    });
    const workerMod = await import('../order-bot/cloudflare/worker.mjs');
    return workerMod.default.fetch(req, { GEMINI_API_KEY: 'AQ.testKey', OPS_TOKEN: 'correct-token', GEMINI_MODEL: 'gemini-4-hydrogen' });
  })();
  assert.equal(probeNoCaption.status, 400, '/ai-probe: empty caption → 400');

  // 12. /ai-probe route: returns ok result with correct isolationNote (no OPS write)
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      if (String(url).includes('aiplatform.googleapis.com')) {
        return new Response(
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJson }] }, finishReason: 'STOP' }] })}\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    };
    const probeGoodReq = new Request('https://bot.example.com/ai-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ops-token': 'correct-token' },
      body: JSON.stringify({ caption })
    });
    const workerMod = await import('../order-bot/cloudflare/worker.mjs');
    const probeGoodRes = await workerMod.default.fetch(probeGoodReq, {
      GEMINI_API_KEY: 'AQ.testKey',
      OPS_TOKEN: 'correct-token',
      GEMINI_MODEL: 'gemini-4-hydrogen'
    });
    const probeJson = await probeGoodRes.json();
    assert.equal(probeGoodRes.status, 200, '/ai-probe success → HTTP 200');
    assert.equal(probeJson.ok, true, '/ai-probe: ok must be true on success');
    assert.equal(probeJson.source, 'worker-real-secret');
    assert.ok(probeJson.isolationNote.includes('NO_OPS_WRITE'), '/ai-probe: isolationNote must state no OPS write');
    assert.ok(probeJson.extractedKeys.includes('customer'), '/ai-probe: must extract customer');
    assert.ok(probeJson.extractedKeys.includes('flowerTotal'), '/ai-probe: must extract flowerTotal');
    assert.equal(probeJson.extractedFields?.customer, 'Thảo My');
    assert.equal(probeJson.extractedFields?.flowerTotal, 650000);
  } finally {
    globalThis.fetch = origFetch;
  }
});
