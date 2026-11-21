/**
 * MEEHOA Order Bot — Telegram long-polling runner (staging only)
 *
 * Environment variables required:
 *   BOT_TOKEN          Telegram Bot token
 *   ALLOWED_USER_IDS   Comma-separated Telegram user IDs (integer) allowed to use the bot
 *   OPS_API_URL        https://... URL of the meehoasg-api-core Supabase Function
 *   OPS_TOKEN          OPS session token (login session, NOT service role key)
 *   GEMINI_API_KEY     (optional) Gemini key for field extraction from forwarded messages
 *   GEMINI_MODEL       (optional) Gemini model name, default gemini-1.5-flash-latest
 *
 * Bill images:
 *   - Photos captioned with "bill" or "hóa đơn" (case-insensitive) are treated as bill images.
 *   - Bill images are stored as Telegram file_ids in the draft (draftBillRefs[]).
 *   - On /confirm, only sample images (sampleRefs[]) are downloaded & uploaded to OPS.
 *   - Bill images are NEVER forwarded to createOrder; fullPaidRequested is NEVER set.
 *   - After a successful createOrder, the bot reports the saved draft bill refs separately
 *     so the operator knows they exist and can submit them manually via OPS if needed.
 *
 * Idempotency:
 *   - Each /confirm attempt uses a stable requestId stored in the draft.
 *   - Telegram update IDs are tracked to avoid reprocessing.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { handleUpdate, addBillRef, addSampleRef, markSubmitted, draftSummary, loadDrafts, saveDrafts } from './core.mjs';

const require = createRequire(import.meta.url);

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ALLOWED_IDS = new Set((process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const OPS_API_URL = process.env.OPS_API_URL || '';
const OPS_TOKEN = process.env.OPS_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest';

if (!BOT_TOKEN) { console.error('BOT_TOKEN is required'); process.exit(1); }
if (!OPS_API_URL) { console.error('OPS_API_URL is required'); process.exit(1); }
if (!OPS_TOKEN) { console.error('OPS_TOKEN is required'); process.exit(1); }
if (!ALLOWED_IDS.size) { console.error('ALLOWED_USER_IDS is required'); process.exit(1); }

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const SEEN_UPDATES = new Set();
let offset = 0;

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function tgCall(method, body = {}) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`TG ${method}: ${data.description}`);
  return data.result;
}

async function sendMessage(chatId, text) {
  if (!text) return;
  try {
    await tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
  } catch {
    // Fallback without markdown
    await tgCall('sendMessage', { chat_id: chatId, text });
  }
}

async function downloadPhoto(fileId) {
  const file = await tgCall('getFile', { file_id: fileId });
  const path = file.file_path;
  if (!path) throw new Error('No file_path returned from getFile');
  const r = await fetch(`${TG_FILE}/${path}`);
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  // Convert to base64 data URL (jpeg assumed; Telegram sends JPEG for photos)
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:image/jpeg;base64,${b64}`;
}

// ---------------------------------------------------------------------------
// Bill image detection
// ---------------------------------------------------------------------------

function isBillCaption(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /bill|hoa don|thanh toan/.test(lower);
}

// ---------------------------------------------------------------------------
// Optional Gemini field extraction
// ---------------------------------------------------------------------------

async function extractFieldsWithGemini(text) {
  if (!GEMINI_KEY || !text) return null;
  try {
    const prompt = `Bạn là trợ lý trích xuất thông tin đơn hoa từ tin nhắn Telegram của khách hàng.\n\nTin nhắn:\n"""\n${text}\n"""\n\nTrả về JSON với các trường sau (bỏ qua nếu không có):\n- customer: tên khách\n- flower: mẫu/loại hoa\n- date: ngày nhận, định dạng YYYY-MM-DD\n- time: giờ nhận, định dạng HH:MM\n- shipping: một trong ["Shop book ship", "Khách tự book", "Ghé lấy"]\n- address: địa chỉ giao\n- phone: số điện thoại\n- note: ghi chú\n- flowerTotal: tổng tiền hoa (số nguyên, không đơn vị)\n\nKhông suy đoán nếu không có thông tin rõ ràng. Chỉ trả về JSON, không giải thích.`;

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OPS createOrder call
// ---------------------------------------------------------------------------

/**
 * Call meehoasg-api-core createOrder.
 * Note: fullPaidRequested is NEVER set, payment is always 'Chưa thanh toán'.
 * Bill images from draft are NOT forwarded here.
 *
 * @param {object} draft — the confirmed draft (status === 'confirmed')
 * @param {string[]} sampleDataUrls — base64 data URLs of downloaded sample images
 * @returns {Promise<object>} OPS response
 */
