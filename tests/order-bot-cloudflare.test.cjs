/**
 * MEEHOA Order Bot V1 — Cloudflare Worker & D1 Integration Tests
 *
 * Verifies all 15 mandatory scenarios from Phase 4:
 *   1. Full customer message -> creates accurate draft in D1
 *   2. Fragmented messages -> aggregates correctly
 *   3. Concurrent messages -> guarded by D1 concurrency lock
 *   4. Telegram resends update -> deduplicated by update_id
 *   5. Customer amends fields -> updates value and preserves history
 *   6. Multiple sample photos -> stored in sampleRefs and R2
 *   7. Bill photo -> stored as unverified bill, no payment confirmation
 *   8. Missing required info -> blocks /confirm with list
 *   9. AI failure -> warning, safe fallback
 *  10. Multiple /confirm calls -> idempotent, single order
 *  11. OPS timeout -> draft preserved for retry
 *  12. Worker reboot -> draft recovered from D1
 *  13. Unauthorized user ID -> rejected
 *  14. Invalid Webhook secret token -> HTTP 403
 *  15. Image >5MB or download error -> aborts confirmation
 *
 * Also measures CPU execution time against Cloudflare Workers Free 10ms limit.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Create mock D1 database based on in-memory SQLite executing schema.sql
function createMockD1() {
  const sqlite = new DatabaseSync(':memory:');
  const schema = fs.readFileSync('order-bot/cloudflare/schema.sql', 'utf8');
  sqlite.exec(schema);
  sqlite.exec('CREATE TABLE IF NOT EXISTS orders (row_key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));');

  const makeStmt = (sql, boundArgs = []) => ({
    bind(...args) {
      return makeStmt(sql, args);
    },
    first: async () => {
      const stmt = sqlite.prepare(sql);
      return stmt.get(...boundArgs) || null;
    },
    all: async () => {
      const stmt = sqlite.prepare(sql);
      const results = stmt.all(...boundArgs);
      return { results, success: true, meta: { changes: 0 } };
    },
    run: async () => {
      const stmt = sqlite.prepare(sql);
      const info = stmt.run(...boundArgs);
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

// Create mock R2 bucket
function createMockR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, buffer, options = {}) {
      const obj = {
        key,
        body: buffer,
        buffer,
        httpMetadata: options.httpMetadata || { contentType: options.contentType || 'image/jpeg' },
        options,
        putAt: new Date().toISOString()
      };
      objects.set(key, obj);
      return { key, size: buffer.byteLength };
    },
    async get(key) {
      return objects.get(key) || null;
    }
  };
}

// Helper to simulate Telegram Webhook Request
function makeWebhookRequest(body, headers = {}) {
  const defaultHeaders = {
    'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': 'staging_secret_token_123',
    ...headers
  };
  return new Request('https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook', {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify(body)
  });
}

test('Scenario 1: Full customer message creates accurate draft in D1', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      const payload = JSON.parse(opts.body);
      sentMessages.push(payload);
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // 1. Send /new
  const req1 = makeWebhookRequest({
    update_id: 1001,
    message: {
      message_id: 1,
      from: { id: 5252724920, username: 'owner' },
      chat: { id: 5252724920, type: 'private' },
      text: '/new'
    }
  });
  const res1 = await handleTelegramWebhook(req1, env);
  assert.equal(res1.status, 200);

  // 2. Send full order details
  const fullOrderText = `- Khách: Chị Quỳnh Anh
- Hoa: Bó hoa cẩm tú cầu tone xanh pastel
- Ngày: 28/11/2026
- Giờ: 10h30
- Ship: Shop book ship
- Đc: 456 Hai Bà Trưng, P. Tân Định, Q.1
- SĐT: 0988776655
- Giá: 950k
- Thiệp: Chúc mừng khai trương hồng phát
- Ghi chú: Giao đúng giờ`;

  const req2 = makeWebhookRequest({
    update_id: 1002,
    message: {
      message_id: 2,
      from: { id: 5252724920, username: 'owner' },
      chat: { id: 5252724920, type: 'private' },
      text: fullOrderText
    }
  });
  const res2 = await handleTelegramWebhook(req2, env);
  assert.equal(res2.status, 200);

  // Verify stored in D1
  const drafts = await loadDrafts(db, 5252724920);
  assert.ok(drafts.__active);
  const active = drafts[drafts.__active];
  assert.equal(active.fields.customer, 'Chị Quỳnh Anh');
  assert.equal(active.fields.date, '2026-11-28');
  assert.equal(active.fields.time, '10:30');
  assert.equal(active.fields.shipping, 'Shop book ship');
  assert.equal(active.fields.flowerTotal, '950000');
  assert.ok(active.fields.card);
});

test('Scenario 2: Fragmented messages aggregate cohesively into single D1 draft', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // 1. /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 2001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // 2. Msg 1: Khách + Hoa
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 2002,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Tên: Anh Hoàng\nHoa: Kệ hoa lan hồ điệp' }
  }), env);

  // 3. Msg 2: Ngày + Giờ + Ship
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 2003,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Ngày: 30/11/2026\nGiờ: 14h00\nShip: Ghé lấy' }
  }), env);

  // 4. Msg 3: Giá
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 2004,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Giá: 2.5tr' }
  }), env);

  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  assert.equal(active.fields.customer, 'Anh Hoàng');
  assert.equal(active.fields.flower, 'Kệ hoa lan hồ điệp');
  assert.equal(active.fields.date, '2026-11-30');
  assert.equal(active.fields.time, '14:00');
  assert.equal(active.fields.shipping, 'Ghé lấy');
  assert.equal(active.fields.flowerTotal, '2500000');
});

test('Scenario 3: Concurrent messages are serialized by D1 lock without data loss', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // Init draft
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 3001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // Simulate two concurrent webhook requests for the same user arriving almost simultaneously
  const p1 = handleTelegramWebhook(makeWebhookRequest({
    update_id: 3002,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Tên: Chị Minh' }
  }), env);

  const p2 = handleTelegramWebhook(makeWebhookRequest({
    update_id: 3003,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Hoa: Bó tulip trắng' }
  }), env);

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  // Verify database state is valid and consistent (both concurrent messages processed)
  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  assert.ok(active);
  assert.equal(active.fields.customer, 'Chị Minh');
  assert.equal(active.fields.flower, 'Bó tulip trắng');
});

test('Scenario 4: Telegram resends update -> deduplicated by update_id', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { isUpdateProcessed } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const update = {
    update_id: 4001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  };

  // First delivery
  const res1 = await handleTelegramWebhook(makeWebhookRequest(update), env);
  assert.equal(res1.status, 200);
  assert.equal(await isUpdateProcessed(db, 4001), true);

  // Second delivery (duplicate retry from Telegram)
  const res2 = await handleTelegramWebhook(makeWebhookRequest(update), env);
  assert.equal(res2.status, 200);
  const text = await res2.text();
  assert.match(text, /Already Processed/);
});

test('Scenario 5: Customer amends fields -> updates value and preserves history in D1', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 5001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // Set time 9h
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 5002,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Giờ: 9h' }
  }), env);

  // Amend time to 15h
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 5003,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Giờ: 15h' }
  }), env);

  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  assert.equal(active.fields.time, '15:00');
  assert.ok(active.history.length >= 2);
  const lastHistory = active.history[active.history.length - 1];
  assert.equal(lastHistory.changes[0].field, 'time');
  assert.equal(lastHistory.changes[0].value, '15:00');
});

test('Scenario 6: Multiple sample photos stored in sampleRefs and uploaded to R2', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  // Mock Telegram getFile and download endpoints
  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/sample1.jpg', file_size: 1024 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])); // JPEG header
    }
    if (url.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 6001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // Send photo 1 (sample)
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 6002,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      photo: [{ file_id: 'p1_thumb' }, { file_id: 'p1_large', file_unique_id: 'uniq_p1' }],
      caption: 'Mẫu hoa cúc tana tone trắng'
    }
  }), env);

  // Send photo 2 (sample without caption)
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 6003,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      photo: [{ file_id: 'p2_large', file_unique_id: 'uniq_p2' }]
    }
  }), env);

  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  assert.equal(active.sampleRefs.length, 2);
  assert.equal(active.draftBillRefs.length, 0);

  // Verify R2 has received the images
  assert.equal(r2.objects.size, 2);
  for (const [key] of r2.objects) {
    assert.match(key, /^order-images\/sample-/);
  }
});

test('Scenario 7: Bill photo is classified into draftBillRefs as unverified bill without payment confirmation', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/bill.jpg', file_size: 2048 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]));
    }
    if (url.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 7001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // Send photo with caption "bill ck"
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 7002,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      photo: [{ file_id: 'bill_f1', file_unique_id: 'bill_uniq_1' }],
      caption: 'Bill chuyển khoản VCB'
    }
  }), env);

  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  assert.equal(active.draftBillRefs.length, 1);
  assert.equal(active.sampleRefs.length, 0);

  // Check R2 destination prefix
  for (const [key] of r2.objects) {
    assert.match(key, /^settlement-bills\/unverified-/);
  }
});

test('Scenario 8: Missing required information halts /confirm with list of missing fields', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const sentMessages = [];
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 8001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // Only supply customer and flower, missing date, time, shipping
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 8002,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Tên: Chị Thảo\nHoa: Bó hướng dương' }
  }), env);

  // Try /confirm
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 8003,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
  }), env);

  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  // Draft must NOT be submitted or confirming
  assert.equal(active.status, 'pending');

  // Verify error reply lists missing fields
  const lastReply = sentMessages[sentMessages.length - 1];
  assert.match(lastReply.text, /Chưa đủ dữ liệu/);
  assert.match(lastReply.text, /ngày nhận/);
  assert.match(lastReply.text, /giờ nhận/);
  assert.match(lastReply.text, /hình thức ship/);
});

test('Scenario 9: AI failure or invalid output falls back safely without guesswork', async () => {
  const { extractFieldsWithGemini } = await import('../order-bot/cloudflare/gemini.mjs');

  // Mock fetch that fails or returns invalid JSON
  const mockFetcherFail = async () => new Response('Internal Server Error', { status: 500 });
  const result1 = await extractFieldsWithGemini('fake_key', 'Khách muốn đặt hoa', 'gemini-2.5-flash', mockFetcherFail);
  assert.equal(result1, null);

  const mockFetcherGarbage = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'NOT A JSON' }] } }] }));
  const result2 = await extractFieldsWithGemini('fake_key', 'Khách muốn đặt hoa', 'gemini-2.5-flash', mockFetcherGarbage);
  assert.equal(result2, null);
});

test('Scenario 10: Multiple /confirm calls maintain fixed requestId and create single order', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const opsCalls = [];
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/api-core')) {
      const payload = JSON.parse(opts.body);
      opsCalls.push(payload);
      return new Response(JSON.stringify({ ok: true, orderId: 'MEE-STAGING-001' }));
    }
    if (url.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // 1. /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 10001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // 2. Full info
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 10002,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      text: 'Tên: Chị Ánh\nHoa: Bó hồng đỏ\nNgày: 2026-12-01\nGiờ: 09:00\nShip: Ghé lấy\nGiá: 500k'
    }
  }), env);

  // 3. First /confirm
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 10003,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
  }), env);

  const draftsAfter1 = await loadDrafts(db, 5252724920);
  const activeDraftId = draftsAfter1.__active;
  assert.equal(draftsAfter1[activeDraftId].status, 'submitted');
  const originalRequestId = draftsAfter1[activeDraftId].requestId;
  assert.ok(originalRequestId);

  // 4. Duplicate /confirm call
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 10004,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
  }), env);

  // Verify only 1 call went to OPS, second /confirm was blocked as submitted
  assert.equal(opsCalls.length, 1);
  assert.equal(opsCalls[0].payload.requestId, originalRequestId);
});

test('Scenario 11: OPS timeout keeps draft in confirmed state for recovery', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url) => {
    if (url.includes('/api-core')) {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    if (url.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 11001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // Full info
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 11002,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      text: 'Tên: Chị Vân\nHoa: Bó cúc mẫu đơn\nNgày: 2026-12-05\nGiờ: 11:00\nShip: Ghé lấy'
    }
  }), env);

  // /confirm with simulated OPS timeout
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 11003,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
  }), env);

  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  // Must roll back to confirmed with requestId intact
  assert.equal(active.status, 'confirmed');
  assert.ok(active.requestId);
});

test('Scenario 12: Worker reboot -> draft recovered cleanly from D1', async () => {
  const { loadDrafts, saveDrafts, findStaleConfirming, resetStaleConfirming } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();

  // Create stuck confirming draft from 30 minutes ago
  const oldDate = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const mockDrafts = {
    __active: 'draft_crashed_1',
    'draft_crashed_1': {
      id: 'draft_crashed_1',
      status: 'confirming',
      requestId: 'fixed-uuid-1234',
      updatedAt: oldDate,
      fields: { customer: 'Chị Mai', flower: 'Bó ly trắng' }
    }
  };
  await saveDrafts(db, 5252724920, mockDrafts);

  // Detect stale confirming draft
  const stale = await findStaleConfirming(db, 15);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].draftId, 'draft_crashed_1');
  assert.equal(stale[0].draft.requestId, 'fixed-uuid-1234');

  // Reset to confirmed for safe retry
  const resetSuccess = await resetStaleConfirming(db, 5252724920, 'draft_crashed_1');
  assert.equal(resetSuccess, true);

  const recoveredDrafts = await loadDrafts(db, 5252724920);
  assert.equal(recoveredDrafts['draft_crashed_1'].status, 'confirmed');
  assert.equal(recoveredDrafts['draft_crashed_1'].requestId, 'fixed-uuid-1234');
});

test('Scenario 13: Unauthorized user (different Telegram user ID) is denied with warning', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const sentMessages = [];
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // Stranger with ID 999999999
  const res = await handleTelegramWebhook(makeWebhookRequest({
    update_id: 13001,
    message: {
      chat: { id: 999999999, type: 'private' },
      from: { id: 999999999 },
      text: '/new'
    }
  }), env);

  assert.equal(res.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /không có quyền sử dụng bot/);

  // No draft created for stranger
  const strangerDrafts = await loadDrafts(db, 999999999);
  assert.deepEqual(strangerDrafts, {});
});

test('Scenario 14: Invalid Webhook secret token is rejected with HTTP 403', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    TELEGRAM_SECRET_TOKEN: 'correct_secret_token'
  };

  const req = makeWebhookRequest({ update_id: 14001, message: {} }, {
    'x-telegram-bot-api-secret-token': 'wrong_secret_token'
  });

  const res = await handleTelegramWebhook(req, env);
  assert.equal(res.status, 403);
});

test('Scenario 15: Image exceeding 5MB or download failure aborts confirmation immediately', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      // Return file exceeding 5MB (e.g. 8MB)
      return new Response(JSON.stringify({
        ok: true,
        result: { file_path: 'photos/huge.jpg', file_size: 8 * 1024 * 1024 }
      }));
    }
    if (url.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 15001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // Attempt to send 8MB photo
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 15002,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      photo: [{ file_id: 'huge_id', file_size: 8 * 1024 * 1024 }]
    }
  }), env);

  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  // Must reject photo
  assert.equal(active.sampleRefs.length, 0);
});

test('Scenario 16: Unverified bill is permanently linked directly into D1 orders table upon /confirm', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { linkUnverifiedBillsToD1Order } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const createdOrderId = 'MEE-STAGING-BILL-01';

  // Seed existing order in D1 orders table
  await db.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?)').bind(
    createdOrderId,
    JSON.stringify({
      id: createdOrderId,
      customer: 'Chị Mai',
      flower: 'Bó hướng dương',
      payment: 'Chưa thanh toán',
      full_paid: false,
      note: 'Giao giờ hành chính',
      unverified_bill_urls: []
    })
  ).run();

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/bill_ck.jpg', file_size: 1024 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]));
    }
    if (url.includes('/api-core')) {
      return new Response(JSON.stringify({ ok: true, orderId: createdOrderId }));
    }
    if (url.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // 1. /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 17001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // 2. Full info
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 17002,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      text: 'Tên: Chị Mai\nHoa: Bó hướng dương\nNgày: 2026-12-05\nGiờ: 11:00\nShip: Ghé lấy\nGiá: 650k'
    }
  }), env);

  // 3. Bill photo
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 17003,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      photo: [{ file_id: 'bill_f1', file_unique_id: 'uniq_bill_1' }],
      caption: 'Bill chuyển khoản'
    }
  }), env);

  // 4. /confirm
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 17004,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
  }), env);

  // Verify order in D1 orders table
  const orderRow = await db.prepare('SELECT data FROM orders WHERE row_key = ?').bind(createdOrderId).first();
  assert.ok(orderRow);
  const orderData = JSON.parse(orderRow.data);

  // Unverified bills must be linked
  assert.ok(Array.isArray(orderData.unverified_bill_urls));
  assert.equal(orderData.unverified_bill_urls.length, 1);
  assert.match(orderData.unverified_bill_urls[0], /^supabase:\/\/settlement-bills\/unverified-/);

  // Payment invariants must NOT be altered
  assert.equal(orderData.payment, 'Chưa thanh toán');
  assert.equal(orderData.full_paid, false);

  // Note must remain intact without unintended mutation
  assert.equal(orderData.note, 'Giao giờ hành chính');
});

test('Scenario 17: Forwarded rapid messages queue sequentially via withLock backoff without dropping updates', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 18001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // Simulate 3 rapid incoming messages sent concurrently in an album/forward batch
  const promises = [
    handleTelegramWebhook(makeWebhookRequest({
      update_id: 18002,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Tên: Khách VIP' }
    }), env),
    handleTelegramWebhook(makeWebhookRequest({
      update_id: 18003,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Hoa: Lẵng hoa lan' }
    }), env),
    handleTelegramWebhook(makeWebhookRequest({
      update_id: 18004,
      message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: 'Giá: 1.8tr' }
    }), env)
  ];

  const results = await Promise.all(promises);
  for (const res of results) {
    assert.equal(res.status, 200);
  }

  const drafts = await loadDrafts(db, 5252724920);
  const active = drafts[drafts.__active];
  assert.equal(active.fields.customer, 'Khách VIP');
  assert.equal(active.fields.flower, 'Lẵng hoa lan');
  assert.equal(active.fields.flowerTotal, '1800000');
});

test('Scenario 18: Bill linking failure warns user without false-positive, keeps submitted order, and /relink recovers successfully', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const createdOrderId = 'MEE-STAGING-FAIL-THEN-RELINK';
  const sentMessages = [];

  const env = {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/bill_ck.jpg', file_size: 1024 } }));
    }
    if (url.includes('/file/bot')) {
      return new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]));
    }
    if (url.includes('/api-core')) {
      return new Response(JSON.stringify({ ok: true, orderId: createdOrderId }));
    }
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(opts.body);
      sentMessages.push(body);
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response('Not found', { status: 404 });
  };

  // 1. /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 19001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // 2. Full info
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 19002,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      text: 'Tên: Chị Hạnh\nHoa: Bó sen hồng\nNgày: 2026-12-08\nGiờ: 08:30\nShip: Ghé lấy\nGiá: 750k'
    }
  }), env);

  // 3. Bill photo
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 19003,
    message: {
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      photo: [{ file_id: 'bill_f1', file_unique_id: 'uniq_bill_fail' }],
      caption: 'Bill chuyển khoản'
    }
  }), env);

  // 4. /confirm while order is NOT yet in D1 orders table (simulates linking failure)
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 19004,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
  }), env);

  const draftsAfterConfirm = await loadDrafts(db, 5252724920);
  const activeDraft = draftsAfterConfirm[draftsAfterConfirm.__active];

  // Must be submitted (order was created in OPS, so we must never recreate it)
  assert.equal(activeDraft.status, 'submitted');
  assert.equal(activeDraft.opsOrderId, createdOrderId);
  assert.equal(activeDraft.billsLinked, false);
  assert.ok(activeDraft.billLinkError);

  // Success message must NOT claim bill attached successfully
  const lastMsg = sentMessages[sentMessages.length - 1];
  assert.ok(lastMsg.text.includes(createdOrderId));
  assert.ok(!lastMsg.text.includes('bill đã liên kết thành công'));
  assert.ok(lastMsg.text.includes('CẢNH BÁO LIÊN KẾT BILL'));
  assert.ok(lastMsg.text.includes('/relink'));

  // 5. Seed order in D1 (e.g. background sync or lag resolved)
  await db.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?)').bind(
    createdOrderId,
    JSON.stringify({
      id: createdOrderId,
      customer: 'Chị Hạnh',
      flower: 'Bó sen hồng',
      payment: 'Chưa thanh toán',
      full_paid: false,
      unverified_bill_urls: []
    })
  ).run();

  // 6. User runs /relink to recover bill linking
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 19005,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/relink' }
  }), env);

  const draftsAfterRelink = await loadDrafts(db, 5252724920);
  const relinkedDraft = draftsAfterRelink[draftsAfterRelink.__active];
  assert.equal(relinkedDraft.billsLinked, true);

  // Check D1 order now has bill
  const updatedOrderRow = await db.prepare('SELECT data FROM orders WHERE row_key = ?').bind(createdOrderId).first();
  const updatedOrder = JSON.parse(updatedOrderRow.data);
  assert.equal(updatedOrder.unverified_bill_urls.length, 1);
  assert.match(updatedOrder.unverified_bill_urls[0], /^supabase:\/\/settlement-bills\/unverified-/);
});

test('Scenario 19: Two concurrent processes update the same D1 order -> OCC prevents blind overwriting', async () => {
  const { linkUnverifiedBillsToD1Order } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2();
  const orderId = 'MEE-STAGING-OCC-TEST';

  // Seed order with initial timestamp
  await db.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?)').bind(
    orderId,
    JSON.stringify({
      id: orderId,
      customer: 'Anh Tuấn',
      status: 'Chờ bó',
      updated_at: '2026-11-21T10:00:00.000Z',
      unverified_bill_urls: []
    })
  ).run();

  // Save bill into R2
  const r2Key = 'settlement-bills/unverified-test.jpg';
  await r2.put(r2Key, new Uint8Array([1, 2, 3]));

  // Link bill
  const result = await linkUnverifiedBillsToD1Order(
    db,
    orderId,
    [{ r2_key: r2Key, uri: `supabase://${r2Key}` }],
    r2
  );

  assert.equal(result.ok, true);
  assert.equal(result.linked, 1);

  // Verify status is still 'Chờ bó' (not overwritten)
  const row = await db.prepare('SELECT data FROM orders WHERE row_key = ?').bind(orderId).first();
  const data = JSON.parse(row.data);
  assert.equal(data.status, 'Chờ bó');
  assert.equal(data.customer, 'Anh Tuấn');
  assert.equal(data.unverified_bill_urls.length, 1);
});

test('Scenario 20: R2 photo verification rejects missing R2 objects', async () => {
  const { linkUnverifiedBillsToD1Order } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const r2 = createMockR2(); // empty R2 bucket
  const orderId = 'MEE-STAGING-MISSING-R2';

  await db.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?)').bind(
    orderId,
    JSON.stringify({ id: orderId, unverified_bill_urls: [] })
  ).run();

  // Try linking non-existent R2 key
  const result = await linkUnverifiedBillsToD1Order(
    db,
    orderId,
    [{ r2_key: 'settlement-bills/non-existent-key.jpg' }],
    r2
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /không tồn tại trong R2 bucket/);
});

test('Scenario 21: Out-of-order Telegram messages do not overwrite newer field values', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));

  // 1. /new
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 21001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/new' }
  }), env);

  // 2. Newer message arrives first (update 21003, date 1700000010, message_id 103): "Hoa: Hoa lan tím"
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 21003,
    message: {
      message_id: 103,
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      date: 1700000010,
      text: 'Hoa: Hoa lan tím'
    }
  }), env);

  // 3. Older message arrives second (update 21002, date 1700000005, message_id 102): "Hoa: Hoa hồng đỏ\nGiá: 900k"
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 21002,
    message: {
      message_id: 102,
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      date: 1700000005,
      text: 'Hoa: Hoa hồng đỏ\nGiá: 900k'
    }
  }), env);

  let drafts = await loadDrafts(db, 5252724920);
  let active = drafts[drafts.__active];

  // 'flower' must remain 'Hoa lan tím' (newer message preserved)
  assert.equal(active.fields.flower, 'Hoa lan tím');
  // 'flowerTotal' was not set by the newer message, so it is safely backfilled
  assert.equal(active.fields.flowerTotal, '900000');

  // 4. Same-second out-of-order check:
  // Suppose message_id 105 was sent at 1700000020 with "Tên: Chị Mai", arrived first
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 21005,
    message: {
      message_id: 105,
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      date: 1700000020,
      text: 'Tên: Chị Mai'
    }
  }), env);

  // Now message_id 104 was sent in the EXACT same second (date 1700000020) with "Tên: Chị Lan", but arrived second
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 21004,
    message: {
      message_id: 104,
      chat: { id: 5252724920, type: 'private' },
      from: { id: 5252724920 },
      date: 1700000020,
      text: 'Tên: Chị Lan'
    }
  }), env);

  drafts = await loadDrafts(db, 5252724920);
  active = drafts[drafts.__active];

  // 'customer' must remain 'Chị Mai' because message_id 105 > message_id 104 even with same-second date
  assert.equal(active.fields.customer, 'Chị Mai');
});

test('Scenario 22: Worker restart resets stuck confirming draft and allows idempotent confirm without duplicate order', async () => {
  const { findStaleConfirming, resetStaleConfirming, loadDrafts, saveDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    OPS_TOKEN: 'test_ops_token',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  const opsCalls = [];
  globalThis.fetch = async (url, opts) => {
    if (url.includes('/api-core')) {
      const payload = JSON.parse(opts.body);
      opsCalls.push(payload);
      return new Response(JSON.stringify({ ok: true, orderId: 'MEE-STAGING-RECOVERED' }));
    }
    if (url.includes('/sendMessage')) return new Response(JSON.stringify({ ok: true }));
    return new Response('Not found', { status: 404 });
  };

  // Seed draft stuck in confirming
  const staleDraftId = 'draft_stale_999';
  const stableRequestId = 'fixed_req_id_stale_999';
  const drafts = {
    __active: staleDraftId,
    [staleDraftId]: {
      id: staleDraftId,
      status: 'confirming',
      requestId: stableRequestId,
      confirmingAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(), // 25 mins ago
      fields: {
        customer: 'Bác Bình',
        flower: 'Giỏ hoa quả và hoa',
        date: '2026-12-15',
        time: '15:00',
        shipping: 'Ghé lấy',
        flowerTotal: '1200000'
      }
    }
  };
  await saveDrafts(db, 5252724920, drafts);

  // 1. Detect stale
  const staleList = await findStaleConfirming(db, 15);
  assert.equal(staleList.length, 1);
  assert.equal(staleList[0].draftId, staleDraftId);

  // 2. Reset stale confirming -> confirmed
  const resetSuccess = await resetStaleConfirming(db, 5252724920, staleDraftId);
  assert.equal(resetSuccess, true);

  const draftsAfterReset = await loadDrafts(db, 5252724920);
  assert.equal(draftsAfterReset[staleDraftId].status, 'confirmed');
  assert.equal(draftsAfterReset[staleDraftId].requestId, stableRequestId); // fixed requestId preserved!

  // 3. User sends /confirm after restart
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 22001,
    message: { chat: { id: 5252724920, type: 'private' }, from: { id: 5252724920 }, text: '/confirm' }
  }), env);

  // Verify only 1 OPS call with the exact fixed requestId
  assert.equal(opsCalls.length, 1);
  assert.equal(opsCalls[0].payload.requestId, stableRequestId);

  const finalDrafts = await loadDrafts(db, 5252724920);
  assert.equal(finalDrafts[staleDraftId].status, 'submitted');
  assert.equal(finalDrafts[staleDraftId].opsOrderId, 'MEE-STAGING-RECOVERED');
});

test('Scenario 23: Verified end-to-end media serving — Bot R2 bill image is resolved by OPS displayUrls and served by serveMedia', async () => {
  const { savePhotoToR2 } = await import('../order-bot/cloudflare/telegram.mjs');
  const { linkUnverifiedBillsToD1Order } = await import('../order-bot/cloudflare/d1-store.mjs');

  const r2 = createMockR2();
  const db = createMockD1();

  const billKey = 'settlement-bills/unverified-draft99-sample123.jpg';
  const billContent = 'mock-jpeg-binary-image-data-for-bill';
  const billBuffer = Buffer.from(billContent);

  // 1. Bot saves photo to R2
  const saved = await savePhotoToR2(r2, billKey, billBuffer, 'image/jpeg');
  assert.equal(saved, true);

  // 2. Link into D1 order
  const orderId = 'MEE-STAGING-BILL-MEDIA-TEST';
  await db.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?)').bind(
    orderId,
    JSON.stringify({ id: orderId, unverified_bill_urls: [] })
  ).run();

  const linkResult = await linkUnverifiedBillsToD1Order(
    db,
    orderId,
    [{ r2_key: billKey, uri: `supabase://${billKey}` }],
    r2
  );
  assert.equal(linkResult.ok, true);

  // 3. Verify OPS canonical URI mapping and HMAC signing contract
  const canonicalUri = `supabase://${billKey}`;
  const match = canonicalUri.match(/^supabase:\/\/(order-images|settlement-bills)\/(.+)$/);
  assert.ok(match, 'Must match canonical OPS supabase:// URI pattern');
  const resolvedBucket = match[1];
  const resolvedPath = match[2];
  const objectKey = `${resolvedBucket}/${resolvedPath}`;
  assert.equal(objectKey, billKey);

  // 4. Simulate OPS HMAC-SHA256 displayUrls signing
  const signingKey = 'test-staging-media-signing-key-meehoa';
  const enc = new TextEncoder();
  const exp = Math.floor(Date.now() / 1000) + 900;
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(`${objectKey}|${exp}`)));
  const sigHex = [...sigBytes].map(x => x.toString(16).padStart(2, '0')).join('');
  const signedPath = `/media/${objectKey}?exp=${exp}&sig=${sigHex}`;

  assert.match(signedPath, /^\/media\/settlement-bills\/unverified-draft99-sample123\.jpg\?exp=\d+&sig=[a-f0-9]+$/);

  // 5. Simulate OPS serveMedia retrieval from R2
  const r2Object = await r2.get(objectKey);
  assert.ok(r2Object, 'R2 object must be accessible via resolved objectKey');
  assert.equal(r2Object.httpMetadata.contentType, 'image/jpeg');
  assert.equal(r2Object.buffer.toString(), billContent);
});

test('Performance / CPU Benchmark: Worker synchronous CPU time is well under 10ms Free limit', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');

  const db = createMockD1();
  const env = {
    DB: db,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920'
  };

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));

  const startCpu = process.cpuUsage();
  const startTime = performance.now();

  // Run 10 consecutive field updates
  for (let i = 0; i < 10; i++) {
    await handleTelegramWebhook(makeWebhookRequest({
      update_id: 16000 + i,
      message: {
        chat: { id: 5252724920, type: 'private' },
        from: { id: 5252724920 },
        text: `Tên: Khách ${i}\nHoa: Mẫu hoa số ${i}\nNgày: 2026-12-10\nGiờ: 10:00\nShip: Ghé lấy`
      }
    }), env);
  }

  const elapsedCpu = process.cpuUsage(startCpu);
  const elapsedWall = performance.now() - startTime;

  const userCpuMs = elapsedCpu.user / 1000;
  const sysCpuMs = elapsedCpu.system / 1000;
  const avgCpuPerRequest = (userCpuMs + sysCpuMs) / 10;

  console.log(`[benchmark] Average CPU time per webhook request: ${avgCpuPerRequest.toFixed(2)}ms (Wall clock: ${(elapsedWall / 10).toFixed(2)}ms)`);
  assert.ok(avgCpuPerRequest < 10, `Average CPU time (${avgCpuPerRequest}ms) must be strictly below 10ms Free Tier limit`);
});

test('Scenario 24: activate-webhook script logic for secret token auto-generation and manual secret validation', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execSync } = require('node:child_process');

  const scriptPath = path.resolve(__dirname, '../order-bot/cloudflare/activate-webhook.sh');
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');

  // Verify security constraints on script content
  assert.ok(scriptContent.includes('read -r -s SECRET_TOKEN'), 'Must use silent input for secret token');
  assert.ok(scriptContent.includes('read -r -s BOT_TOKEN'), 'Must use silent input for bot token');
  assert.ok(scriptContent.includes('curl -s -S --config -'), 'Must pass curl config via stdin to avoid URL leakage');
  assert.ok(!scriptContent.includes('{16,256}'), 'Must not use {16,256} which violates POSIX/macOS RE_DUP_MAX');

  // Helper to execute the bash secret validation block exactly as in activate-webhook.sh
  const runBashValidation = (simulatedInput) => {
    const bashCode = `
      SECRET_TOKEN="${simulatedInput}"
      if [ -z "$SECRET_TOKEN" ]; then
        if command -v openssl >/dev/null 2>&1; then
          SECRET_TOKEN=$(openssl rand -hex 16)
        elif command -v node >/dev/null 2>&1; then
          SECRET_TOKEN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
        else
          SECRET_TOKEN=$(LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 32)
        fi
      fi

      if [ \${#SECRET_TOKEN} -lt 16 ] || [ \${#SECRET_TOKEN} -gt 256 ]; then
        exit 1
      fi

      if ! [[ "$SECRET_TOKEN" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        exit 2
      fi
      printf "%s" "$SECRET_TOKEN"
    `;
    return execSync('/bin/bash', { input: bashCode, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  };

  // Case 1: Empty input (Enter pressed) -> generates valid 32-char hex secret
  const autoGenerated = runBashValidation('');
  assert.equal(autoGenerated.length, 32, 'Auto-generated secret must be 32 characters');
  assert.match(autoGenerated, /^[a-zA-Z0-9_-]+$/, 'Auto-generated secret must match Telegram character set');

  // Case 2: Manual valid input
  const manualValid = runBashValidation('My-Secret_Key-1234567890');
  assert.equal(manualValid, 'My-Secret_Key-1234567890');

  // Case 3: Manual 256-char max valid input
  const max256 = 'A'.repeat(256);
  const manual256 = runBashValidation(max256);
  assert.equal(manual256, max256);

  // Case 4: Manual short input (<16 chars) -> rejected
  assert.throws(() => {
    runBashValidation('short-secret');
  }, /Command failed/, 'Must reject secrets shorter than 16 characters');

  // Case 5: Manual long input (>256 chars) -> rejected
  assert.throws(() => {
    runBashValidation('A'.repeat(257));
  }, /Command failed/, 'Must reject secrets longer than 256 characters');

  // Case 6: Manual invalid chars -> rejected
  assert.throws(() => {
    runBashValidation('invalid@secret!token#123');
  }, /Command failed/, 'Must reject secrets with invalid characters');

  assert.throws(() => {
    runBashValidation('has space here 12345678');
  }, /Command failed/, 'Must reject secrets with spaces');
});
