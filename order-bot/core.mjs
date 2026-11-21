/**
 * MEEHOA Order Bot — core state machine (staging only)
 *
 * Draft lifecycle:
 *   pending → confirmed → confirming → submitted
 *                                   ↘ confirmed  (OPS rejected — retryable)
 *
 * Bill images are stored in a separate draftBillRefs[] list inside the draft.
 * They are NEVER passed to createOrder (fullPaidRequested stays false).
 * They exist only for operator reference; actual settlement goes through the
 * normal submitSettlement flow once the order exists in OPS.
 *
 * File-based store with atomic rename:
 *   data/<userId>.json  (private chat only; userId is a Telegram integer ID)
 *
 * Concurrency & durability model (single-process staging):
 *   - Node.js is single-threaded but async interleaving can let two /confirm
 *     messages race. We guard with an in-process per-user promise lock AND
 *     a persistent "confirming" status in the JSON file.
 *   - requestId is generated on first /confirm and kept fixed in the draft,
 *     so any retry (crash, OPS timeout, duplicate message) is idempotent via
 *     mee_ops_lookup.
 *   - Stale "confirming" drafts (process crashed mid-flight) are detected on
 *     startup and surfaced so operators can retry manually.
 *   - Orphaned .tmp.* files left by a crash are removed on startup.
 *   - Multi-replica deployments are NOT supported by this file store. If more
 *     than one process is needed, replace loadDrafts/saveDrafts with an atomic
 *     store (Redis GETSET, Postgres advisory lock, or Supabase row). The
 *     business logic in core.mjs is store-agnostic.
 *
 * Commands: /new /list /select /show /cancel /confirm
 * Field input: "field: value" lines (one field or multiple lines)
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dir, 'data');

// ---------------------------------------------------------------------------
// Draft store (atomic write, single-process staging)
// ---------------------------------------------------------------------------

function draftPath(userId) {
  return join(DATA_DIR, `${userId}.json`);
}

function loadDrafts(userId) {
  try {
    const raw = readFileSync(draftPath(userId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveDrafts(userId, drafts) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = draftPath(userId) + '.tmp.' + randomUUID();
  writeFileSync(tmp, JSON.stringify(drafts, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, draftPath(userId));
}

/**
 * Remove orphaned .tmp.* files left by a crash during a previous saveDrafts.
 * Call once at process startup. Safe to call with an empty DATA_DIR.
 */
export function cleanupOrphanedTmpFiles() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const entries = readdirSync(DATA_DIR);
    let removed = 0;
    for (const name of entries) {
      if (name.includes('.tmp.')) {
        try { unlinkSync(join(DATA_DIR, name)); removed++; } catch { /* already gone */ }
      }
    }
    if (removed) console.log(`[store] Removed ${removed} orphaned tmp file(s) from ${DATA_DIR}`);
  } catch (e) {
    console.warn('[store] cleanupOrphanedTmpFiles failed:', e.message);
  }
}

/**
 * Scan all user JSON files and return drafts stuck in "confirming" status.
 * These are drafts where the process crashed mid-confirm: requestId is known
 * so a retry via /confirm is idempotent (mee_ops_lookup returns the receipt).
 * @returns {Array<{userId:string, draftId:string, draft:object}>}
 */
export function findStaleConfirming() {
  const stale = [];
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const entries = readdirSync(DATA_DIR);
    for (const name of entries) {
      if (!name.endsWith('.json') || name.includes('.tmp.')) continue;
      const userId = name.slice(0, -5);
      try {
        const drafts = loadDrafts(userId);
        for (const [key, draft] of Object.entries(drafts)) {
          if (key.startsWith('_') || !draft?.id) continue;
          if (draft.status === 'confirming') stale.push({ userId, draftId: draft.id, draft });
        }
      } catch { /* skip unreadable file */ }
    }
  } catch { /* DATA_DIR not yet created */ }
  return stale;
}

/**
 * Transition a draft from "confirming" back to "confirmed" after a crash.
 * This is safe because requestId is preserved — the next /confirm attempt
 * will use mee_ops_lookup to discover whether the original OPS call landed.
 */
