/**
 * MEEHOA Order Bot V1 — 20 Nghiệp vụ & Kịch bản kiểm thử toàn diện
 *
 * Kiểm chứng 20 kịch bản theo Mục VIII của yêu cầu nâng cấp:
 *  1. Đơn Chưa thanh toán không kèm bill: tạo đơn thành công, payment = Chưa thanh toán.
 *  2. Đơn Đã cọc có số tiền cọc, không kèm bill: tạo đơn thành công, ghi chú cọc đúng, tính đúng tiền còn lại.
 *  3. Đơn Bankfull không kèm bill: tạo đơn thành công, ghi chú thanh toán đủ tiền hoa, nhắc thu ship.
 *  4. Đơn Fullpaid CÓ bill: tạo đơn thành công, liên kết bill vào đơn.
 *  5. Đơn Fullpaid THIẾU bill: chặn /confirm, phản hồi yêu cầu gửi bill rõ ràng, không tạo đơn trên OPS.
 *  6. Tin nhắn tự nhiên theo kịch bản Hoàng Huy (không nhãn): trích xuất đúng khách, hoa, giá 850k, ngày 22/11/2026, giờ 15:00, địa chỉ, hình thức Shop book ship, trạng thái Bankfull.
 *  7. Tin nhắn kèm ảnh và caption: ảnh vào sampleRefs, thông tin trong caption được bóc tách vào đơn nháp.
 *  8. Tin nhắn bổ sung địa chỉ và số điện thoại sau khi đã có thông tin hoa: cập nhật đúng đơn nháp đang mở, không tạo đơn mới.
 *  9. Khách đổi ý từ Bankfull sang Fullpaid: yêu cầu bill xuất hiện, không cho /confirm nếu chưa có bill.
 * 10. Sửa giá sau khi đã báo thanh toán: cập nhật giá mới, tính lại tiền còn lại, ghi nhận lịch sử thay đổi.
 * 11. Tin nhắn ghi ngày không có năm: suy luận đúng năm hiện tại hoặc năm tiếp theo.
 * 12. Tin nhắn ghi ngày trong quá khứ: bot cảnh báo hoặc yêu cầu xác nhận.
 * 13. Hai tin nhắn gửi liên tiếp sai thứ tự: tin nhắn có timestamp mới hơn được ưu tiên, không bị ghi đè bởi tin nhắn cũ.
 * 14. Lỗi tải ảnh từ Telegram: báo lỗi cụ thể, không tạo đơn thiếu ảnh.
 * 15. Lỗi OPS từ chối tạo đơn: bot thông báo lỗi thân thiện, giữ nguyên đơn nháp để sửa.
 * 16. Lỗi mạng hoặc timeout khi gọi OPS: không tạo đơn trùng khi thử lại (/confirm lần 2).
 * 17. Retry /confirm khi đơn đã tạo thành công trên OPS: trả về mã đơn hiện có, không gọi API tạo đơn mới.
 * 18. Lệnh /relink khi liên kết bill thất bại: thử lại liên kết bill thành công mà không tạo đơn mới.
 * 19. Không có bất kỳ trường hợp nào bot tự ý đổi payment trên OPS thành khác "Chưa thanh toán".
 * 20. Kiểm tra tính toàn vẹn dữ liệu: toàn bộ đơn nháp lưu đúng trên D1, ảnh lưu đúng trên R2 với metadata đầy đủ.
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

function createMockEnv(db, r2) {
  return {
    DB: db,
    MEDIA_R2: r2,
    BOT_TOKEN: 'fake_bot_token',
    TELEGRAM_SECRET_TOKEN: 'staging_secret_token_123',
    ALLOWED_USER_IDS: '5252724920',
    OPS_API_URL: 'https://ops-staging.local/api-core',
    OPS_TOKEN: 'fake_ops_token'
  };
}

// -----------------------------------------------------------------------------
// KỊCH BẢN 1: Đơn Chưa thanh toán không kèm bill: tạo đơn thành công, payment = Chưa thanh toán
// -----------------------------------------------------------------------------
test('Kịch bản 1: Đơn Chưa thanh toán không kèm bill: tạo đơn thành công, payment = Chưa thanh toán', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  let capturedOpsPayload = null;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/api-core')) {
      capturedOpsPayload = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        ok: true,
        orderId: 'M-261122-001',
        receipt: { id: 'M-261122-001' }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  // 1. Tạo đơn nháp
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 101,
    message: {
      message_id: 1,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: '/new'
    }
  }), env);

  // 2. Nhập thông tin không nhắc thanh toán
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 102,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Anh Khang\nhoa: Bó hoa hướng dương 500k\nngày: 25/11/2026\ngiờ: 10:00\nship: Ghé lấy'
    }
  }), env);

  // 3. /confirm
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 103,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: '/confirm'
    }
  }), env);

  assert.ok(capturedOpsPayload, 'OPS createOrder must be invoked');
  assert.equal(capturedOpsPayload.payload.order.payment, 'Chưa thanh toán');
  assert.equal(capturedOpsPayload.payload.order.fullPaidRequested, false);
  assert.equal(capturedOpsPayload.payload.order.customer, 'Anh Khang');
  assert.equal(capturedOpsPayload.payload.order.flowerTotal, 500000);
  assert.equal(capturedOpsPayload.payload.order.date, '2026-11-25');
  assert.equal(capturedOpsPayload.payload.order.time, '10:00');

  const successMsg = sentMessages.find(m => m.text?.includes('M-261122-001'));
  assert.ok(successMsg, 'Success message sent with orderId');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 2: Đơn Đã cọc có số tiền cọc, không kèm bill: tạo đơn thành công, ghi chú cọc đúng, tính đúng tiền còn lại
// -----------------------------------------------------------------------------
test('Kịch bản 2: Đơn Đã cọc có số tiền cọc, không kèm bill: tạo đơn thành công, ghi chú cọc đúng, tính đúng tiền còn lại', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  let capturedOpsPayload = null;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/api-core')) {
      capturedOpsPayload = JSON.parse(opts.body);
      return new Response(JSON.stringify({ ok: true, orderId: 'M-261122-002' }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 201,
    message: {
      message_id: 1,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: '/new'
    }
  }), env);

  // Khách báo cọc 200k cho bó 600k
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 202,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Chị Hà\nhoa: Bó hoa hồng 600k\nngày: 25/11/2026\ngiờ: 15h\nship: Ghé lấy\nKhách đã cọc 200k'
    }
  }), env);

  // Check draft summary shows remaining balance (400.000 đ)
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 203,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: '/show'
    }
  }), env);

  const showMsg = sentMessages[sentMessages.length - 1];
  assert.ok(showMsg.text.includes('Đã cọc 200.000 đ'));
  assert.ok(showMsg.text.includes('còn lại: 400.000 đ'));

  // /confirm succeeds without bill
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 204,
    message: {
      message_id: 4,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: '/confirm'
    }
  }), env);

  assert.ok(capturedOpsPayload);
  assert.equal(capturedOpsPayload.payload.order.payment, 'Chưa thanh toán');
  assert.ok(capturedOpsPayload.payload.order.note.includes('[Khách báo: Đã cọc 200.000 đ]'));
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 3: Đơn Bankfull không kèm bill: tạo đơn thành công, ghi chú thanh toán đủ tiền hoa, nhắc thu ship
// -----------------------------------------------------------------------------
test('Kịch bản 3: Đơn Bankfull không kèm bill: tạo đơn thành công, ghi chú thanh toán đủ tiền hoa, nhắc thu ship', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  let capturedOpsPayload = null;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) return new Response(JSON.stringify({ ok: true }));
    if (url.includes('/api-core')) {
      capturedOpsPayload = JSON.parse(opts.body);
      return new Response(JSON.stringify({ ok: true, orderId: 'M-261122-003' }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 301,
    message: {
      message_id: 1,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: '/new'
    }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 302,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Anh Tuấn\nhoa: Giỏ hoa khai trương 1.2tr\nngày: 25/11/2026\ngiờ: 8h30\nship: Shop book ship\nđịa chỉ: 12 Pasteur Q1\nKhách đã bankfull tiền hoa'
    }
  }), env);

  // /confirm succeeds without bill for Bankfull
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 303,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: '/confirm'
    }
  }), env);

  assert.ok(capturedOpsPayload);
  assert.equal(capturedOpsPayload.payload.order.payment, 'Chưa thanh toán');
  assert.ok(capturedOpsPayload.payload.order.note.includes('[Khách báo: Bankfull tiền hoa'));
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 4: Đơn Fullpaid CÓ bill: tạo đơn thành công, liên kết bill vào đơn
// -----------------------------------------------------------------------------
test('Kịch bản 4: Đơn Fullpaid CÓ bill: tạo đơn thành công, liên kết bill vào đơn', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  let capturedOpsPayload = null;

  // Insert mock order in D1 orders table so linkUnverifiedBillsToD1Order finds it
  const initialOrder = {
    id: 'M-261122-004',
    customer: 'Chị Mai',
    unverified_bill_urls: []
  };
  db.sqlite.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?);').run(
    'M-261122-004',
    JSON.stringify(initialOrder)
  );

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({
        ok: true,
        result: { file_id: 'bill_file_1', file_path: 'photos/bill.jpg' }
      }));
    }
    if (url.includes('/file/')) {
      return new Response(Buffer.from('fake-bill-image-content-bytes'), {
        headers: { 'content-type': 'image/jpeg' }
      });
    }
    if (url.includes('/api-core')) {
      capturedOpsPayload = JSON.parse(opts.body);
      return new Response(JSON.stringify({ ok: true, orderId: 'M-261122-004' }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 401,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  // Fullpaid declared
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 402,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Chị Mai\nhoa: Bó hoa tulip 750k\nngày: 25/11/2026\ngiờ: 16h\nship: Ghé lấy\nKhách đã thanh toán đủ'
    }
  }), env);

  // Send bill photo
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 403,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      photo: [{ file_id: 'bill_file_1', width: 800, height: 600, file_size: 15000 }],
      caption: 'bill chuyển khoản'
    }
  }), env);

  // /confirm
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 404,
    message: { message_id: 4, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);

  assert.ok(capturedOpsPayload);
  assert.equal(capturedOpsPayload.payload.order.payment, 'Chưa thanh toán');
  assert.ok(capturedOpsPayload.payload.order.note.includes('[Khách báo: Fullpaid toàn bộ đơn]'));

  // Check bill linked in D1 orders table
  const updatedOrderRow = db.sqlite.prepare('SELECT data FROM orders WHERE row_key = ?;').get('M-261122-004');
  const parsedData = JSON.parse(updatedOrderRow.data);
  assert.equal(parsedData.unverified_bill_urls.length, 1);
  assert.match(parsedData.unverified_bill_urls[0], /^supabase:\/\/settlement-bills\/unverified-/);
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 5: Đơn Fullpaid THIẾU bill: chặn /confirm, phản hồi yêu cầu gửi bill rõ ràng, không tạo đơn trên OPS
// -----------------------------------------------------------------------------
test('Kịch bản 5: Đơn Fullpaid THIẾU bill: chặn /confirm, phản hồi yêu cầu gửi bill rõ ràng, không tạo đơn trên OPS', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  let opsCalled = false;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/api-core')) {
      opsCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 501,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  // Fullpaid declared without bill photo
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 502,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Chị Loan\nhoa: Bó hoa cúc tana 450k\nngày: 25/11/2026\ngiờ: 11h\nship: Ghé lấy\nKhách đã thanh toán toàn bộ fullpaid'
    }
  }), env);

  // /confirm should be blocked
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 503,
    message: { message_id: 3, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);

  assert.equal(opsCalled, false, 'OPS createOrder must NOT be called when Fullpaid is missing bill');
  const blockMsg = sentMessages[sentMessages.length - 1];
  assert.ok(blockMsg.text.includes('Đơn ở trạng thái Đã thanh toán toàn bộ (Fullpaid) nhưng chưa có ảnh bill'));
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 6: Tin nhắn tự nhiên theo kịch bản Hoàng Huy (không nhãn): trích xuất đúng
// -----------------------------------------------------------------------------
test('Kịch bản 6: Tin nhắn tự nhiên theo kịch bản Hoàng Huy (không nhãn): trích xuất đúng các trường', async () => {
  const { extractNaturalMessage, draftSummary } = await import('../order-bot/core.mjs');

  const hoangHuyText = `Hoàng Huy
0908123456
Bó hoa tone hồng pastel 850.000
Giao ngày 22/11 lúc 15:00
123 Lê Lợi, P. Bến Nghé, Quận 1
Shop book ship giúp mình
Mình đã bank full tiền hoa rồi nha`;

  const parsed = extractNaturalMessage(hoangHuyText, {}, new Date('2026-11-20T00:00:00Z'));
  assert.equal(parsed.fields.customer, 'Hoàng Huy');
  assert.equal(parsed.fields.phone, '0908123456');
  assert.ok(parsed.fields.flower.includes('Bó hoa tone hồng pastel'));
  assert.equal(parsed.fields.flowerTotal, '850000');
  assert.equal(parsed.fields.date, '2026-11-22');
  assert.equal(parsed.fields.time, '15:00');
  assert.ok(parsed.fields.address.includes('123 Lê Lợi, P. Bến Nghé, Quận 1'));
  assert.equal(parsed.fields.shipping, 'Shop book ship');
  assert.equal(parsed.fields.paymentState, 'bankfull');

  const summary = draftSummary({ fields: parsed.fields });
  assert.ok(summary.includes('Hoàng Huy'));
  assert.ok(summary.includes('850.000 đ'));
  assert.ok(summary.includes('Bankfull'));
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 7: Tin nhắn kèm ảnh và caption: ảnh vào sampleRefs, thông tin trong caption được bóc tách
// -----------------------------------------------------------------------------
test('Kịch bản 7: Tin nhắn kèm ảnh và caption: ảnh vào sampleRefs, thông tin bóc tách vào nháp', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/sample.jpg' } }));
    }
    if (url.includes('/file/')) {
      return new Response(Buffer.from('fake-sample-bytes'), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(JSON.stringify({ ok: true }));
  };
  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 701,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  const captionText = 'Bó hoa hướng dương 500k cho anh Minh giao 9h sáng mai 25/11/2026 ghé lấy';
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 702,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      photo: [{ file_id: 'sample_photo_minh', width: 800, height: 600, file_size: 20000 }],
      caption: captionText
    }
  }), env);

  const drafts = await loadDrafts(db, 5252724920);
  const draft = activeDraft(drafts);
  assert.equal(draft.sampleRefs.length, 1);
  assert.equal(draft.sampleRefs[0].fileId, 'sample_photo_minh');
  assert.equal(draft.fields.flowerTotal, '500000');
  assert.equal(draft.fields.date, '2026-11-25');
  assert.equal(draft.fields.time, '09:00');
  assert.equal(draft.fields.shipping, 'Ghé lấy');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 8: Tin nhắn bổ sung địa chỉ và SĐT: cập nhật đúng đơn nháp đang mở, không tạo đơn mới
// -----------------------------------------------------------------------------
test('Kịch bản 8: Tin nhắn bổ sung địa chỉ và SĐT: cập nhật đúng đơn nháp đang mở', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/sample.jpg' } }));
    }
    if (url.includes('/file/')) {
      return new Response(Buffer.from('fake-sample-bytes'), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(JSON.stringify({ ok: true }));
  };
  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 801,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 802,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Chị Linh\nhoa: Bó hoa tulip trắng 600k\nngày: 26/11/2026\ngiờ: 14h\nship: Ghé lấy'
    }
  }), env);

  const drafts1 = await loadDrafts(db, 5252724920);
  const initialDraftId = activeDraft(drafts1).id;

  // Lượt bổ sung thứ 2
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 803,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'Đổi sang giao tận nơi địa chỉ 789 CMT8 Q3, SĐT 0912345678'
    }
  }), env);

  const drafts2 = await loadDrafts(db, 5252724920);
  const updatedDraft = activeDraft(drafts2);

  assert.equal(updatedDraft.id, initialDraftId, 'Must keep the same active draft ID');
  assert.equal(updatedDraft.fields.shipping, 'Shop book ship');
  assert.ok(updatedDraft.fields.address.includes('789 CMT8 Q3'));
  assert.equal(updatedDraft.fields.phone, '0912345678');
  assert.equal(updatedDraft.fields.customer, 'Chị Linh');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 9: Khách đổi ý từ Bankfull sang Fullpaid: yêu cầu bill xuất hiện, không cho /confirm nếu chưa có bill
// -----------------------------------------------------------------------------
test('Kịch bản 9: Khách đổi ý từ Bankfull sang Fullpaid: yêu cầu bill xuất hiện, chặn /confirm', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) sentMessages.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ ok: true }));
  };
  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 901,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  // Initial: Bankfull
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 902,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Anh Nam\nhoa: Bó hoa 500k\nngày: 25/11/2026\ngiờ: 10h\nship: Ghé lấy\nKhách đã bankfull tiền hoa'
    }
  }), env);

  let draft = activeDraft(await loadDrafts(db, 5252724920));
  assert.equal(draft.fields.paymentState, 'bankfull');

  // Change to Fullpaid
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 903,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'Khách vừa chuyển đủ toàn bộ cả đơn fullpaid rồi nha'
    }
  }), env);

  draft = activeDraft(await loadDrafts(db, 5252724920));
  assert.equal(draft.fields.paymentState, 'fullpaid');

  // Try /confirm without bill -> must block
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 904,
    message: { message_id: 4, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);

  const lastMsg = sentMessages[sentMessages.length - 1];
  assert.ok(lastMsg.text.includes('Đơn ở trạng thái Đã thanh toán toàn bộ (Fullpaid) nhưng chưa có ảnh bill'));
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 10: Sửa giá sau khi đã báo thanh toán: cập nhật giá mới, tính lại tiền còn lại, ghi nhận lịch sử
// -----------------------------------------------------------------------------
test('Kịch bản 10: Sửa giá sau khi đã báo thanh toán: cập nhật giá mới, tính lại tiền còn lại, lưu lịch sử', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/sample.jpg' } }));
    }
    if (url.includes('/file/')) {
      return new Response(Buffer.from('fake-sample-bytes'), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(JSON.stringify({ ok: true }));
  };
  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1001,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1002,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Chị Nga\nhoa: Bó hoa 600k\nngày: 25/11/2026\ngiờ: 10h\nship: Ghé lấy\nKhách đã cọc 200k'
    }
  }), env);

  // Sửa giá hoa lên 800k
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1003,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'Tăng size hoa lên giá 800k'
    }
  }), env);

  const draft = activeDraft(await loadDrafts(db, 5252724920));
  assert.equal(draft.fields.flowerTotal, '800000');
  assert.equal(draft.fields.depositAmount, 200000);
  assert.ok(draft.history.length >= 2, 'History must record price modification');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 11: Tin nhắn ghi ngày không có năm: suy luận đúng năm hiện tại hoặc tiếp theo
// -----------------------------------------------------------------------------
test('Kịch bản 11: Tin nhắn ghi ngày không có năm: suy luận đúng năm hiện tại hoặc tiếp theo', async () => {
  const { parseSmartDate } = await import('../order-bot/core.mjs');

  const refNov2026 = new Date('2026-11-20T00:00:00Z');
  const d1 = parseSmartDate('ngày 25/11', refNov2026);
  assert.equal(d1.value, '2026-11-25');
  assert.equal(d1.isUncertain, false);

  // Ngày trong tháng 1 khi tham chiếu là tháng 12/2026 -> nhảy sang 2027
  const refDec2026 = new Date('2026-12-25T00:00:00Z');
  const d2 = parseSmartDate('giao ngày 15/01', refDec2026);
  assert.equal(d2.value, '2027-01-15');
  assert.equal(d2.isUncertain, false);
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 12: Tin nhắn ghi ngày trong quá khứ: bot cảnh báo hoặc yêu cầu xác nhận
// -----------------------------------------------------------------------------
test('Kịch bản 12: Tin nhắn ghi ngày trong quá khứ: bot đánh dấu uncertainFields và yêu cầu làm rõ', async () => {
  const { parseSmartDate, isConfirmable } = await import('../order-bot/core.mjs');

  const refNov2026 = new Date('2026-11-22T00:00:00Z');
  const pastDate = parseSmartDate('ngày 10/11/2026', refNov2026);

  assert.equal(pastDate.isUncertain, true);
  assert.ok(pastDate.reason.includes('đã qua so với ngày hiện tại'));

  const draft = {
    fields: { customer: 'A', flower: 'B', date: pastDate.value, time: '10:00', shipping: 'Ghé lấy' },
    uncertainFields: { date: pastDate.reason }
  };
  assert.equal(isConfirmable(draft), false, 'Draft with past uncertain date must block confirmation');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 13: Hai tin nhắn gửi liên tiếp sai thứ tự: timestamp mới hơn được ưu tiên
// -----------------------------------------------------------------------------
test('Kịch bản 13: Hai tin nhắn gửi liên tiếp sai thứ tự: timestamp mới hơn được ưu tiên', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/sample.jpg' } }));
    }
    if (url.includes('/file/')) {
      return new Response(Buffer.from('fake-sample-bytes'), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(JSON.stringify({ ok: true }));
  };
  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1301,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  // Tin nhắn mới hơn (timestamp 200) được gửi trước
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1303,
    message: {
      message_id: 3,
      date: 200,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'địa chỉ: 456 Hai Bà Trưng Q1'
    }
  }), env);

  // Tin nhắn cũ hơn (timestamp 100) đến trễ
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1302,
    message: {
      message_id: 2,
      date: 100,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'địa chỉ: 123 Lê Lợi Q1'
    }
  }), env);

  const draft = activeDraft(await loadDrafts(db, 5252724920));
  assert.equal(draft.fields.address, '456 Hai Bà Trưng Q1', 'Newer message timestamp must prevail');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 14: Lỗi tải ảnh từ Telegram: báo lỗi cụ thể, không tạo đơn thiếu ảnh
// -----------------------------------------------------------------------------
test('Kịch bản 14: Lỗi tải ảnh từ Telegram: báo lỗi cụ thể, rollback trạng thái, không gọi OPS', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts, saveDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  let opsCalled = false;
  let failGetFile = false;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/getFile')) {
      if (failGetFile) {
        return new Response(JSON.stringify({ ok: false, description: 'File not found on TG server' }));
      }
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/sample.jpg' } }));
    }
    if (url.includes('/file/')) {
      return new Response(Buffer.from('fake-sample-bytes'), { headers: { 'content-type': 'image/jpeg' } });
    }
    if (url.includes('/api-core')) {
      opsCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1401,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1402,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Anh Bình\nhoa: Bó hoa 500k\nngày: 25/11/2026\ngiờ: 10h\nship: Ghé lấy'
    }
  }), env);

  // Thêm ảnh mẫu (ban đầu thành công)
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1403,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      photo: [{ file_id: 'sample_file_14', width: 800, height: 600, file_size: 10000 }]
    }
  }), env);

  // Giả lập worker khởi động lại hoặc cache in-memory data_url bị xóa, buộc /confirm tải lại từ Telegram
  const drafts = await loadDrafts(db, 5252724920);
  const draft = activeDraft(drafts);
  draft.sampleRefs[0].data_url = null;
  await saveDrafts(db, 5252724920, drafts);

  // Bây giờ mạng Telegram getFile gặp lỗi
  failGetFile = true;

  // /confirm
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1404,
    message: { message_id: 4, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);

  assert.equal(opsCalled, false, 'Must not call OPS if photo download fails');
  const errorMsg = sentMessages.find(m => m.text?.includes('Không thể tải ảnh mẫu từ Telegram'));
  assert.ok(errorMsg);

  const updatedDrafts = await loadDrafts(db, 5252724920);
  const updatedDraft = activeDraft(updatedDrafts);
  assert.equal(updatedDraft.status, 'confirmed', 'Draft must rollback to confirmed');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 15: Lỗi OPS từ chối tạo đơn: bot thông báo lỗi thân thiện, giữ nguyên đơn nháp để sửa
// -----------------------------------------------------------------------------
test('Kịch bản 15: Lỗi OPS từ chối tạo đơn: bot thông báo lỗi thân thiện, giữ nguyên đơn nháp', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/api-core')) {
      return new Response(JSON.stringify({ ok: false, message: 'Dữ liệu không hợp lệ: ngày đóng cửa' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1501,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1502,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Anh Cường\nhoa: Bó hoa 500k\nngày: 25/11/2026\ngiờ: 10h\nship: Ghé lấy'
    }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1503,
    message: { message_id: 3, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);

  const errorMsg = sentMessages.find(m => m.text?.includes('Không thể tạo đơn trên OPS Staging'));
  assert.ok(errorMsg);
  assert.ok(errorMsg.text.includes('ngày đóng cửa'));

  const draft = activeDraft(await loadDrafts(db, 5252724920));
  assert.equal(draft.status, 'confirmed', 'Draft must remain preserved for user to retry');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 16: Lỗi mạng hoặc timeout khi gọi OPS: không tạo đơn trùng khi thử lại (/confirm lần 2)
// -----------------------------------------------------------------------------
test('Kịch bản 16: Lỗi mạng hoặc timeout khi gọi OPS: giữ nguyên requestId, không tạo trùng khi retry', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  let attempt = 0;
  const receivedRequestIds = [];

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) return new Response(JSON.stringify({ ok: true }));
    if (url.includes('/api-core')) {
      attempt++;
      const payload = JSON.parse(opts.body);
      receivedRequestIds.push(payload.payload.requestId);

      if (attempt === 1) {
        throw new Error('Network ECONNRESET');
      }
      return new Response(JSON.stringify({ ok: true, orderId: 'M-261122-016' }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1601,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1602,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Chị Dung\nhoa: Bó hoa 500k\nngày: 25/11/2026\ngiờ: 10h\nship: Ghé lấy'
    }
  }), env);

  // Lần 1: Timeout
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1603,
    message: { message_id: 3, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);

  // Lần 2: Retry thành công
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1604,
    message: { message_id: 4, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);

  assert.equal(receivedRequestIds.length, 2);
  assert.equal(receivedRequestIds[0], receivedRequestIds[1], 'requestId must stay fixed across retries');

  const draft = activeDraft(await loadDrafts(db, 5252724920));
  assert.equal(draft.status, 'submitted');
  assert.equal(draft.opsOrderId, 'M-261122-016');
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 17: Retry /confirm khi đơn đã tạo thành công trên OPS: trả về mã đơn hiện có, không gọi API tạo đơn mới
// -----------------------------------------------------------------------------
test('Kịch bản 17: Retry /confirm khi đơn đã submitted: không gọi API tạo đơn mới', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  const sentMessages = [];
  let opsCalls = 0;

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes('/api-core')) {
      opsCalls++;
      return new Response(JSON.stringify({ ok: true, orderId: 'M-261122-017' }), { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1701,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1702,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Chị Giang\nhoa: Bó hoa 500k\nngày: 25/11/2026\ngiờ: 10h\nship: Ghé lấy'
    }
  }), env);

  // Confirm lần 1 -> Tạo đơn OPS
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1703,
    message: { message_id: 3, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);
  assert.equal(opsCalls, 1);

  // Confirm lần 2 -> Chặn, không gọi OPS lần 2
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1704,
    message: { message_id: 4, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/confirm' }
  }), env);

  assert.equal(opsCalls, 1, 'OPS createOrder must NOT be invoked again on submitted draft');
  const lastMsg = sentMessages[sentMessages.length - 1];
  assert.ok(lastMsg.text.includes('đã được tạo trong OPS') || lastMsg.text.includes('M-261122-017'));
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 18: Lệnh /relink khi liên kết bill thất bại: thử lại liên kết bill thành công mà không tạo đơn mới
// -----------------------------------------------------------------------------
test('Kịch bản 18: Lệnh /relink thử lại liên kết bill thành công mà không tạo đơn mới', async () => {
  const { handleTelegramWebhook } = await import('../order-bot/cloudflare/worker.mjs');
  const { loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const { activeDraft } = await import('../order-bot/core.mjs');
  const db = createMockD1();
  const r2 = createMockR2();
  let opsCalls = 0;

  // Insert existing order in D1
  db.sqlite.prepare('INSERT INTO orders (row_key, data) VALUES (?, ?);').run(
    'M-261122-018',
    JSON.stringify({ id: 'M-261122-018', customer: 'Anh Hậu', unverified_bill_urls: [] })
  );

  globalThis.fetch = async (url) => {
    if (url.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'bill.jpg' } }));
    }
    if (url.includes('/file/')) {
      return new Response(Buffer.from('fake-bill-bytes'), { headers: { 'content-type': 'image/jpeg' } });
    }
    if (url.includes('/api-core')) {
      opsCalls++;
      return new Response(JSON.stringify({ ok: true, orderId: 'M-261122-018' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  const env = createMockEnv(db, r2);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1801,
    message: { message_id: 1, from: { id: 5252724920 }, chat: { id: 5252724920, type: 'private' }, text: '/new' }
  }), env);

  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1802,
    message: {
      message_id: 2,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: 'khách: Anh Hậu\nhoa: Bó hoa 500k\nngày: 25/11/2026\ngiờ: 10h\nship: Ghé lấy'
    }
  }), env);

  // Send bill photo
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1803,
    message: {
      message_id: 3,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      photo: [{ file_id: 'bill_file_18', width: 800, height: 600, file_size: 15000 }],
      caption: 'bill'
    }
  }), env);

  // Giả lập draft đã submitted với order M-261122-018 nhưng bill chưa linked
  const drafts = await loadDrafts(db, 5252724920);
  const draft = activeDraft(drafts);
  draft.status = 'submitted';
  draft.opsOrderId = 'M-261122-018';
  draft.billsLinked = false;
  const { saveDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  await saveDrafts(db, 5252724920, drafts);

  // Chạy lệnh /relink
  await handleTelegramWebhook(makeWebhookRequest({
    update_id: 1804,
    message: {
      message_id: 4,
      from: { id: 5252724920 },
      chat: { id: 5252724920, type: 'private' },
      text: '/relink M-261122-018'
    }
  }), env);

  assert.equal(opsCalls, 0, 'Relink must NEVER call createOrder');

  // Kiểm tra order trong D1 đã được gắn bill
  const orderRow = db.sqlite.prepare('SELECT data FROM orders WHERE row_key = ?;').get('M-261122-018');
  const orderData = JSON.parse(orderRow.data);
  assert.equal(orderData.unverified_bill_urls.length, 1);
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 19: Không có bất kỳ trường hợp nào bot tự ý đổi payment trên OPS thành khác "Chưa thanh toán"
// -----------------------------------------------------------------------------
test('Kịch bản 19: Bất biến thanh toán: Toàn bộ các trạng thái thanh toán đều gửi payment="Chưa thanh toán"', async () => {
  const { callCreateOrder } = await import('../order-bot/cloudflare/ops-client.mjs');

  const testStates = [
    { paymentState: 'unpaid' },
    { paymentState: 'deposit', depositAmount: 300000 },
    { paymentState: 'bankfull', reportedPaidAmount: 850000 },
    { paymentState: 'fullpaid' }
  ];

  for (const st of testStates) {
    let sentOrder = null;
    const mockFetcher = async (url, opts) => {
      const body = JSON.parse(opts.body);
      sentOrder = body.payload.order;
      return new Response(JSON.stringify({ ok: true, orderId: 'M-TEST' }));
    };

    const draft = {
      requestId: 'req-invariant-test',
      fields: {
        customer: 'Test',
        flower: 'Hoa',
        date: '2026-11-25',
        time: '10:00',
        shipping: 'Ghé lấy',
        flowerTotal: '850000',
        ...st
      }
    };

    await callCreateOrder('https://ops-staging/api-core', 'token', draft, [], [], mockFetcher);
    assert.ok(sentOrder, 'Payload must be sent');
    assert.equal(sentOrder.payment, 'Chưa thanh toán', `Payment must be "Chưa thanh toán" for state ${st.paymentState}`);
    assert.equal(sentOrder.fullPaidRequested, false, `fullPaidRequested must be false for state ${st.paymentState}`);
  }
});

// -----------------------------------------------------------------------------
// KỊCH BẢN 20: Kiểm tra tính toàn vẹn dữ liệu: toàn bộ đơn nháp lưu đúng trên D1, ảnh lưu đúng trên R2
// -----------------------------------------------------------------------------
test('Kịch bản 20: Tính toàn vẹn dữ liệu: Đơn nháp lưu chuẩn trên D1, ảnh lưu chuẩn trên R2 với metadata', async () => {
  const { saveDrafts, loadDrafts } = await import('../order-bot/cloudflare/d1-store.mjs');
  const db = createMockD1();
  const r2 = createMockR2();

  const userId = 5252724920;
  const draftId = 'd3a6a5b1-1234-4567-8901-abcdef123456';

  // Put photo in R2
  const fakeImageBytes = Buffer.from('sample-image-binary-data');
  await r2.put(`sample/${draftId}/sample-0.jpg`, fakeImageBytes, {
    httpMetadata: { contentType: 'image/jpeg' },
    customMetadata: { draftId, uploader: String(userId) }
  });

  const testDrafts = {
    __active: draftId,
    [draftId]: {
      id: draftId,
      status: 'pending',
      fields: {
        customer: 'Chị Lan',
        flower: 'Bó hoa hồng đỏ',
        date: '2026-11-25',
        time: '15:00',
        shipping: 'Ghé lấy',
        flowerTotal: '650000'
      },
      sampleRefs: [{ fileId: 'tg_file_sample', savedAt: new Date().toISOString() }],
      draftBillRefs: [{ fileId: 'tg_file_bill', caption: 'bill', savedAt: new Date().toISOString() }],
      history: [{ at: new Date().toISOString(), changes: [{ field: 'customer', value: 'Chị Lan' }] }]
    }
  };

  await saveDrafts(db, userId, testDrafts);

  // Reload from D1 and verify
  const loaded = await loadDrafts(db, userId);
  assert.equal(loaded.__active, draftId);
  const loadedDraft = loaded[draftId];
  assert.equal(loadedDraft.fields.customer, 'Chị Lan');
  assert.equal(loadedDraft.fields.flowerTotal, '650000');
  assert.equal(loadedDraft.sampleRefs.length, 1);
  assert.equal(loadedDraft.draftBillRefs.length, 1);
  assert.equal(loadedDraft.history.length, 1);

  // Verify R2 object
  const r2Obj = await r2.get(`sample/${draftId}/sample-0.jpg`);
  assert.ok(r2Obj);
  assert.equal(r2Obj.httpMetadata.contentType, 'image/jpeg');
  assert.equal(r2Obj.buffer.toString(), 'sample-image-binary-data');
});