async function callCreateOrder(draft, sampleDataUrls) {
  const f = draft.fields || {};
  const payload = {
    name: 'createOrder',
    payload: {
      token: OPS_TOKEN,
      requestId: draft.requestId,
      order: {
        customer: f.customer || '',
        flower: f.flower || '',
        date: f.date || '',
        time: f.time || '',
        shipping: f.shipping || '',
        address: f.address || '',
        phone: f.phone || '',
        note: f.note || '',
        flowerTotal: f.flowerTotal || 0,
        payment: 'Chưa thanh toán',   // ALWAYS; never auto-confirm payment
        sale: f.sale || '',
        card: false,
        cardQty: 0,
        cardText: '',
        banner: false,
        bannerQty: 0,
        bannerText: '',
        charmFee: f.charmFee || 0,
        charmText: f.charmText || '',
        paperFee: f.paperFee || 0,
        paperText: f.paperText || '',
        vat: f.vat || 0,
        // Sample images attached as imageFiles (base64):
        imageFiles: sampleDataUrls.map(data => ({ data })),
        // Bill images are NOT included; fullPaidRequested intentionally absent/false.
      },
    },
  };

  const r = await fetch(OPS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`OPS HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Confirm flow
// ---------------------------------------------------------------------------

async function runConfirm(userId, chatId, drafts) {
  const draft = Object.values(drafts).find(d => d.id === drafts.__active && d.status === 'confirmed');
  if (!draft) {
    await sendMessage(chatId, '⚠️ Không tìm thấy đơn nháp đã xác nhận.');
    return;
  }

  await sendMessage(chatId, `⏳ Đang tạo đơn trong OPS...\n\n${draftSummary(draft)}`);

  // Download sample images (not bill images)
  const sampleRefs = draft.sampleRefs || [];
  const sampleDataUrls = [];
  const failedSamples = [];
  for (const ref of sampleRefs.slice(0, 10)) {
    try {
      const dataUrl = await downloadPhoto(ref.fileId);
      sampleDataUrls.push(dataUrl);
    } catch (e) {
      failedSamples.push(ref.fileId.slice(-8));
      console.error('Sample download failed', e.message);
    }
  }
  if (failedSamples.length) {
    await sendMessage(chatId, `⚠️ Không tải được ${failedSamples.length} ảnh mẫu — tiếp tục tạo đơn không có ảnh đó.`);
  }

  // Call OPS — bill images are intentionally excluded
  let result;
  try {
    result = await callCreateOrder(draft, sampleDataUrls);
  } catch (e) {
    console.error('OPS createOrder failed', e);
    await sendMessage(chatId, `❌ Lỗi khi tạo đơn trong OPS:\n${e.message}\n\nRequestId: ${draft.requestId}\nBạn có thể thử /confirm lại — requestId giữ nguyên.`);
    return;
  }

  if (!result?.ok) {
    await sendMessage(chatId, `❌ OPS từ chối tạo đơn:\n${result?.message || JSON.stringify(result)}`);
    return;
  }

  // Mark submitted
  const updated = markSubmitted(drafts, draft.id, result.orderId || result.order?.id || '');
  saveDrafts(userId, updated);

  const orderId = result.orderId || result.order?.id || '(không rõ)';
  const billCount = (draft.draftBillRefs || []).length;

  let msg = `✅ Đã tạo đơn trong OPS!\nMã đơn: *${orderId}*\n`;
  if (sampleDataUrls.length) msg += `📷 Ảnh mẫu: ${sampleDataUrls.length} ảnh đã gắn vào đơn.\n`;
  if (billCount) {
    msg += `\n🧾 *Lưu ý ảnh bill:* Nháp có ${billCount} ảnh bill chưa xác minh TT.\n`;
    msg += `Thanh toán chưa được xác nhận. Khi cần tất toán, operator tải ảnh bill lên qua luồng tất toán trong OPS.\n`;
  }
  msg += `\nThanh toán: Chưa thanh toán (cố định — không tự đánh dấu paid).`;

  await sendMessage(chatId, msg);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (!userId || !chatId) return;

  // Private chat only
  if (msg.chat?.type !== 'private') return;

  // Access control
  if (!ALLOWED_IDS.has(String(userId))) {
    await sendMessage(chatId, 'Bạn không có quyền dùng bot này.');
    return;
  }

  const text = msg.text || msg.caption || '';
  const photos = msg.photo;
  const photoFileId = photos?.length ? photos[photos.length - 1].file_id : null;
  const photoCaption = msg.caption || '';

  // Gemini extraction for forwarded/long messages (no photo, no command)
  let processedText = text;
  if (!photoFileId && text && !text.startsWith('/') && text.length > 50 && GEMINI_KEY) {
    const extracted = await extractFieldsWithGemini(text);
    if (extracted && Object.keys(extracted).length > 0) {
      // Convert extracted fields to "field: value" lines for core.mjs to process
      const lines = Object.entries(extracted).map(([k, v]) => `${k}: ${v}`).join('\n');
      processedText = lines;
      console.log(`Gemini extracted ${Object.keys(extracted).length} fields`);
    }
  }

  const result = handleUpdate({
    userId,
    text: processedText,
    photoFileId,
    photoCaption,
    isBillHint: isBillCaption(photoCaption),
    requestId: randomUUID(), // stable per-confirm comes from draft after /confirm stores it
  });

  if (result.action === 'confirm') {
    await runConfirm(userId, chatId, result.drafts);
  } else if (result.reply) {
    await sendMessage(chatId, result.reply);
  }
}

// ---------------------------------------------------------------------------
// Long polling loop
// ---------------------------------------------------------------------------

async function poll() {
  while (true) {
    try {
      const updates = await tgCall('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (SEEN_UPDATES.has(update.update_id)) continue;
        SEEN_UPDATES.add(update.update_id);
        // Keep set bounded
        if (SEEN_UPDATES.size > 10000) {
          const oldest = [...SEEN_UPDATES].slice(0, 5000);
          oldest.forEach(id => SEEN_UPDATES.delete(id));
        }
        if (update.message) {
          handleMessage(update.message).catch(e => console.error('handleMessage error', e));
        }
      }
    } catch (e) {
      console.error('Poll error', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

console.log('MEEHOA Order Bot starting (staging)...');
console.log(`Allowed users: ${[...ALLOWED_IDS].join(', ')}`);
poll();