export function resetStaleConfirming(userId, draftId) {
  const drafts = loadDrafts(userId);
  const draft = drafts[draftId];
  if (!draft || draft.status !== 'confirming') return false;
  const reset = { ...draft, status: 'confirmed', resetAt: new Date().toISOString() };
  saveDrafts(userId, { ...drafts, [draftId]: reset });
  return true;
}

// ---------------------------------------------------------------------------
// Field aliases
// ---------------------------------------------------------------------------

const FIELD_ALIASES = {
  khach: 'customer', 'tên khách': 'customer', 'ten khach': 'customer', customer: 'customer',
  'mẫu hoa': 'flower', 'mau hoa': 'flower', hoa: 'flower', flower: 'flower',
  ngay: 'date', 'ngày nhận': 'date', 'ngay nhan': 'date', date: 'date',
  gio: 'time', 'giờ nhận': 'time', 'gio nhan': 'time', time: 'time',
  'hình thức': 'shipping', 'hinh thuc': 'shipping', ship: 'shipping', shipping: 'shipping',
  'giao hàng': 'shipping', 'giao hang': 'shipping', 'vận chuyển': 'shipping', 'van chuyen': 'shipping',
  'địa chỉ': 'address', 'dia chi': 'address', address: 'address',
  sdt: 'phone', 'số điện thoại': 'phone', phone: 'phone', 'điện thoại': 'phone', 'dien thoai': 'phone',
  'ghi chú': 'note', 'ghi chu': 'note', note: 'note',
  'tổng hoa': 'flowerTotal', 'tong hoa': 'flowerTotal', 'flower total': 'flowerTotal', flowertotal: 'flowerTotal',
  gia: 'flowerTotal', 'giá': 'flowerTotal', 'tiền': 'flowerTotal', 'tien': 'flowerTotal', 'tiền hoa': 'flowerTotal', 'tien hoa': 'flowerTotal',
  sale: 'sale',
  thiep: 'card', card: 'card',
  'nội dung thiệp': 'cardText', 'noi dung thiep': 'cardText', cardtext: 'cardText',
  'sl thiệp': 'cardQty', 'sl thiep': 'cardQty', cardqty: 'cardQty',
  banner: 'banner',
  'nội dung banner': 'bannerText', bannertext: 'bannerText',
  'sl banner': 'bannerQty', bannerqty: 'bannerQty',
  'phí charm': 'charmFee', charmfee: 'charmFee',
  'charm note': 'charmText', charmtext: 'charmText',
  'phí giấy': 'paperFee', paperfee: 'paperFee',
  'paper note': 'paperText', papertext: 'paperText',
  vat: 'vat',
};

function normalizeKey(raw) {
  return raw.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

function resolveField(raw) {
  const k = normalizeKey(raw);
  return FIELD_ALIASES[k] || null;
}

// ---------------------------------------------------------------------------
// Normalization helpers (shipping, money, date, time)
// ---------------------------------------------------------------------------

const SHIPPING_VALUES = ['Shop book ship', 'Khách tự book', 'Ghé lấy'];

function normalizeShipping(raw) {
  const r = raw.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  if (/shop|book ship/.test(r)) return 'Shop book ship';
  if (/khach.*book|tu.*book/.test(r)) return 'Khách tự book';
  if (/ghe.*lay|lay/.test(r)) return 'Ghé lấy';
  return raw.trim();
}

function normalizeMoney(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/[\sđdvn]/gi, '');
  const m = s.match(/^(\d+(?:[.,]\d+)?)(k|tr|trieu)?$/);
  if (m) {
    let num = Number(m[1].replace(',', '.'));
    if (m[2] === 'k') num *= 1000;
    else if (m[2] === 'tr' || m[2] === 'trieu') num *= 1000000;
    if (Number.isFinite(num)) return String(Math.round(num));
  }
  const digitsOnly = s.replace(/[.,]/g, '');
  if (/^\d+$/.test(digitsOnly)) {
    return digitsOnly;
  }
  return String(raw).trim();
}

function normalizeDate(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mon = m[2].padStart(2, '0');
    const y = m[3];
    return `${y}-${mon}-${d}`;
  }
  return s;
}

