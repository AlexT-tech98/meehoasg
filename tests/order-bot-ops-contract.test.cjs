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

test('Contract 1: Cloudflare Bot payload is accepted by canonical OPS normalization across all 4 payment claims without reducing debt', async () => {
  const { callCreateOrder } = await import('../order-bot/cloudflare/ops-client.mjs');
  const { normalizeOperationOrder } = await import('../supabase/functions/_shared/operations.js');

  const states = [
    { paymentState: 'unpaid' },
    { paymentState: 'deposit', depositAmount: 250000 },
    { paymentState: 'bankfull', reportedPaidAmount: 650000 },
    { paymentState: 'fullpaid' }
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
    assert.equal(normalized.payment, 'Chưa thanh toán', `OPS payment must stay unpaid for ${st.paymentState}`);
    assert.equal(payload.payload.order.fullPaidRequested, false);
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
        text: 'Tên: Anh A & B <VIP>\nHoa: Bó <3 & Hồng\nNgày: 2026-12-12\nGiờ: 10:00\nShip: Ghé lấy'
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
      opsCalls.push(payload);
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

  // 3. Reply summary shows 350k, deposit 200k, remaining 150k, unpaid OPS invariant, and missing fields
  const photoReply = sentMessages[sentMessages.length - 1].text;
  assert.ok(photoReply.includes('d4a39f'), 'Must mention old draft was preserved');
  assert.ok(photoReply.includes('350.000 đ'));
  assert.ok(photoReply.includes('Đã cọc 200.000 đ'));
  assert.ok(photoReply.includes('còn lại: 150.000 đ'));
  assert.ok(photoReply.includes('OPS tạo Chưa thanh toán'));
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
  assert.equal(sentOrder.payment, 'Chưa thanh toán', 'OPS payment must stay unpaid');
  assert.equal(sentOrder.fullPaidRequested, false);
  assert.ok(sentOrder.note.includes('[Khách báo: Đã cọc 200.000 đ]'));
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