function normalizeTime(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  const mH = s.match(/^(\d{1,2})h(\d{2})?$/);
  if (mH) {
    const h = mH[1].padStart(2, '0');
    const min = (mH[2] || '00').padStart(2, '0');
    return `${h}:${min}`;
  }
  const mColon = s.match(/^(\d{1,2}):(\d{2})$/);
  if (mColon) {
    return `${mColon[1].padStart(2, '0')}:${mColon[2]}`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Draft display
// ---------------------------------------------------------------------------

export function draftSummary(draft) {
  const f = draft.fields || {};
  const statusBadge = {
    pending: '', confirmed: '✔ Sẵn sàng xác nhận', confirming: '⏳ Đang tạo...', submitted: '✅ Đã tạo OPS',
  }[draft.status] || '';
  const lines = [
    `📋 *Đơn nháp #${draft.id.slice(-6)}*${statusBadge ? '  ' + statusBadge : ''}`,
    `Khách: ${f.customer || '—'}`,
    `Mẫu hoa: ${f.flower || '—'}`,
    `Ngày: ${f.date || '—'}  Giờ: ${f.time || '—'}`,
    `Ship: ${f.shipping || '—'}`,
    f.address ? `Địa chỉ: ${f.address}` : null,
    f.phone ? `SĐT: ${f.phone}` : null,
    f.flowerTotal ? `Tổng hoa: ${Number(f.flowerTotal).toLocaleString('vi')} đ` : null,
    f.note ? `Ghi chú: ${f.note}` : null,
    f.sale ? `Sale: ${f.sale}` : null,
  ].filter(Boolean);

  const sampleCount = (draft.sampleRefs || []).length;
  const billCount = (draft.draftBillRefs || []).length;
  if (sampleCount) lines.push(`📷 Ảnh mẫu: ${sampleCount} ảnh đã lưu`);
  if (billCount) lines.push(`🧾 Ảnh bill (nháp, chưa xác nhận TT): ${billCount} ảnh — sẽ KHÔNG tự động tạo đơn thanh toán`);

  const missing = requiredMissing(draft);
  if (missing.length) lines.push(`\n⚠️ Còn thiếu: ${missing.join(', ')}`);

  return lines.join('\n');
}

function requiredMissing(draft) {
  const f = draft.fields || {};
  const need = [];
  if (!f.customer) need.push('tên khách');
  if (!f.flower) need.push('mẫu hoa');
  if (!f.date) need.push('ngày nhận');
  if (!f.time) need.push('giờ nhận');
  if (!f.shipping) need.push('hình thức ship');
  return need;
}

function isConfirmable(draft) {
  return requiredMissing(draft).length === 0;
}

// ---------------------------------------------------------------------------
// User state helpers
// ---------------------------------------------------------------------------

function newDraftId() {
  return randomUUID();
}

function activeDraft(drafts) {
  const id = drafts.__active;
  return id ? drafts[id] || null : null;
}

// ---------------------------------------------------------------------------
// Command handlers — return { reply, drafts }
// ---------------------------------------------------------------------------

function cmdNew(drafts, _args) {
  const id = newDraftId();
  const draft = { id, fields: {}, sampleRefs: [], draftBillRefs: [], status: 'pending', createdAt: new Date().toISOString() };
  const next = { ...drafts, [id]: draft, __active: id };
  return { reply: `✅ Đã tạo đơn nháp mới #${id.slice(-6)}.\n\nGửi thông tin theo dạng:\n  tên khách: Nguyễn A\n  mẫu hoa: Hoa hồng đỏ\n  ngày nhận: 2026-12-01\n  giờ nhận: 10:00\n  hình thức: Shop book ship`, drafts: next };
}

function cmdList(drafts) {
  const all = Object.entries(drafts).filter(([k]) => k !== '__active' && k !== '__seenUpdates').map(([, v]) => v);
  if (!all.length) return { reply: 'Không có đơn nháp nào. Dùng /new để tạo mới.', drafts };
  const active = drafts.__active;
  const lines = all.map(d => {
    const mark = d.id === active ? '▶ ' : '  ';
    const missing = requiredMissing(d);
    const status = d.status === 'submitted' ? '✅ đã tạo' : d.status === 'confirming' ? '⏳ đang tạo' : missing.length ? `⚠️ thiếu ${missing.length} trường` : '✔ đủ dữ liệu';
    return `${mark}#${d.id.slice(-6)} — ${d.fields.customer || '(chưa có tên)'} — ${status}`;
  });
  return { reply: `📋 Danh sách đơn nháp:\n${lines.join('\n')}\n\nDùng /select <id> để chuyển.`, drafts };
}

function cmdSelect(drafts, args) {
  const shortId = (args || '').trim();
  if (!shortId) return { reply: 'Dùng: /select <6 ký tự cuối ID>', drafts };
  const found = Object.keys(drafts).filter(k => k !== '__active' && k !== '__seenUpdates').find(k => k.endsWith(shortId));
  if (!found) return { reply: `Không tìm thấy đơn #${shortId}. Dùng /list để xem.`, drafts };
  return { reply: `Đang xem đơn #${shortId}.\n\n${draftSummary(drafts[found])}`, drafts: { ...drafts, __active: found } };
}

function cmdShow(drafts) {
  const draft = activeDraft(drafts);
  if (!draft) return { reply: 'Chưa chọn đơn nào. Dùng /new hoặc /list.', drafts };
  return { reply: draftSummary(draft), drafts };
}

function cmdCancel(drafts, _args) {
  const draft = activeDraft(drafts);
  if (!draft) return { reply: 'Chưa có đơn nháp đang chọn.', drafts };
  if (draft.status === 'submitted') return { reply: 'Đơn đã được tạo trong OPS, không thể xóa nháp.', drafts };
  if (draft.status === 'confirming') return { reply: '⏳ Đang tạo đơn trong OPS, không thể xóa. Vui lòng chờ.', drafts };
  const id = draft.id;
  const next = { ...drafts };
  delete next[id];
  if (next.__active === id) delete next.__active;
  return { reply: `🗑 Đã xóa đơn nháp #${id.slice(-6)}.`, drafts: next };
}

function cmdConfirm(drafts, _args) {
  const draft = activeDraft(drafts);
  if (!draft) return { reply: 'Chưa có đơn nháp đang chọn. Dùng /new.', drafts };
  if (draft.status === 'submitted') return { reply: '⚠️ Đơn này đã được tạo trong OPS rồi.', drafts };
  if (draft.status === 'confirming') return { reply: '⏳ Đơn đang được tạo trong OPS, vui lòng chờ.', drafts };
  if (!isConfirmable(draft)) {
    return { reply: `❌ Chưa đủ dữ liệu để xác nhận:\n${draftSummary(draft)}`, drafts };
  }
  // requestId is set once and kept fixed across all retries — idempotency key for mee_ops_lookup.
  const reqId = draft.requestId || randomUUID();
  const confirmed = { ...draft, status: 'confirmed', confirmedAt: draft.confirmedAt || new Date().toISOString(), requestId: reqId };
  return { reply: '__CONFIRM__', drafts: { ...drafts, [draft.id]: confirmed } };
}

// ---------------------------------------------------------------------------
// Field update from text message
// ---------------------------------------------------------------------------

function applyFieldLine(draft, line) {
  const cleanLine = line.replace(/^[-*•]\s*/, '').trim();
  const sep = cleanLine.indexOf(':');
  if (sep < 1) return null;
  const rawKey = cleanLine.slice(0, sep).trim();
  const rawVal = cleanLine.slice(sep + 1).trim();
  const field = resolveField(rawKey);
  if (!field) return null;
  let value = rawVal;
  if (field === 'shipping') value = normalizeShipping(rawVal);
  else if (field === 'flowerTotal' || field === 'charmFee' || field === 'paperFee' || field === 'vat') value = normalizeMoney(rawVal);
  else if (field === 'date') value = normalizeDate(rawVal);
  else if (field === 'time') value = normalizeTime(rawVal);
  return { field, value };
}

function applyFields(draft, text) {
  const lines = text.split('\n');
  const changes = [];
  for (const line of lines) {
    const result = applyFieldLine(draft, line);
    if (result) changes.push(result);
  }
  if (!changes.length) return { draft, changes: [] };
  const newFields = { ...draft.fields };
  for (const { field, value } of changes) newFields[field] = value;
  return { draft: { ...draft, fields: newFields }, changes };
}

// ---------------------------------------------------------------------------
// Bill image handling
// ---------------------------------------------------------------------------

/**
 * Store a Telegram file reference as a draft bill image.
 * We store the file_id only — actual download happens on /confirm
 * or when the operator explicitly exports. The reference is NEVER
 * forwarded to createOrder; it stays in the draft for operator view only.
 */
export function addBillRef(drafts, telegramFileId, caption) {
  const draft = activeDraft(drafts);
  if (!draft) return { ok: false, reply: 'Chưa có đơn nháp đang chọn. Dùng /new trước.' };
  if (draft.status === 'submitted') return { ok: false, reply: 'Đơn đã tạo trong OPS.' };
  if (draft.status === 'confirming') return { ok: false, reply: '⏳ Đơn đang được tạo, không thể thêm ảnh lúc này.' };
  if ((draft.draftBillRefs || []).length >= 10) return { ok: false, reply: '⚠️ Tối đa 10 ảnh bill trong mỗi đơn nháp.' };
  const ref = { fileId: telegramFileId, caption: (caption || '').slice(0, 200), savedAt: new Date().toISOString() };
  const updated = { ...draft, draftBillRefs: [...(draft.draftBillRefs || []), ref] };
  const next = { ...drafts, [draft.id]: updated };
  return {
    ok: true,
    reply: `🧾 Đã lưu ảnh bill vào nháp #${draft.id.slice(-6)} (${updated.draftBillRefs.length} ảnh).\n⚠️ Ảnh bill chỉ lưu trong nháp — KHÔNG tự xác nhận thanh toán. Dùng luồng tất toán trong OPS khi cần.`,
    drafts: next,
  };
}

/**
 * Store a sample image file_id in the draft.
 * On /confirm these get downloaded and uploaded to OPS.
 */
export function addSampleRef(drafts, telegramFileId, caption) {
  const draft = activeDraft(drafts);
  if (!draft) return { ok: false, reply: 'Chưa có đơn nháp đang chọn. Dùng /new trước.' };
  if (draft.status === 'submitted') return { ok: false, reply: 'Đơn đã tạo trong OPS.' };
  if (draft.status === 'confirming') return { ok: false, reply: '⏳ Đơn đang được tạo, không thể thêm ảnh lúc này.' };
  if ((draft.sampleRefs || []).length >= 10) return { ok: false, reply: '⚠️ Tối đa 10 ảnh mẫu trong mỗi đơn nháp.' };
  const ref = { fileId: telegramFileId, caption: (caption || '').slice(0, 200), savedAt: new Date().toISOString() };
  const updated = { ...draft, sampleRefs: [...(draft.sampleRefs || []), ref] };
  const next = { ...drafts, [draft.id]: updated };
  return {
    ok: true,
    reply: `📷 Đã lưu ảnh mẫu vào nháp #${draft.id.slice(-6)} (${updated.sampleRefs.length} ảnh).`,
    drafts: next,
  };
}

// ---------------------------------------------------------------------------
// Persistent status transitions for confirm lifecycle
// ---------------------------------------------------------------------------

/**
 * Transition draft to "confirming" before the OPS network call begins.
 * Persisted immediately so a crash leaves a detectable stale state.
 * run.mjs calls this, then calls markSubmitted or markConfirmFailed.
 */
export function markConfirming(userId, draftId) {
  const drafts = loadDrafts(userId);
  const draft = drafts[draftId];
  if (!draft || draft.status !== 'confirmed') return false;
  const next = { ...drafts, [draftId]: { ...draft, status: 'confirming', confirmingAt: new Date().toISOString() } };
  saveDrafts(userId, next);
  return true;
}

/**
 * Transition draft from "confirming" → "submitted" after a successful OPS call.
 */
export function markSubmitted(drafts, draftId, orderId) {
  const draft = drafts[draftId];
  if (!draft) return drafts;
  return { ...drafts, [draftId]: { ...draft, status: 'submitted', submittedAt: new Date().toISOString(), opsOrderId: orderId } };
}

/**
 * Roll back draft from "confirming" → "confirmed" when OPS definitively rejects.
 * On network errors (unknown outcome) callers should leave "confirming" in place
 * and let the restart recovery handle it via findStaleConfirming().
 */
export function markConfirmFailed(userId, draftId) {
  const drafts = loadDrafts(userId);
  const draft = drafts[draftId];
  if (!draft || draft.status !== 'confirming') return false;
  const next = { ...drafts, [draftId]: { ...draft, status: 'confirmed', failedAt: new Date().toISOString() } };
  saveDrafts(userId, next);
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Handle an incoming update from run.mjs.
 *
 * @param {object} opts
 * @param {number}  opts.userId      — Telegram user ID (integer)
 * @param {string}  opts.text        — message text (may be empty)
 * @param {string|null} opts.photoFileId — largest photo file_id if present
 * @param {string|null} opts.photoCaption — caption of photo
 * @param {boolean} opts.isBillHint  — caller detected this photo as a bill (caption contains "bill"/"hóa đơn")
 * @param {string}  opts.requestId   — stable idempotency key for this confirm attempt
 *
 * @returns {{ reply: string, drafts: object, action: string|null }}
 *   action may be 'confirm' — caller should proceed to call OPS createOrder
 */
export function handleUpdate(opts) {
  const { userId, text, photoFileId, photoCaption, isBillHint, requestId } = opts;
  let drafts = loadDrafts(userId);

  // Photo first
  if (photoFileId) {
    if (isBillHint) {
      const result = addBillRef(drafts, photoFileId, photoCaption);
      if (result.ok) saveDrafts(userId, result.drafts);
      return { reply: result.reply, drafts: result.drafts, action: null };
    } else {
      const result = addSampleRef(drafts, photoFileId, photoCaption);
      if (result.ok) saveDrafts(userId, result.drafts);
      return { reply: result.reply, drafts: result.drafts, action: null };
    }
  }

  const trimmed = (text || '').trim();
  if (!trimmed) return { reply: null, drafts, action: null };

  // Commands
  if (trimmed.startsWith('/')) {
    const space = trimmed.indexOf(' ');
    const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    const args = space === -1 ? '' : trimmed.slice(space + 1);
    let result;
    switch (cmd) {
      case '/new': result = cmdNew(drafts, args); break;
      case '/list': result = cmdList(drafts); break;
      case '/select': result = cmdSelect(drafts, args); break;
      case '/show': result = cmdShow(drafts); break;
      case '/cancel': result = cmdCancel(drafts, args); break;
  case '/confirm': result = cmdConfirm(drafts, args); break;
      default: return { reply: `Lệnh không nhận ra. Dùng /new /list /select /show /cancel /confirm`, drafts, action: null };
    }
    saveDrafts(userId, result.drafts);
    if (result.reply === '__CONFIRM__') {
      return { reply: null, drafts: result.drafts, action: 'confirm' };
    }
    return { reply: result.reply, drafts: result.drafts, action: null };
  }

  // Field update
  const draft = activeDraft(drafts);
  if (!draft) {
    return { reply: 'Dùng /new để tạo đơn nháp trước.', drafts, action: null };
  }
  if (draft.status === 'submitted') {
    return { reply: 'Đơn đã tạo trong OPS. Dùng /new để tạo đơn mới.', drafts, action: null };
  }
  if (draft.status === 'confirming') {
    return { reply: '⏳ Đơn đang được tạo trong OPS, vui lòng chờ.', drafts, action: null };
  }

  const { draft: updated, changes } = applyFields(draft, trimmed);
  if (!changes.length) {
    return { reply: `Không nhận ra trường nào. Dùng dạng:\n  tên khách: Nguyễn A\nhoặc gõ /show để xem đơn.`, drafts, action: null };
  }
  const next = { ...drafts, [draft.id]: updated };
  saveDrafts(userId, next);
  const changed = changes.map(c => `  ${c.field}: ${c.value}`).join('\n');
  const still = requiredMissing(updated);
  const extra = still.length ? `\n⚠️ Còn thiếu: ${still.join(', ')}` : '\n✅ Đã đủ dữ liệu — dùng /confirm để tạo đơn.';
  return { reply: `✏️ Đã cập nhật:\n${changed}${extra}`, drafts: next, action: null };
}

export {
  loadDrafts, saveDrafts, activeDraft, requiredMissing, isConfirmable,
  normalizeShipping, normalizeMoney, normalizeDate, normalizeTime,
};