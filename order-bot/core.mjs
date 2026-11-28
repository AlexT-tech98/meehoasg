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
  ten: 'customer', 'tên': 'customer',
  'mẫu hoa': 'flower', 'mau hoa': 'flower', hoa: 'flower', flower: 'flower',
  'mẫu': 'flower', mau: 'flower',
  ngay: 'date', 'ngày nhận': 'date', 'ngay nhan': 'date', date: 'date',
  gio: 'time', 'giờ nhận': 'time', 'gio nhan': 'time', time: 'time',
  'hình thức': 'shipping', 'hinh thuc': 'shipping', ship: 'shipping', shipping: 'shipping',
  'giao hàng': 'shipping', 'giao hang': 'shipping', 'vận chuyển': 'shipping', 'van chuyen': 'shipping',
  'địa chỉ': 'address', 'dia chi': 'address', address: 'address',
  'địa chỉ nhận': 'address', 'dia chi nhan': 'address',
  'địa chỉ giao': 'address', 'dia chi giao': 'address',
  'địa chỉ giao hàng': 'address', 'dia chi giao hang': 'address',
  dc: 'address', 'd/c': 'address',
  sdt: 'phone', 'số điện thoại': 'phone', phone: 'phone', 'điện thoại': 'phone', 'dien thoai': 'phone',
  'ghi chú': 'note', 'ghi chu': 'note', note: 'note',
  'note đơn': 'note', 'note don': 'note', 'note khách': 'note', 'note khach': 'note',
  'lưu ý': 'note', 'luu y': 'note',
  'lưu ý khách': 'note', 'luu y khach': 'note',
  'lưu ý của khách': 'note', 'luu y cua khach': 'note',
  'lưu ý khách hàng': 'note', 'luu y khach hang': 'note',
  'lưu ý đơn': 'note', 'luu y don': 'note',
  'lưu ý đơn hàng': 'note', 'luu y don hang': 'note',
  'lưu ý giao': 'note', 'luu y giao': 'note',
  'lưu ý bó hoa': 'note', 'luu y bo hoa': 'note',
  'khách dặn': 'note', 'khach dan': 'note',
  'dặn dò': 'note', 'dan do': 'note', 'lời dặn': 'note', 'loi dan': 'note',
  'yêu cầu': 'note', 'yeu cau': 'note', 'yêu cầu khách': 'note', 'yeu cau khach': 'note',
  'tag note free': 'tagNoteFree', 'tag note': 'tagNoteFree', tagnotefree: 'tagNoteFree', tagnote: 'tagNoteFree',
  'tag free': 'tagNoteFree', 'tag miễn phí': 'tagNoteFree', 'tag mien phi': 'tagNoteFree',
  'nội dung tag': 'tagNoteFree', 'noi dung tag': 'tagNoteFree', tag: 'tagNoteFree',
  'tổng hoa': 'flowerTotal', 'tong hoa': 'flowerTotal', 'flower total': 'flowerTotal', flowertotal: 'flowerTotal',
  tong: 'flowerTotal', 'tổng': 'flowerTotal', 'tong don': 'flowerTotal', 'tong tien hoa': 'flowerTotal',
  gia: 'flowerTotal', 'giá': 'flowerTotal', 'tiền': 'flowerTotal', 'tien': 'flowerTotal', 'tiền hoa': 'flowerTotal', 'tien hoa': 'flowerTotal', 'tổng tiền': 'flowerTotal', 'tong tien': 'flowerTotal',
  'phí ship': 'shipFee', 'phi ship': 'shipFee', shipfee: 'shipFee', 'tiền ship': 'shipFee', 'tien ship': 'shipFee',
  'thanh toán khách báo': 'paymentInfo', 'thanh toan khach bao': 'paymentInfo',
  'tiền cọc': 'depositAmount', 'tien coc': 'depositAmount', cọc: 'depositAmount', coc: 'depositAmount',
  sale: 'sale',
  thiep: 'card', card: 'card',
  'nội dung thiệp': 'cardText', 'noi dung thiep': 'cardText', cardtext: 'cardText',
  'sl thiệp': 'cardQty', 'sl thiep': 'cardQty', cardqty: 'cardQty',
  banner: 'banner',
  'nội dung banner': 'bannerText', 'noi dung banner': 'bannerText', bannertext: 'bannerText',
  'sl banner': 'bannerQty', bannerqty: 'bannerQty',
  'phí charm': 'charmFee', 'phi charm': 'charmFee', charmfee: 'charmFee',
  'charm note': 'charmText', charmtext: 'charmText',
  'phí giấy': 'paperFee', 'phi giay': 'paperFee', paperfee: 'paperFee',
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
  if (/shop\s*(?:book|ship|giao)|book\s*ship|giao\s*tan\s*noi|ship\s*tan\s*nha|cho\s*nguoi\s*giao/.test(r)) return 'Shop book ship';
  if (/khach.*book|tu.*book|aha|grab/.test(r)) return 'Khách tự book';
  if (/ghe.*lay|tai\s*shop|nhan\s*tai\s*shop|tai\s*tiem|nhan\s*tai\s*tiem|tu\s*(?:qua\s*)?lay|lay/.test(r)) return 'Ghé lấy';
  if (/shop/.test(r)) return 'Shop book ship';
  return raw.trim();
}

function normalizeMoney(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/[\sđdvn]/gi, '');

  // 1tr2, 1tr5, 2tr
  const mTr = s.match(/^(\d+)(?:tr|trieu)(\d+)?$/);
  if (mTr) {
    let intPart = Number(mTr[1]) * 1000000;
    if (mTr[2]) {
      let decStr = mTr[2];
      if (decStr.length === 1) intPart += Number(decStr) * 100000;
      else if (decStr.length === 2) intPart += Number(decStr) * 10000;
      else intPart += Number(decStr);
    }
    return String(intPart);
  }

  // Decimal with k/tr: e.g. 1.2tr, 1,5tr, 1.5k, 850k
  const mUnit = s.match(/^(\d+(?:[.,]\d+)?)(k|tr|trieu)$/);
  if (mUnit) {
    let num = Number(mUnit[1].replace(',', '.'));
    if (mUnit[2] === 'k') num *= 1000;
    else if (mUnit[2] === 'tr' || mUnit[2] === 'trieu') num *= 1000000;
    if (Number.isFinite(num)) return String(Math.round(num));
  }

  // Thousands separators: 850.000 or 850,000 or 1.200.000
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) {
    return s.replace(/[.,]/g, '');
  }

  const digitsOnly = s.replace(/[.,]/g, '');
  if (/^\d+$/.test(digitsOnly)) {
    return digitsOnly;
  }
  return String(raw).trim();
}

export function parseSmartTime(raw) {
  if (!raw) return { value: '', isUncertain: false };
  const s = String(raw).trim().toLowerCase();
  const n = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

  const isChieu = /chieu|toi/.test(n);

  const mColon = s.match(/(?:tam|khoang|luc|tam\s*khoang)?\s*(\d{1,2}):(\d{2})/i);
  if (mColon) {
    let h = parseInt(mColon[1], 10);
    const m = mColon[2];
    if (isChieu && h < 12) h += 12;
    if (h >= 0 && h <= 23 && parseInt(m, 10) >= 0 && parseInt(m, 10) <= 59) {
      return { value: `${String(h).padStart(2, '0')}:${m}`, isUncertain: false };
    }
  }

  const mH = s.match(/(?:tam|khoang|luc)?\s*(\d{1,2})h(\d{2})?/i);
  if (mH) {
    let h = parseInt(mH[1], 10);
    const m = (mH[2] || '00').padStart(2, '0');
    if (isChieu && h < 12) h += 12;
    if (h >= 0 && h <= 23 && parseInt(m, 10) >= 0 && parseInt(m, 10) <= 59) {
      return { value: `${String(h).padStart(2, '0')}:${m}`, isUncertain: false };
    }
  }

  return { value: raw.trim(), isUncertain: true, reason: `Giờ nhận "${raw}" chưa đúng định dạng (ví dụ: 15:00, 21h, 9h30, 3h chiều)` };
}

export function parseSmartDate(raw, referenceDate = new Date()) {
  if (!raw) return { value: '', isUncertain: false };
  const s = String(raw).trim();
  const n = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

  const ref = new Date(referenceDate);
  const refYear = ref.getFullYear() || 2026;

  const mIso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mIso) {
    const y = mIso[1];
    const m = mIso[2];
    const d = mIso[3];
    const cand = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    const diffDays = (cand.getTime() - ref.getTime()) / (24 * 60 * 60 * 1000);
    if (diffDays < -1) {
      return {
        value: s,
        isUncertain: true,
        reason: `Ngày ${d}/${m}/${y} đã qua so với ngày hiện tại (${ref.getDate()}/${ref.getMonth() + 1}/${refYear}). Vui lòng xác nhận lại.`
      };
    }
    return { value: s, isUncertain: false };
  }

  const mFull = s.match(/(?:ngay\s*)?(\d{1,2})[/-](\d{1,2})[/-](\d{4})/i);
  if (mFull) {
    const d = mFull[1].padStart(2, '0');
    const m = mFull[2].padStart(2, '0');
    const y = mFull[3];
    const cand = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    const diffDays = (cand.getTime() - ref.getTime()) / (24 * 60 * 60 * 1000);
    if (diffDays < -1) {
      return {
        value: `${y}-${m}-${d}`,
        isUncertain: true,
        reason: `Ngày ${d}/${m}/${y} đã qua so với ngày hiện tại (${ref.getDate()}/${ref.getMonth() + 1}/${refYear}). Vui lòng xác nhận lại.`
      };
    }
    return { value: `${y}-${m}-${d}`, isUncertain: false };
  }

  const mShort = s.match(/(?:ngay\s*)?(\d{1,2})(?:[/-]|\s*thang\s*)(\d{1,2})/i);
  if (mShort) {
    const dStr = mShort[1].padStart(2, '0');
    const mStr = mShort[2].padStart(2, '0');
    let targetYear = refYear;
    const cand = new Date(Date.UTC(targetYear, Number(mStr) - 1, Number(dStr)));
    const diffDays = (cand.getTime() - ref.getTime()) / (24 * 60 * 60 * 1000);

    if (diffDays < -30) {
      targetYear += 1;
    } else if (diffDays < -1) {
      return {
        value: `${targetYear}-${mStr}-${dStr}`,
        isUncertain: true,
        reason: `Ngày ${dStr}/${mStr}/${targetYear} đã qua so với ngày hiện tại (${ref.getDate()}/${ref.getMonth() + 1}/${refYear}). Vui lòng xác nhận lại.`
      };
    }
    return { value: `${targetYear}-${mStr}-${dStr}`, isUncertain: false };
  }

  if (/\b(hom nay|nay)\b/.test(n)) {
    const y = ref.getFullYear();
    const m = String(ref.getMonth() + 1).padStart(2, '0');
    const d = String(ref.getDate()).padStart(2, '0');
    return { value: `${y}-${m}-${d}`, isUncertain: false };
  }
  if (/\b(ngay\s*mai|chieu\s*mai|sang\s*mai|trua\s*mai|toi\s*mai|giao\s*mai|lay\s*mai|nhan\s*mai)\b/.test(n) || /^mai(?:\b|$)/.test(n)) {
    const tomorrow = new Date(ref.getTime() + 24 * 60 * 60 * 1000);
    const y = tomorrow.getFullYear();
    const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const d = String(tomorrow.getDate()).padStart(2, '0');
    return { value: `${y}-${m}-${d}`, isUncertain: false };
  }

  return { value: s, isUncertain: true, reason: `Ngày nhận "${raw}" không rõ định dạng (ví dụ: 25/11/2026, 22/11, ngày mai)` };
}

function normalizeDate(raw) {
  const parsed = parseSmartDate(raw);
  return parsed.value || raw;
}

function normalizeTime(raw) {
  const parsed = parseSmartTime(raw);
  return parsed.value || raw;
}

const MONEY_TOKEN_SOURCE = '(?:\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:tr|trieu)\\d+|\\d+(?:[.,]\\d+)?\\s*(?:k|tr|trieu)|\\d{5,9})';

export function parsePaymentInfo(text, existingFlowerTotal = 0) {
  const normText = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

  // Helper: extract explicit total amount if stated on the same line (e.g. "Tổng 350k cọc 200k", "Giá 500k cọc 200k")
  const explicitTotalMatch = normText.match(
    new RegExp(`(?:tong(?:\\s*(?:tien|don|hoa))?|gia(?:\\s*hoa)?|tien\\s*hoa)\\s*[:=-]?\\s*(${MONEY_TOKEN_SOURCE})`, 'i')
  );
  const leadingTotalBeforeDeposit = normText.match(
    new RegExp(`^(${MONEY_TOKEN_SOURCE})\\s*(?:[-,/|+;]|\\s)+\\s*(?:da\\s*)?(?:coc|chuyen\\s*truoc|ck\\s*truoc)\\b`, 'i')
  );
  const rawTotalToken = explicitTotalMatch?.[1] || leadingTotalBeforeDeposit?.[1] || null;
  const parsedTotal = rawTotalToken ? Number(normalizeMoney(rawTotalToken)) : null;
  const validExplicitTotal = parsedTotal && Number.isFinite(parsedTotal) && parsedTotal >= 10000 ? parsedTotal : null;

  // 1. Fullpaid
  if (/\b(fullpaid|full\s*paid|thanh\s*toan\s*(?:het|du|toan\s*bo)|tt\s*het|ck\s*het)\b/.test(normText)) {
    const mAmount = normText.match(new RegExp(`(?:fullpaid|full\\s*paid|thanh\\s*toan\\s*(?:het|du|toan\\s*bo)|tt\\s*het|ck\\s*het)\\s*[:=-]?\\s*(${MONEY_TOKEN_SOURCE})`, 'i'));
    const amount = mAmount ? normalizeMoney(mAmount[1]) : (validExplicitTotal ? String(validExplicitTotal) : (existingFlowerTotal ? String(existingFlowerTotal) : null));
    return {
      paymentState: 'fullpaid',
      flowerTotal: amount ? Number(amount) : null,
      reportedPaidAmount: amount ? Number(amount) : null,
      billRequired: true,
      text: 'Fullpaid (khách báo đã thanh toán toàn bộ đơn)'
    };
  }

  // 2. Bankfull
  if (/\b(bankfull|bank\s*full|bank\s*(?:du|full)\s*tien\s*hoa)\b/.test(normText)) {
    const mAmount = normText.match(new RegExp(`(?:bankfull|bank\\s*full|bank\\s*(?:du|full)\\s*tien\\s*hoa)\\s*[:=-]?\\s*(${MONEY_TOKEN_SOURCE})`, 'i'));
    const amount = mAmount ? normalizeMoney(mAmount[1]) : (validExplicitTotal ? String(validExplicitTotal) : (existingFlowerTotal ? String(existingFlowerTotal) : null));
    return {
      paymentState: 'bankfull',
      flowerTotal: amount ? Number(amount) : null,
      reportedPaidAmount: amount ? Number(amount) : null,
      billRequired: false,
      text: 'Bankfull (khách báo đã thanh toán đủ tiền hoa)'
    };
  }

  // 3. Deposit
  if (/\b(coc|cọc|chuyen\s*truoc|ck\s*truoc|thanh\s*toan\s*1\s*phan|thanh\s*toan\s*mot\s*phan|da\s*chuyen\s*mot\s*phan)\b/.test(normText)) {
    const mAmount = normText.match(new RegExp(`(?:coc|cọc|chuyen\\s*truoc|ck\\s*truoc|thanh\\s*toan\\s*1\\s*phan|thanh\\s*toan\\s*mot\\s*phan|da\\s*chuyen\\s*mot\\s*phan)\\s*[:=-]?\\s*(${MONEY_TOKEN_SOURCE})`, 'i'));
    if (mAmount) {
      const depositAmount = Number(normalizeMoney(mAmount[1]));
      return {
        paymentState: 'deposit',
        ...(validExplicitTotal ? { flowerTotal: validExplicitTotal } : {}),
        depositAmount: depositAmount,
        reportedPaidAmount: depositAmount,
        billRequired: false,
        text: `Đã cọc ${depositAmount.toLocaleString('vi')} đ`
      };
    } else {
      return {
        paymentState: 'deposit',
        ...(validExplicitTotal ? { flowerTotal: validExplicitTotal } : {}),
        depositAmount: null,
        reportedPaidAmount: null,
        isUncertain: true,
        reason: 'Đã ghi nhận trạng thái cọc nhưng chưa rõ số tiền cọc. Vui lòng bổ sung số tiền cọc.',
        billRequired: false,
        text: 'Đã cọc (chưa có số tiền)'
      };
    }
  }

  // 4. Unpaid
  if (/\b(chua\s*thanh\s*toan|chua\s*tt|chua\s*ck|thu\s*cod|cod)\b/.test(normText)) {
    return {
      paymentState: 'unpaid',
      ...(validExplicitTotal ? { flowerTotal: validExplicitTotal } : {}),
      reportedPaidAmount: 0,
      depositAmount: 0,
      billRequired: false,
      text: 'Chưa thanh toán'
    };
  }

  return null;
}

/**
 * Strip any legacy "[Khách báo: ...]" tag from an order note.
 */
export function stripPaymentClaimTags(note) {
  return String(note || '')
    .replace(/\s*\[Khách báo:[^\]]*\]/gi, '')
    .trim();
}

/**
 * Compute expected order total from draft fields (flower + accessories + VAT + confirmed ship).
 */
export const DEFAULT_BOT_SALE = 'cmui';
export const DEFAULT_BOT_SALE_NAME = 'C Mụi';

export const DEFAULT_OPS_ORDER_RULES = {
  schemaVersion: '2026-11-26.v3',
  saleDefault: DEFAULT_BOT_SALE,
  saleDefaultName: DEFAULT_BOT_SALE_NAME,
  required: ['customer', 'flower', 'date', 'time', 'shipping', 'flowerTotal'],
  requireFlowerTotal: true,
  minFlowerTotal: 1,
  minDepositRatio: 0.5,
  depositBase: 'flowerTotal',
  conditionalRequired: [],
  conditionalReminders: [
    { field: 'address', when: { field: 'shipping', equals: 'Shop book ship' }, rejectPending: true }
  ],
  accessoryPrices: {
    cardUnitFee: 10000,
    bannerUnitFee: 35000
  },
  enums: {
    shipping: ['Shop book ship', 'Khách tự book', 'Ghé lấy'],
    statuses: ['Chờ bó', 'Đã bó', 'Đã giao']
  },
  supportedRuleFeatures: [
    'required_fields',
    'conditional_required',
    'conditional_reminders',
    'accessory_unit_pricing',
    'min_deposit_ratio',
    'flower_total_required',
    'shipping_enum',
    'sale_default'
  ]
};

const FIELD_LABELS_VI = {
  customer: 'tên khách',
  phone: 'số điện thoại',
  flower: 'mẫu hoa',
  flowerTotal: 'tiền hoa',
  date: 'ngày nhận',
  time: 'giờ nhận',
  shipping: 'hình thức ship',
  address: 'địa chỉ giao hàng',
  note: 'ghi chú',
  tagNoteFree: 'tag note free',
  sale: 'sale phụ trách',
  sampleRefs: 'ảnh mẫu hoa',
  draftBillRefs: 'ảnh bill thanh toán'
};

export const SUPPORTED_BOT_FIELDS = new Set(Object.keys(FIELD_LABELS_VI));
export const SUPPORTED_BOT_RULE_FEATURES = new Set(DEFAULT_OPS_ORDER_RULES.supportedRuleFeatures);

export function formatSaleDisplay(saleValue, rules = DEFAULT_OPS_ORDER_RULES) {
  const raw = String(saleValue || rules?.saleDefault || DEFAULT_BOT_SALE).trim();
  if (!raw || raw.toLowerCase() === 'cmui' || raw.toLowerCase() === 'c mụi' || raw.toLowerCase() === 'c mui') {
    const defUser = rules?.saleDefault || DEFAULT_BOT_SALE;
    const defName = rules?.saleDefaultName || DEFAULT_BOT_SALE_NAME;
    return `${defName} (${defUser})`;
  }
  return raw;
}

export function computeDraftTotal(fields = {}) {
  const f = fields || {};
  const flowerTotal = Number(f.flowerTotal) || 0;
  const cardFee = f.card ? Math.max(1, Number(f.cardQty) || 1) * 10000 : 0;
  const bannerFee = f.banner ? Math.max(1, Number(f.bannerQty) || 1) * 35000 : 0;
  const charmFee = Number(f.charmFee) || 0;
  const paperFee = Number(f.paperFee) || 0;
  const vat = Number(f.vat) || 0;
  const shipFee = (f.shipping === 'Shop book ship' && Number(f.shipFee) > 0) ? Number(f.shipFee) : 0;
  return flowerTotal + cardFee + bannerFee + charmFee + paperFee + vat + shipFee;
}

/**
 * Owner-verified payment claim note helper.
 * Under the confirmed owner-verification rule, payment state is recorded directly
 * in OPS `orders.payment` rather than relegated to a "Khách báo" note tag.
 */
export function formatPaymentClaimNote(_fields = {}) {
  return '';
}

/**
 * Map order-bot payment state to OPS canonical payment string.
 *
 * Confirmed Business Rule:
 *   Every message accepted by the bot comes from the verified owner (`ALLOWED_USER_IDS`).
 *   - unpaid   -> 'Chưa thanh toán'
 *   - deposit  -> 'Đã cọc <amount> đ' (verified deposit; OPS computes paid = deposit, debt = total - deposit)
 *   - bankfull -> 'Đã thanh toán đủ tiền hoa (Full)' (verified flower paid; debt = accessories + vat + ship)
 *   - fullpaid -> 'Đã thanh toán toàn bộ đơn' ONLY when `options.fullPaidRequested === true` (verified sample + bill
 *                 + confirmed shipFee if Shop book ship); otherwise fail-closed 'Chưa thanh toán'.
 */
export function mapPaymentToOps(paymentState, depositAmount, _flowerTotal, options = {}) {
  if (paymentState === 'fullpaid' && options?.fullPaidRequested === true) {
    return 'Đã thanh toán toàn bộ đơn';
  }
  if (paymentState === 'deposit' && Number(depositAmount) > 0) {
    const depStr = Number(depositAmount).toLocaleString('vi-VN');
    return `Đã cọc ${depStr} đ`;
  }
  if (paymentState === 'bankfull') {
    return 'Đã thanh toán đủ tiền hoa (Full)';
  }
  return 'Chưa thanh toán';
}

// ---------------------------------------------------------------------------
// Draft display
// ---------------------------------------------------------------------------

export function formatDateVNDisplay(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '—');
}

export function draftSummary(draft, rules = DEFAULT_OPS_ORDER_RULES) {
  const f = draft.fields || {};
  const statusBadge = {
    pending: '',
    confirmed: 'Sẵn sàng',
    confirming: 'Đang tạo đơn...',
    submitted: 'Đã tạo OPS',
  }[draft.status] || '';

  const shortId = (draft.id || '').slice(-6);
  const saleDisplay = formatSaleDisplay(f.sale, rules);
  const headerParts = [`ĐƠN NHÁP #${shortId}`, saleDisplay];
  if (statusBadge) headerParts.push(statusBadge);

  const customerLine = f.phone
    ? `${f.customer || '—'} · ${f.phone}`
    : (f.customer || '—');

  const deliveryParts = [
    f.time || '—',
    formatDateVNDisplay(f.date),
    f.shipping || '—'
  ];

  const lines = [
    headerParts.join(' · '),
    `Khách: ${customerLine}`,
    `Mẫu hoa: ${f.flower || '—'}`,
    `Nhận: ${deliveryParts.join(' · ')}`,
  ];

  if (f.address) {
    const pendingTag = isPendingAddress(f.address) ? ' (chờ bổ sung)' : '';
    lines.push(`Địa chỉ: ${f.address}${pendingTag}`);
  } else if (f.shipping === 'Shop book ship') {
    lines.push(`Địa chỉ: chưa có địa chỉ`);
  }

  lines.push(
    f.flowerTotal
      ? `Tiền hoa: ${Number(f.flowerTotal).toLocaleString('vi')} đ`
      : `Tiền hoa: — (bắt buộc)`
  );

  const pState = f.paymentState || 'unpaid';
  const billCount = (draft.draftBillRefs || []).length;
  if (pState === 'deposit') {
    const depStr = f.depositAmount ? `${Number(f.depositAmount).toLocaleString('vi')} đ` : '(chưa có số tiền)';
    const totalDue = computeDraftTotal(f);
    const remStr = (totalDue > 0 && f.depositAmount)
      ? ` · còn lại: ${(Math.max(0, totalDue - Number(f.depositAmount))).toLocaleString('vi')} đ`
      : '';
    lines.push(`Thanh toán: Đã cọc ${depStr}${remStr}`);
  } else if (pState === 'bankfull') {
    const bfAmount = f.reportedPaidAmount || f.flowerTotal;
    const bfStr = bfAmount ? ` (${Number(bfAmount).toLocaleString('vi')} đ)` : '';
    lines.push(`Thanh toán: Đã thanh toán đủ tiền hoa (Full)${bfStr}`);
  } else if (pState === 'fullpaid') {
    const totalDue = computeDraftTotal(f);
    const fpAmt = totalDue > 0 ? ` (${totalDue.toLocaleString('vi')} đ)` : '';
    lines.push(
      billCount > 0
        ? `Thanh toán: Full Paid${fpAmt}`
        : `Thanh toán: Full Paid${fpAmt} — cần gửi ảnh bill`
    );
  } else {
    lines.push(`Thanh toán: Chưa thanh toán`);
  }

  if (f.tagNoteFree) lines.push(`Tag note free: ${f.tagNoteFree}`);
  if (f.note) lines.push(`Ghi chú: ${f.note}`);

  const cQty = Math.max(1, Number(f.cardQty) || 1);
  const bQty = Math.max(1, Number(f.bannerQty) || 1);
  if (f.card || f.cardText) lines.push(`Thiệp (${cQty}): ${f.cardText || '(chưa ghi nội dung)'} (+${(cQty * 10000).toLocaleString('vi')} đ)`);
  if (f.banner || f.bannerText) lines.push(`Banner (${bQty}): ${f.bannerText || '(chưa ghi nội dung)'} (+${(bQty * 35000).toLocaleString('vi')} đ)`);
  if (f.charmFee) lines.push(`Phí charm: ${Number(f.charmFee).toLocaleString('vi')} đ${f.charmText ? ' (' + f.charmText + ')' : ''}`);
  if (f.paperFee) lines.push(`Phí giấy: ${Number(f.paperFee).toLocaleString('vi')} đ${f.paperText ? ' (' + f.paperText + ')' : ''}`);
  if (f.vat) lines.push(`VAT: ${Number(f.vat).toLocaleString('vi')} đ`);
  if (Number(f.shipFee) > 0) lines.push(`Phí ship: ${Number(f.shipFee).toLocaleString('vi')} đ`);

  const totalDuePreview = computeDraftTotal(f);
  if (f.flowerTotal && totalDuePreview > Number(f.flowerTotal)) {
    lines.push(`Tổng đơn: ${totalDuePreview.toLocaleString('vi')} đ`);
  }

  const sampleCount = (draft.sampleRefs || []).length;
  const mediaParts = [];
  if (sampleCount) mediaParts.push(`Ảnh mẫu: ${sampleCount} ảnh`);
  if (billCount) {
    mediaParts.push(
      pState === 'fullpaid'
        ? `Ảnh bill: ${billCount} ảnh`
        : `Ảnh bill: ${billCount} ảnh (chỉ lưu nháp, KHÔNG tự xác nhận thanh toán)`
    );
  } else if (pState === 'fullpaid') {
    mediaParts.push(`Ảnh bill: chưa có`);
  }
  if (mediaParts.length) lines.push(mediaParts.join(' · '));

  const validation = validateOrderAgainstRules(draft, rules);
  const footers = [];
  if (validation.unsupportedRules.length) {
    footers.push(`⚠️ OPS có quy tắc mới bot chưa hỗ trợ (${validation.unsupportedRules.join(', ')}). Nháp vẫn được giữ nguyên.`);
  }
  if (validation.missing.length) {
    footers.push(`⚠️ Còn thiếu: ${validation.missing.join(', ')}`);
  }
  if (validation.reminders?.length) {
    footers.push(`Nhắc bổ sung: ${validation.reminders.join(', ')}`);
  }
  if (validation.ruleErrors.length) {
    footers.push(`⚠️ Quy tắc OPS: ${validation.ruleErrors.join(' | ')}`);
  }

  const uncertain = Object.entries(draft.uncertainFields || {});
  if (uncertain.length) {
    footers.push(`Cần làm rõ: ${uncertain.map(([k, reason]) => `${k}: ${reason}`).join('; ')}`);
  }

  if (draft.status === 'submitted' && draft.opsOrderId) {
    footers.push(`✅ Đã tạo OPS: ${draft.opsOrderId}`);
  }

  if (footers.length) {
    lines.push('');
    lines.push(...footers);
  }

  return lines.filter(l => l !== null && l !== undefined).join('\n');
}

function isPendingAddress(addr) {
  if (!addr) return true;
  const norm = String(addr).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
  return /^(?:dia\s*chi\s*)?(?:bsung|bo\s*sung|bao|gui)\s*sau$|^chua\s*co(?:\s*dia\s*chi)?$|^(?:bao|gui)\s*dia\s*chi\s*sau$/i.test(norm);
}

export function validateOrderAgainstRules(draft, rules = DEFAULT_OPS_ORDER_RULES) {
  const effectiveRules = rules || DEFAULT_OPS_ORDER_RULES;
  const f = draft?.fields || {};
  const missing = [];
  const reminders = [];
  const ruleErrors = [];
  const unsupportedRules = [];

  for (const feat of effectiveRules.supportedRuleFeatures || []) {
    if (!SUPPORTED_BOT_RULE_FEATURES.has(feat)) {
      unsupportedRules.push(feat);
    }
  }

  const pushMissing = label => {
    if (label && !missing.includes(label)) missing.push(label);
  };

  const hasFieldValue = (field, rejectPending = false) => {
    if (field === 'sampleRefs') return Array.isArray(draft?.sampleRefs) && draft.sampleRefs.length > 0;
    if (field === 'draftBillRefs') return Array.isArray(draft?.draftBillRefs) && draft.draftBillRefs.length > 0;
    if (field === 'flowerTotal') {
      const minFlower = Number(effectiveRules.minFlowerTotal ?? 1);
      return Boolean(f.flowerTotal) && Number(f.flowerTotal) >= minFlower;
    }
    if (field === 'sale') return Boolean(String(f.sale || effectiveRules.saleDefault || DEFAULT_BOT_SALE).trim());
    const val = f[field];
    if (val === undefined || val === null || String(val).trim() === '') return false;
    if (field === 'address' && rejectPending && isPendingAddress(val)) return false;
    return true;
  };

  for (const field of effectiveRules.required || DEFAULT_OPS_ORDER_RULES.required) {
    if (!SUPPORTED_BOT_FIELDS.has(field)) {
      unsupportedRules.push(`required:${field}`);
      continue;
    }
    if (!hasFieldValue(field, true)) {
      pushMissing(FIELD_LABELS_VI[field] || field);
    }
  }

  // Fallback safeguard: flowerTotal is strictly mandatory (never defaults to 0)
  if (effectiveRules.requireFlowerTotal !== false && !hasFieldValue('flowerTotal')) {
    pushMissing(FIELD_LABELS_VI.flowerTotal);
  }

  for (const cond of effectiveRules.conditionalRequired || []) {
    const condField = cond?.field;
    const whenField = cond?.when?.field;
    const whenEquals = cond?.when?.equals;
    if (!condField || !whenField) continue;
    if (!SUPPORTED_BOT_FIELDS.has(condField) || !SUPPORTED_BOT_FIELDS.has(whenField)) {
      unsupportedRules.push(`conditional:${condField}`);
      continue;
    }
    if (String(f[whenField] || '') === String(whenEquals || '')) {
      if (!hasFieldValue(condField, Boolean(cond.rejectPending))) {
        pushMissing(FIELD_LABELS_VI[condField] || condField);
      }
    }
  }

  for (const rem of effectiveRules.conditionalReminders || []) {
    const remField = rem?.field;
    const whenField = rem?.when?.field;
    const whenEquals = rem?.when?.equals;
    if (!remField || !whenField) continue;
    if (String(f[whenField] || '') === String(whenEquals || '')) {
      if (!hasFieldValue(remField, Boolean(rem.rejectPending))) {
        const label = `${FIELD_LABELS_VI[remField] || remField} (${whenEquals})`;
        if (!reminders.includes(label)) reminders.push(label);
      }
    }
  }

  const allowedShipping = effectiveRules.enums?.shipping;
  if (f.shipping && Array.isArray(allowedShipping) && allowedShipping.length && !allowedShipping.includes(f.shipping)) {
    ruleErrors.push(`Hình thức ship "${f.shipping}" chưa khớp danh sách OPS (${allowedShipping.join(', ')}).`);
  }

  // Deposit rules (minimum 50% calculated strictly on flowerTotal, excluding accessories & ship; exact 50% passes)
  if (f.paymentState === 'deposit') {
    const dep = Number(f.depositAmount) || 0;
    const flowerTotal = Number(f.flowerTotal) || 0;
    const minRatio = Number(effectiveRules.minDepositRatio ?? 0.5);
    if (dep <= 0) {
      pushMissing('số tiền cọc');
    } else {
      if (flowerTotal > 0 && Number.isFinite(minRatio) && minRatio > 0) {
        const minDeposit = flowerTotal * minRatio;
        if (dep < minDeposit) {
          ruleErrors.push(
            `Tiền cọc (${dep.toLocaleString('vi')} đ) thấp hơn tối thiểu ${Math.round(minRatio * 100)}% tiền hoa (${Math.ceil(minDeposit).toLocaleString('vi')} đ — không tính ship/phụ kiện).`
          );
        }
      }
      const totalDue = computeDraftTotal(f);
      if (totalDue > 0 && dep > totalDue) {
        ruleErrors.push(
          `Số tiền cọc (${dep.toLocaleString('vi')} đ) lớn hơn tổng đơn (${totalDue.toLocaleString('vi')} đ).`
        );
      }
    }
  }

  if (f.paymentState === 'fullpaid') {
    if (effectiveRules.requireSampleForFullPaid !== false && (!draft?.sampleRefs || draft.sampleRefs.length === 0)) {
      pushMissing(`${FIELD_LABELS_VI.sampleRefs} (bắt buộc với Full Paid)`);
    }
    if (!draft?.draftBillRefs || draft.draftBillRefs.length === 0) {
      pushMissing(`${FIELD_LABELS_VI.draftBillRefs} (bắt buộc với Full Paid)`);
    }
    if (f.shipping === 'Shop book ship' && !(Number(f.shipFee) > 0)) {
      pushMissing('phí ship (bắt buộc với Full Paid Shop book ship)');
    }
  }

  const hasUncertain = Boolean(draft?.uncertainFields && Object.keys(draft.uncertainFields).length > 0);
  return {
    ok: unsupportedRules.length === 0 && missing.length === 0 && ruleErrors.length === 0 && !hasUncertain,
    missing,
    reminders,
    ruleErrors,
    unsupportedRules
  };
}

function requiredMissing(draft, rules = DEFAULT_OPS_ORDER_RULES) {
  return validateOrderAgainstRules(draft, rules).missing;
}

function isConfirmable(draft, rules = DEFAULT_OPS_ORDER_RULES) {
  return validateOrderAgainstRules(draft, rules).ok;
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

/**
 * Monotonic per-draft version number used to bind inline keyboard buttons
 * strictly to the exact draft revision displayed to the operator.
 */
export function getDraftVersion(draft) {
  if (!draft || typeof draft !== 'object') return 0;
  const v = Number(draft.version);
  if (Number.isInteger(v) && v >= 1) return v;
  const histLen = Array.isArray(draft.history) ? draft.history.length : 0;
  return histLen + 1;
}

/**
 * Returns true if a draft is still an empty, untouched pending draft.
 */
export function isDraftEmpty(draft) {
  if (!draft || draft.status !== 'pending') return false;
  const f = draft.fields || {};
  const hasAnyField = Object.entries(f).some(([k, v]) => {
    if (k === 'sale') return false;
    return v !== undefined && v !== null && String(v).trim() !== '' && v !== false && v !== 0;
  });
  const hasSamples = Array.isArray(draft.sampleRefs) && draft.sampleRefs.length > 0;
  const hasBills = Array.isArray(draft.draftBillRefs) && draft.draftBillRefs.length > 0;
  const hasUncertain = draft.uncertainFields && Object.keys(draft.uncertainFields).length > 0;
  return !hasAnyField && !hasSamples && !hasBills && !hasUncertain;
}

// ---------------------------------------------------------------------------
// Command handlers — return { reply, drafts }
// ---------------------------------------------------------------------------

function cmdNew(drafts, _args) {
  // Idempotent /new: if the currently active draft is already an empty pending draft,
  // reuse it instead of spawning unwanted duplicate empty drafts.
  const current = activeDraft(drafts);
  if (isDraftEmpty(current)) {
    return {
      reply: `Đơn nháp #${current.id.slice(-6)} đang mở sẵn.\nGửi ảnh mẫu kèm nội dung đơn hàng để bắt đầu.`,
      drafts,
      reused: true,
    };
  }
  const id = newDraftId();
  const draft = { id, fields: { sale: DEFAULT_BOT_SALE }, sampleRefs: [], draftBillRefs: [], status: 'pending', version: 1, createdAt: new Date().toISOString() };
  const next = { ...drafts, [id]: draft, __active: id };
  return { reply: `Đã tạo đơn nháp mới #${id.slice(-6)} (Sale: ${DEFAULT_BOT_SALE_NAME}).\nGửi ảnh mẫu kèm nội dung đơn hàng để bắt đầu.`, drafts: next };
}

function cmdList(drafts) {
  const all = Object.entries(drafts).filter(([k, v]) => !k.startsWith('__') && v && v.id).map(([, v]) => v);
  if (!all.length) return { reply: 'Không có đơn nháp nào. Dùng /new để tạo mới.', drafts };
  const active = drafts.__active;
  const lines = all.map(d => {
    const mark = d.id === active ? '› ' : '  ';
    const missing = requiredMissing(d);
    const status = d.status === 'submitted' ? 'đã tạo OPS' : d.status === 'confirming' ? '⏳ đang tạo' : missing.length ? `thiếu ${missing.length} mục` : 'đủ dữ liệu';
    return `${mark}#${d.id.slice(-6)} · ${d.fields.customer || '(chưa có tên)'} · ${status}`;
  });
  return { reply: `Danh sách nháp:\n${lines.join('\n')}\n\nDùng /select <id> để chuyển.`, drafts };
}

function cmdSelect(drafts, args) {
  const shortId = (args || '').trim();
  if (!shortId) return { reply: 'Dùng: /select <6 ký tự cuối ID>', drafts };
  const found = Object.keys(drafts).filter(k => !k.startsWith('__') && drafts[k]?.id).find(k => k.endsWith(shortId));
  if (!found) return { reply: `Không tìm thấy đơn #${shortId}. Dùng /list để xem.`, drafts };
  return { reply: `Đang xem đơn #${shortId}.\n\n${draftSummary(drafts[found])}`, drafts: { ...drafts, __active: found } };
}

function cmdShow(drafts, _args, rules = DEFAULT_OPS_ORDER_RULES) {
  const draft = activeDraft(drafts);
  if (!draft) return { reply: 'Chưa chọn đơn nào. Dùng /new hoặc /list.', drafts };
  return { reply: draftSummary(draft, rules), drafts };
}

function cmdCancel(drafts, _args) {
  const draft = activeDraft(drafts);
  if (!draft) return { reply: 'Chưa có đơn nháp đang chọn.', drafts };
  if (draft.status === 'submitted') return { reply: 'Đơn đã được tạo trong OPS, không thể xóa nháp.', drafts };
  if (draft.status === 'confirming') return { reply: 'Đang tạo đơn trong OPS, không thể xóa. Vui lòng chờ.', drafts };
  const id = draft.id;
  const next = { ...drafts };
  delete next[id];
  if (next.__active === id) delete next.__active;
  return { reply: `Đã hủy đơn nháp #${id.slice(-6)}.`, drafts: next };
}

function cmdConfirm(drafts, _args, rules = DEFAULT_OPS_ORDER_RULES) {
  const draft = activeDraft(drafts);
  if (!draft) return { reply: 'Chưa có đơn nháp đang chọn. Dùng /new.', drafts };
  if (draft.status === 'submitted') return { reply: '⚠️ Đơn này đã được tạo trong OPS rồi.', drafts };
  if (draft.status === 'confirming') return { reply: '⏳ Đơn đang được tạo trong OPS, vui lòng chờ.', drafts };
  const f = draft.fields || {};
  if (f.paymentState === 'fullpaid' && (!draft.draftBillRefs || draft.draftBillRefs.length === 0)) {
    return {
      reply: '⚠️ Đơn ở trạng thái Đã thanh toán toàn bộ (Fullpaid) nhưng chưa có ảnh bill. Gửi ảnh kèm chữ "bill" trước khi xác nhận tạo đơn.\n\n' + draftSummary(draft, rules),
      drafts
    };
  }
  const validation = validateOrderAgainstRules(draft, rules);
  if (validation.unsupportedRules.length > 0) {
    return {
      reply: `⚠️ OPS có quy tắc mới bot chưa hỗ trợ (${validation.unsupportedRules.join(', ')}). Đơn nháp vẫn được giữ nguyên.\n\n${draftSummary(draft, rules)}`,
      drafts
    };
  }
  if (!validation.ok) {
    return { reply: `⚠️ Chưa đủ dữ liệu hoặc còn thông tin chưa rõ ràng:\n\n${draftSummary(draft, rules)}`, drafts };
  }
  // requestId is set once and kept fixed across all retries — idempotency key for mee_ops_lookup.
  const reqId = draft.requestId || randomUUID();
  const confirmed = {
    ...draft,
    fields: { ...f, sale: f.sale || rules?.saleDefault || DEFAULT_BOT_SALE },
    status: 'confirmed',
    confirmedAt: draft.confirmedAt || new Date().toISOString(),
    requestId: reqId
  };
  return { reply: '__CONFIRM__', drafts: { ...drafts, [draft.id]: confirmed } };
}

// ---------------------------------------------------------------------------
// Field update from text message & Prompt injection defense
// ---------------------------------------------------------------------------

export function detectPromptInjection(text) {
  if (!text) return null;
  const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/(ignore|bo qua).*(previous|instruction|huong dan)/i.test(lower)) return 'instruction_override';
  if (/(system prompt|system override|ghi de he thong|quyen admin)/i.test(lower)) return 'system_override';
  if (/(\bset\s+role\b|\badmin\s*:\s*true|\brole\s*:\s*admin)/i.test(lower)) return 'role_escalation';
  return null;
}

const FORBIDDEN_FIELD_PATTERNS = [
  /^(thanh\s*toan|payment|full\s*paid|da\s*thanh\s*toan)$/i,
  /^(trang\s*thai|status|role|settled|approved)$/i,
];

export function extractNaturalMessage(text, currentDraft = {}, referenceDate = new Date()) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const fields = {};
  const uncertainFields = {};
  const existingFields = currentDraft.fields || {};

  const FLOWER_PATTERN = /\b(ly|li|lily|hong|cuc|tulip|hoa\s*lan|lan\s*ho\s*diep|huong\s*duong|baby|cam\s*tu\s*cau|mau\s*don|hoa|bo\s*hoa|gio\s*hoa|ke\s*hoa|lang\s*hoa|nhuom\s*vien|tone)\b/i;

  for (const line of lines) {
    const raw = line;
    const cleanLine = raw.replace(/^[-*•—_]+\s*/, '').replace(/\s*[-*•—_]+$/, '').trim();
    if (!cleanLine) continue;
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/.test(cleanLine)) continue;
    const normLine = cleanLine.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

    // 1. Payment detection (also handles combined lines like "Tổng 350k cọc 200k")
    const payment = parsePaymentInfo(cleanLine, Number(existingFields.flowerTotal || fields.flowerTotal || 0));
    if (payment) {
      fields.paymentState = payment.paymentState;
      if (payment.flowerTotal) fields.flowerTotal = String(payment.flowerTotal);
      if (payment.depositAmount !== undefined) fields.depositAmount = payment.depositAmount;
      if (payment.reportedPaidAmount !== undefined) fields.reportedPaidAmount = payment.reportedPaidAmount;
      if (payment.isUncertain) uncertainFields.depositAmount = payment.reason;
      continue;
    }

    // 1b. Standalone total price line (e.g. "Tổng 350k", "Giá 450k", "Tiền hoa 600k") without flower/payment keyword
    const mStandaloneTotal = normLine.match(
      new RegExp(`^(?:tong(?:\\s*(?:tien|don|hoa))?|gia(?:\\s*hoa)?|tien\\s*hoa)\\s*[:=-]?\\s*(${MONEY_TOKEN_SOURCE})$`, 'i')
    );
    if (mStandaloneTotal) {
      const normTotal = normalizeMoney(mStandaloneTotal[1]);
      if (/^\d+$/.test(normTotal) && Number(normTotal) >= 10000) {
        fields.flowerTotal = normTotal;
        continue;
      }
    }

    // 2. Date and Time detection
    // A "Name + phone" line (e.g. "Mai + 0909111222") is never a date even when the name is "Mai" (= tomorrow).
    const vnPhoneRegex = /(?<!\d)(?:\+84[\s.\-]*|0)[2-9](?:[\s.\-]*\d){8,9}(?!\d)/;
    const hasPhoneOnLine = vnPhoneRegex.test(cleanLine);
    const isNamePhoneLine = /^[A-ZÀ-Ỹa-zà-ỹ\s]{1,40}\s*[+\-/|,;:&]?\s*(?:\+84[\s.\-]*|0)[2-9](?:[\s.\-]*\d){8,9}$/.test(cleanLine);
    const hasDate = !isNamePhoneLine && (/\b(ngay|\d{1,2}[/-]\d{1,2}|hom\s*nay|ngay\s*mai|sang\s*mai|trua\s*mai|chieu\s*mai|toi\s*mai|giao\s*mai|lay\s*mai|nhan\s*mai|ngay\s*mot)\b/.test(normLine) || /^mai(?:\b|$)/.test(normLine));
    const hasTime = !isNamePhoneLine && /\b(?:\d{1,2}h(?:\d{2})?|\d{1,2}:\d{2}|buoi\s*sang|sang\s*mai|sang\s*nay|sang\s*som|\d{1,2}h\s*sang|buoi\s*chieu|chieu\s*mai|chieu\s*nay|\d{1,2}h\s*chieu|buoi\s*toi|toi\s*nay|toi\s*mai|\d{1,2}h\s*toi)\b/i.test(normLine);
    if (hasDate || hasTime) {
      if (hasDate) {
        const smartDate = parseSmartDate(cleanLine, referenceDate);
        if (smartDate.isUncertain) {
          uncertainFields.date = smartDate.reason;
        } else if (smartDate.value) {
          fields.date = smartDate.value;
        }
      }
      if (hasTime) {
        const smartTime = parseSmartTime(cleanLine);
        if (smartTime.isUncertain) {
          uncertainFields.time = smartTime.reason;
        } else if (smartTime.value) {
          fields.time = smartTime.value;
        }
      }
      if (!hasPhoneOnLine && !FLOWER_PATTERN.test(normLine) && !/\b(dia\s*chi|dc|ship|book|lay|ghe|tan\s*noi)\b/.test(normLine)) {
        continue;
      }
    }

    // 3. Phone detection (also extracts customer name on combined lines like "Như + 0394200327")
    const mPhone = cleanLine.match(/(?:sdt|phone|so\s*dien\s*thoai|sđt)?\s*[:=-]?\s*((?:\+84[\s.\-]*|0)[2-9](?:[\s.\-]*\d){8,9})(?!\d)/i);
    if (mPhone) {
      fields.phone = mPhone[1].replace(/[\s.\-]+/g, '').replace(/^\+84/, '0');
      if (!fields.customer && !FLOWER_PATTERN.test(normLine) && !/\b(dia\s*chi|dc|duong|phuong|quan|p\.|q\.|ship|book|lay|ghe|tan\s*noi)\b/i.test(normLine)) {
        const namePart = cleanLine
          .replace(/(?:sdt|phone|số\s*điện\s*thoại|so\s*dien\s*thoai|sđt)?\s*[:=-]?\s*(?:\+84[\s.\-]*|0)[2-9](?:[\s.\-]*\d){8,9}(?!\d)/gi, '')
          .replace(/^[\s+\-/|,;:—&]+|[\s+\-/|,;:—&]+$/g, '')
          .trim();
        if (namePart && /^[A-ZÀ-Ỹa-zà-ỹ\s]+$/.test(namePart) && namePart.split(/\s+/).length <= 4) {
          const words = namePart.split(/\s+/);
          const stripped = words.length > 1
            ? namePart.replace(/^(?:chị|anh|em|cô|bác|khách|bạn)\s+/i, '').trim()
            : namePart;
          if (stripped) fields.customer = stripped;
        }
      }
    }

    // 4. Explicit shipping detection & explicit shipping fee detection (NEVER guess shipFee when unstated)
    if (/\b(shop\s*book|shop\s*ship|shop\s*giao|giao\s*tan\s*noi|khach\s*tu\s*book|tu\s*book|aha|grab|ghe\s*lay|tai\s*shop|nhan\s*tai\s*shop|tai\s*tiem|nhan\s*tai\s*tiem|tu\s*qua\s*lay|tu\s*lay)\b/i.test(normLine)) {
      if (/shop\s*book|shop\s*ship|shop\s*giao|giao\s*tan\s*noi/.test(normLine)) fields.shipping = 'Shop book ship';
      else if (/khach\s*tu\s*book|tu\s*book|aha|grab/.test(normLine)) fields.shipping = 'Khách tự book';
      else if (/ghe\s*lay|tai\s*shop|nhan\s*tai\s*shop|tai\s*tiem|nhan\s*tai\s*tiem|tu\s*qua\s*lay|tu\s*lay/.test(normLine)) fields.shipping = 'Ghé lấy';
    }
    const mShipFee = normLine.match(/(?:phi\s*ship|tien\s*ship|cuoc\s*ship)\s*[:=-]?\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*(?:k|tr|trieu|ngan|nghin|d)?)/i);
    if (mShipFee) {
      const feeNorm = normalizeMoney(mShipFee[1].replace(/\s*(?:ngan|nghin)\b/gi, 'k'));
      if (/^\d+$/.test(feeNorm) && Number(feeNorm) > 0) {
        fields.shipFee = feeNorm;
      }
      if (!FLOWER_PATTERN.test(normLine) && !/\b(dia\s*chi|dc|duong|phuong|quan|banner|thiep)\b/.test(normLine) && !hasDate && !hasTime && !mPhone) {
        continue;
      }
    }

    // 4b. Natural tag note free / customer note / banner / card extraction
    // Tag note free & customer notes MUST be checked before address/flower/card so they are NEVER billed as a paid card (+10k).
    const mNatTagNote = cleanLine.match(/^(?:(?:in|ghi|kèm|kem|thêm|them)\s+)?tag(?:\s*note)?(?:\s*(?:free|miễn\s*phí|mien\s*phi))?\s*[:=-]?\s*(.+)$/i);
    if (mNatTagNote && mNatTagNote[1]?.trim() && /^(?:(?:in|ghi|kèm|kem|thêm|them)\s+)?tag(?:\s*note|\s*free|\s*miễn\s*phí|\s*mien\s*phi|\s*[:=-])/i.test(cleanLine)) {
      fields.tagNoteFree = mNatTagNote[1].trim();
      continue;
    }
    const mNatCustomerNote = cleanLine.match(/^(?:lưu\s*ý(?:\s*(?:của\s*)?(?:khách(?:\s*hàng)?|đơn(?:\s*hàng)?|giao|bó\s*hoa))?|luu\s*y(?:\s*(?:cua\s*)?(?:khach(?:\s*hang)?|don(?:\s*hang)?|giao|bo\s*hoa))?|khách\s*dặn|khach\s*dan|dặn\s*dò|dan\s*do|lời\s*dặn|loi\s*dan|note\s*(?:khách|khach|đơn|don)|ghi\s*chú|ghi\s*chu)\s*[:=-]?\s*(.+)$/i);
    if (mNatCustomerNote && mNatCustomerNote[1]?.trim()) {
      fields.note = fields.note ? `${fields.note}\n${mNatCustomerNote[1].trim()}` : mNatCustomerNote[1].trim();
      continue;
    }
    const mNatBanner = cleanLine.match(/^(?:(?:thêm|them|kèm|kem|lấy|lay|đặt|dat)\s+)?(?:(\d{1,2})\s*(?:cái|cai|tấm|tam)?\s+)?banner(?:\s+(\d{1,2})\s*(?:cái|cai|tấm|tam)?)?(?:\s*(?:nội\s*dung|noi\s*dung|nd)\b)?\s*[:=-]?\s*(.+)$/i);
    if (mNatBanner && mNatBanner[3]?.trim()) {
      const bQty = Number(mNatBanner[1] || mNatBanner[2] || 1);
      if (Number.isInteger(bQty) && bQty >= 1 && bQty <= 99) {
        fields.banner = true;
        fields.bannerQty = bQty;
        fields.bannerText = mNatBanner[3].trim();
        continue;
      }
    }
    const mNatCard = cleanLine.match(/^(?:(?:thêm|them|kèm|kem|lấy|lay|đặt|dat)\s+)?(?:(\d{1,2})\s*(?:cái|cai|tấm|tam)?\s+)?(?:thiệp|thiep)(?:\s+(\d{1,2})\s*(?:cái|cai|tấm|tam)?)?(?:\s*(?:nội\s*dung|noi\s*dung|nd)\b)?\s*[:=-]?\s*(.+)$/i);
    if (mNatCard && mNatCard[3]?.trim()) {
      const cQty = Number(mNatCard[1] || mNatCard[2] || 1);
      if (Number.isInteger(cQty) && cQty >= 1 && cQty <= 99) {
        fields.card = true;
        fields.cardQty = cQty;
        fields.cardText = mNatCard[3].trim();
        continue;
      }
    }

    // 5. Address detection (NEVER auto-guesses shipping when shipping method is not stated)
    if (/(?:dia\s*chi\s*)?(?:bsung|bo\s*sung|bao|gui)\s*sau|chua\s*co\s*dia\s*chi|(?:bao|gui)\s*dia\s*chi\s*sau/i.test(normLine)) {
      fields.address = 'Địa chỉ báo sau';
      if (!FLOWER_PATTERN.test(normLine) && !/\b(bank|ck|fullpaid|coc)\b/.test(normLine)) {
        continue;
      }
    }
    const mAddr = cleanLine.match(/(?:(?:^|[\s,;])(?:[dđ][iị]a\s*ch[iỉ](?:\s*(?:nh[aậ]n|giao(?:\s*h[aà]ng)?))?|[dđ]c|giao\s*[dđ][eêế]n|giao\s*t[aạ]i|giao\s*qua))\s*[:=-]?\s*([^,\n]+(?:,\s*[^,\n]+)*)/i);
    if (mAddr) {
      let addr = mAddr[1].replace(/,\s*(?:sdt|phone|so\s*dien\s*thoai|sđt)?\s*[:=-]?\s*0\d{9,10}.*$/i, '').trim();
      addr = addr.replace(/\b(?:sdt|phone|so\s*dien\s*thoai|sđt)\s*[:=-]?\s*0\d{9,10}.*$/i, '').trim();
      if (addr) {
        fields.address = addr;
        continue;
      }
    }
    if (/\b(duong|phuong|quan|p\.|q\.|tp\.|hcm|quan\s*\d+|phuong\s*\d+|ap|xa|huyen|tinh)\b/i.test(normLine) || /^\d+[\w/]*\s+[A-ZÀ-Ỹa-zà-ỹ]/.test(cleanLine)) {
      if (!FLOWER_PATTERN.test(normLine) && !/\b(bank|ck|fullpaid|coc)\b/.test(normLine)) {
        fields.address = cleanLine.replace(/,\s*(?:sdt|phone|so\s*dien\s*thoai|sđt)?\s*[:=-]?\s*0\d{9,10}.*$/i, '').trim();
        continue;
      }
    }

    if (fields.phone && (fields.address || fields.shipping)) {
      if (!FLOWER_PATTERN.test(normLine) && !/\b(dia\s*chi|dc|ship|book|lay|ghe|tan\s*noi)\b/.test(normLine)) {
        continue;
      }
    }

    // 6. Flower description detection
    if (FLOWER_PATTERN.test(normLine)) {
      // Keep only the flower description: drop comma-separated fragments that are dates, times, prices or shipping
      let flowerOnly = cleanLine
        .split(/\s*[,;]\s*/)
        .filter(seg => {
          const n = seg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
          if (!n) return false;
          if (FLOWER_PATTERN.test(n)) return true;
          return !/(\d{1,2}[/-]\d{1,2}|\d{1,2}h|\d{1,2}:\d{2}|(?:^|\s)[pq]\.(?:\s|$)|\b(?:nhan|giao|lay|ngay|gio|sang|chieu|toi|trua|mai|phuong|quan|duong|hem|tp\.?\s*hcm|dia\s*chi|dc)\b|\d+\/\d+|\d+\s*(k|tr|trieu)\b|\d{4,}|ship|book|ghe\s*lay)/.test(n);
        })
        .join(', ')
        .trim();

      // Separate leading customer + ordering verb (e.g. "chị Lan lấy bó tulip trắng nha" -> customer "Lan", flower "Bó tulip trắng")
      const mCustFlower = flowerOnly.match(
        /^(?:chị|anh|em|cô|bác|khách|bạn)\s+([A-ZÀ-Ỹ][a-zà-ỹ]+(?:\s+[A-ZÀ-Ỹ][a-zà-ỹ]+){0,2})\s+(?:lấy|đặt|mua|chọn|order)\s+(.+)$/i
      );
      if (mCustFlower) {
        if (!fields.customer) fields.customer = mCustFlower[1].trim();
        flowerOnly = mCustFlower[2].trim();
      } else {
        flowerOnly = flowerOnly.replace(/^(?:lấy|đặt|mua|chọn|order)\s+/i, '').trim();
      }
      // Strip trailing conversational filler particles ("nha", "nhé", "ạ", "giúp em", ...)
      const strippedFiller = flowerOnly.replace(/\s+(?:nha\s+(?:em|shop)|nhé\s+(?:em|shop)|giúp\s+em|giùm\s+em|dùm\s+em|nha|nhé|nhe|nhá|ạ)+$/i, '').trim();
      if (strippedFiller) flowerOnly = strippedFiller;
      // Capitalize initial letter when natural lead-in/filler was stripped (e.g. "bó tulip trắng" -> "Bó tulip trắng")
      if (mCustFlower && flowerOnly && /^[a-zà-ỹ]/.test(flowerOnly)) {
        flowerOnly = flowerOnly[0].toUpperCase() + flowerOnly.slice(1);
      }

      fields.flower = flowerOnly || cleanLine;
      const lineWithoutPhones = cleanLine.replace(/(?:sdt|phone|sđt|số\s*điện\s*thoại)?\s*[:=-]?\s*\b0\d{9,10}\b/gi, ' ');
      const mPrice = lineWithoutPhones.match(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*(?:k|tr|trieu)|(?<![\d.])\b[1-9]\d{4,8}\b)/i);
      if (mPrice) {
        const norm = normalizeMoney(mPrice[1]);
        if (/^\d+$/.test(norm) && Number(norm) >= 50000) {
          fields.flowerTotal = norm;
        }
      }
      if (!FLOWER_PATTERN.test(normLine) && !/\b(dia\s*chi|dc|ship|book|lay|ghe|tan\s*noi)\b/.test(normLine)) {
        continue;
      }
    }

    // 7. Name detection: a shipping method or flower description is never a customer name.
    const NON_NAME_PHRASE = /\b(anh\s*mau|hinh\s*mau|mau\s*tham\s*khao|tham\s*khao|goc\s*chup|goc\s*khac|them\s*anh|them\s*hinh|bo\s*sung|gui\s*them|hinh\s*khac|anh\s*khac|xem\s*them|cam\s*on|ok|oke|vang|xong)\b/i;
    const isShippingPhrase = /\b(shop\s*(?:book|ship|giao)|khach\s*tu\s*book|tu\s*book|ghe\s*lay|tai\s*shop|nhan\s*tai\s*shop|tai\s*tiem|nhan\s*tai\s*tiem|tu\s*lay|grab|aha)\b/i.test(normLine);
    const hasHonorific = /^(?:chị|anh|em|cô|bác|khách|bạn)\s+/i.test(cleanLine);
    const startsCapitalized = /^[A-ZÀ-Ỹ]/.test(cleanLine);
    if (
      /^[A-ZÀ-Ỹa-zà-ỹ\s]+$/.test(cleanLine) &&
      cleanLine.split(/\s+/).length <= 4 &&
      (hasHonorific || startsCapitalized) &&
      !NON_NAME_PHRASE.test(normLine) &&
      !FLOWER_PATTERN.test(normLine) &&
      !isShippingPhrase &&
      !fields.customer
    ) {
      const stripped = hasHonorific
        ? cleanLine.replace(/^(?:chị|anh|em|cô|bác|khách|bạn)\s+/i, '').trim()
        : cleanLine;
      if (stripped) fields.customer = stripped;
      if (!FLOWER_PATTERN.test(normLine) && !/\b(dia\s*chi|dc|ship|book|lay|ghe|tan\s*noi)\b/.test(normLine)) {
        continue;
      }
    }
  }

  return { fields, uncertainFields };
}

function applyFieldLine(draft, line) {
  const cleanLine = line.replace(/^[-*•]\s*/, '').trim();
  let rawKey = '';
  let rawVal = '';
  const sep = cleanLine.indexOf(':');
  if (sep >= 1) {
    rawKey = cleanLine.slice(0, sep).trim();
    rawVal = cleanLine.slice(sep + 1).trim();
  } else {
    // Support explicit edit syntax without colon, e.g. "đổi giờ thành 15h", "sửa giá sang 450k", "sửa mẫu hoa thành Bó tulip trắng"
    const mEdit = cleanLine.match(/^(?:sửa|đổi|chỉnh|cập\s*nhật|thay\s*đổi)\s+(.+?)\s+(?:lại\s+thành|thành|sang|lại\s+là|là)\s+(.+)$/i);
    if (!mEdit) return null;
    rawKey = mEdit[1].trim();
    rawVal = mEdit[2].trim();
  }
  // Strip optional leading edit verb from key (e.g. "sửa giờ: 15h" -> "giờ")
  rawKey = rawKey.replace(/^(?:sửa|đổi|chỉnh|cập\s*nhật|thay\s*đổi)\s+/i, '').trim();
  if (!rawKey || !rawVal) return null;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/.test(rawVal)) {
    return { warning: '⚠️ Dữ liệu vừa nhập chứa ký tự điều khiển không hợp lệ — đã chặn để bảo toàn đơn nháp.' };
  }

  // Check forbidden fields (payment, status, admin)
  const normK = normalizeKey(rawKey);
  for (const pat of FORBIDDEN_FIELD_PATTERNS) {
    if (pat.test(normK) || pat.test(rawKey)) {
      return { warning: '⚠️ Lưu ý: Không thể đặt thanh toán hoặc trạng thái qua bot. Thanh toán luôn cố định là "Chưa thanh toán".' };
    }
  }

  const field = resolveField(rawKey);
  if (!field) return null;

  let value = rawVal;
  let isUncertain = false;
  let reason = '';
  let extra = null;

  if (field === 'flower') {
    const mPrice = rawVal.match(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*(?:k|tr|trieu)?|\d{5,9})/i);
    if (mPrice) {
      const norm = normalizeMoney(mPrice[1]);
      if (/^\d+$/.test(norm) && Number(norm) >= 50000) {
        extra = { flowerTotal: norm };
      }
    }
  } else if (field === 'shipping') {
    value = normalizeShipping(rawVal);
    if (!SHIPPING_VALUES.includes(value)) {
      isUncertain = true;
      reason = `Hình thức giao "${rawVal}" chưa rõ (chọn: Shop book ship, Khách tự book, Ghé lấy)`;
    }
  } else if (field === 'paymentInfo') {
    const currentTotal = Number(draft.fields?.flowerTotal || 0);
    const info = parsePaymentInfo(rawVal, currentTotal);
    if (info) {
      return { field: 'paymentState', value: info.paymentState, isUncertain: info.isUncertain || false, reason: info.reason || '', extra: info };
    }
  } else if (field === 'depositAmount') {
    const val = normalizeMoney(rawVal);
    if (!/^\d+$/.test(val) || Number(val) <= 0) {
      isUncertain = true;
      reason = `Số tiền cọc "${rawVal}" không hợp lệ`;
    } else {
      value = Number(val);
      extra = { paymentState: 'deposit', reportedPaidAmount: Number(val) };
    }
  } else if (field === 'flowerTotal' || field === 'charmFee' || field === 'paperFee' || field === 'vat' || field === 'shipFee') {
    value = normalizeMoney(rawVal);
    if (!/^\d+$/.test(value) || Number(value) < 0) {
      isUncertain = true;
      reason = `Số tiền "${rawVal}" không hợp lệ`;
    }
  } else if (field === 'date') {
    const smartDate = parseSmartDate(rawVal);
    value = smartDate.value;
    if (smartDate.isUncertain) {
      isUncertain = true;
      reason = smartDate.reason;
    }
  } else if (field === 'time') {
    const smartTime = parseSmartTime(rawVal);
    value = smartTime.value;
    if (smartTime.isUncertain) {
      isUncertain = true;
      reason = smartTime.reason;
    }
  } else if (field === 'cardQty' || field === 'bannerQty') {
    const n = parseInt(rawVal, 10);
    value = Number.isInteger(n) && n >= 1 && n <= 99 ? n : 1;
  } else if (field === 'card' || field === 'banner') {
    const normBool = rawVal.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
    if (/^(?:khong|no|false|0|huy|bo)$/.test(normBool)) {
      value = false;
    } else if (/^(?:co|yes|true|1)$/.test(normBool)) {
      value = true;
    } else {
      const mWithQty = rawVal.match(/^(\d{1,2})\s*(?:cái|cai|tấm|tam)?\s*[-:,]?\s*(.+)$/i);
      const itemQty = mWithQty && Number(mWithQty[1]) >= 1 && Number(mWithQty[1]) <= 99 ? Number(mWithQty[1]) : 1;
      const itemText = (mWithQty && mWithQty[2]?.trim()) ? mWithQty[2].trim() : rawVal;
      const targetTextField = field === 'card' ? 'cardText' : 'bannerText';
      const targetQtyField = field === 'card' ? 'cardQty' : 'bannerQty';
      return {
        field: targetTextField,
        value: itemText,
        isUncertain: false,
        reason: '',
        extra: { [field]: true, [targetQtyField]: itemQty }
      };
    }
  }

  return { field, value, isUncertain, reason, extra };
}

function applyFields(draft, text, options = {}) {
  const lines = text.split('\n');
  const changes = [];
  const warnings = [];
  const uncertain = { ...(draft.uncertainFields || {}) };
  const newFields = { ...(draft.fields || {}) };
  const unparsedLines = [];

  // 1. First pass: Structured key: value lines (plus safe multi-line continuation for note / tagNoteFree)
  let activeFreeTextField = null;
  for (const line of lines) {
    const result = applyFieldLine(draft, line);
    if (!result) {
      const trimmedLine = line.trim();
      if (activeFreeTextField && trimmedLine) {
        const probeCont = extractNaturalMessage(trimmedLine, { ...draft, fields: newFields }, options.referenceDate);
        const hasOrderFields = Object.keys(probeCont.fields || {}).length > 0 || Object.keys(probeCont.uncertainFields || {}).length > 0;
        if (!hasOrderFields && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/.test(trimmedLine)) {
          newFields[activeFreeTextField] = `${newFields[activeFreeTextField]}\n${trimmedLine}`;
          const lastChange = [...changes].reverse().find(c => c.field === activeFreeTextField && !c.uncertain);
          if (lastChange) lastChange.value = newFields[activeFreeTextField];
          continue;
        }
      }
      activeFreeTextField = null;
      unparsedLines.push(line);
      continue;
    }
    if (result.warning) {
      activeFreeTextField = null;
      warnings.push(result.warning);
      continue;
    }
    const { field, value, isUncertain, reason, extra } = result;
    activeFreeTextField = (!isUncertain && (field === 'note' || field === 'tagNoteFree')) ? field : null;
    if (isUncertain) {
      uncertain[field] = reason;
      changes.push({ field, value, uncertain: true, reason });
    } else {
      delete uncertain[field];
      const alreadySetInThisPass = (field === 'note' || field === 'tagNoteFree') &&
        changes.some(c => c.field === field && !c.uncertain);
      const effectiveVal = alreadySetInThisPass
        ? `${newFields[field]}\n${value}`
        : value;
      newFields[field] = effectiveVal;
      changes.push({ field, value: effectiveVal });

      if (extra) {
        if (extra.paymentState !== undefined) newFields.paymentState = extra.paymentState;
        if (extra.depositAmount !== undefined) newFields.depositAmount = extra.depositAmount;
        if (extra.flowerTotal) newFields.flowerTotal = String(extra.flowerTotal);
        if (extra.reportedPaidAmount !== undefined) newFields.reportedPaidAmount = extra.reportedPaidAmount;
        if (extra.card !== undefined) newFields.card = extra.card;
        if (extra.cardQty !== undefined) newFields.cardQty = extra.cardQty;
        if (extra.banner !== undefined) newFields.banner = extra.banner;
        if (extra.bannerQty !== undefined) newFields.bannerQty = extra.bannerQty;
      }

      if (field === 'card' && value === false) {
        newFields.cardQty = 0;
        delete newFields.cardText;
      }
      if (field === 'banner' && value === false) {
        newFields.bannerQty = 0;
        delete newFields.bannerText;
      }
      if (field === 'cardQty' && Number(value) >= 1 && newFields.cardText) {
        newFields.card = true;
      }
      if (field === 'bannerQty' && Number(value) >= 1 && newFields.bannerText) {
        newFields.banner = true;
      }
      if (field === 'cardText' && value) {
        newFields.card = true;
        if (!newFields.cardQty) newFields.cardQty = 1;
      }
      if (field === 'bannerText' && value) {
        newFields.banner = true;
        if (!newFields.bannerQty) newFields.bannerQty = 1;
      }
    }
  }

  // 2. Second pass: Natural conversational parsing for unparsed or free-form text
  if (unparsedLines.length) {
    const natural = extractNaturalMessage(unparsedLines.join('\n'), { ...draft, fields: newFields }, options.referenceDate);
    for (const [k, v] of Object.entries(natural.fields || {})) {
      // Only apply if not already set by an explicit line in this pass
      if (!changes.some(c => c.field === k)) {
        newFields[k] = v;
        changes.push({ field: k, value: v });
        delete uncertain[k];
      }
    }
    for (const [k, reason] of Object.entries(natural.uncertainFields || {})) {
      if (!changes.some(c => c.field === k && !c.uncertain)) {
        uncertain[k] = reason;
        changes.push({ field: k, value: null, uncertain: true, reason });
      }
    }
  }

  if (!changes.length && !warnings.length) return { draft, changes: [], warnings: [] };

  const effectiveRules = options?.rules || DEFAULT_OPS_ORDER_RULES;
  if (!newFields.sale) {
    newFields.sale = effectiveRules.saleDefault || DEFAULT_BOT_SALE;
  }

  // Re-validate payment consistency against current order total and OPS min-deposit rule after all field updates
  if (newFields.paymentState === 'bankfull' && newFields.flowerTotal) {
    newFields.reportedPaidAmount = Number(newFields.flowerTotal);
  }
  const DEPOSIT_ERROR_PATTERN = /lớn hơn tổng đơn|thấp hơn tối thiểu/;
  if (newFields.paymentState === 'deposit' && Number(newFields.depositAmount) > 0) {
    const dep = Number(newFields.depositAmount);
    const flowerTotal = Number(newFields.flowerTotal) || 0;
    const totalDue = computeDraftTotal(newFields);
    const minRatio = Number(effectiveRules.minDepositRatio ?? 0.5);
    const minDeposit = flowerTotal > 0 && Number.isFinite(minRatio) && minRatio > 0 ? flowerTotal * minRatio : 0;

    if (totalDue > 0 && dep > totalDue) {
      const reason = `Số tiền cọc (${dep.toLocaleString('vi')} đ) lớn hơn tổng đơn (${totalDue.toLocaleString('vi')} đ). Vui lòng kiểm tra lại tổng tiền hoặc tiền cọc.`;
      uncertain.depositAmount = reason;
      changes.push({ field: 'depositAmount', value: dep, uncertain: true, reason });
    } else if (minDeposit > 0 && dep < minDeposit) {
      const reason = `Tiền cọc (${dep.toLocaleString('vi')} đ) thấp hơn tối thiểu ${Math.round(minRatio * 100)}% tiền hoa (${Math.ceil(minDeposit).toLocaleString('vi')} đ — không tính phụ kiện/phí ship).`;
      uncertain.depositAmount = reason;
      changes.push({ field: 'depositAmount', value: dep, uncertain: true, reason });
    } else if (uncertain.depositAmount && DEPOSIT_ERROR_PATTERN.test(uncertain.depositAmount)) {
      delete uncertain.depositAmount;
    }
  } else if (uncertain.depositAmount && DEPOSIT_ERROR_PATTERN.test(uncertain.depositAmount)) {
    delete uncertain.depositAmount;
  }

  const historyEntry = {
    at: new Date().toISOString(),
    changes: changes.map(c => ({ field: c.field, value: c.value, uncertain: !!c.uncertain })),
    snippet: text.slice(0, 100),
  };
  const updatedHistory = [...(draft.history || []), historyEntry];

  const updatedDraft = {
    ...draft,
    fields: newFields,
    uncertainFields: uncertain,
    history: updatedHistory,
    version: getDraftVersion(draft) + 1,
  };
  return { draft: updatedDraft, changes, warnings };
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
  if (draft.status === 'confirming') return { ok: false, reply: 'Đơn đang được tạo, không thể thêm ảnh lúc này.' };
  if ((draft.draftBillRefs || []).length >= 10) return { ok: false, reply: '⚠️ Tối đa 10 ảnh bill trong mỗi đơn nháp.' };
  const ref = { fileId: telegramFileId, caption: (caption || '').slice(0, 200), savedAt: new Date().toISOString() };
  const updated = { ...draft, draftBillRefs: [...(draft.draftBillRefs || []), ref], version: getDraftVersion(draft) + 1 };
  const next = { ...drafts, [draft.id]: updated };
  const isFullPaid = draft.fields?.paymentState === 'fullpaid';
  return {
    ok: true,
    reply: isFullPaid
      ? `Đã lưu ảnh bill vào nháp #${draft.id.slice(-6)} (${updated.draftBillRefs.length} ảnh).`
      : `Đã lưu ảnh bill vào nháp #${draft.id.slice(-6)} (${updated.draftBillRefs.length} ảnh — chỉ lưu nháp, KHÔNG tự xác nhận thanh toán).`,
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
  if (draft.status === 'confirming') return { ok: false, reply: 'Đơn đang được tạo, không thể thêm ảnh lúc này.' };
  if ((draft.sampleRefs || []).length >= 10) return { ok: false, reply: '⚠️ Tối đa 10 ảnh mẫu trong mỗi đơn nháp.' };
  const ref = { fileId: telegramFileId, caption: (caption || '').slice(0, 200), savedAt: new Date().toISOString() };
  const updated = { ...draft, sampleRefs: [...(draft.sampleRefs || []), ref], version: getDraftVersion(draft) + 1 };
  const next = { ...drafts, [draft.id]: updated };
  return {
    ok: true,
    reply: `Đã lưu ảnh mẫu vào nháp #${draft.id.slice(-6)} (${updated.sampleRefs.length} ảnh).`,
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

  // Prompt injection protection
  const injection = detectPromptInjection(trimmed);
  if (injection) {
    return {
      reply: '⚠️ Phát hiện nội dung không hợp lệ hoặc cố ý ghi đè chỉ dẫn hệ thống. Lệnh bị từ chối.',
      drafts,
      action: null,
    };
  }

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

  const { draft: updated, changes, warnings } = applyFields(draft, trimmed);
  if (!changes.length && !warnings?.length) {
    return { reply: `Không nhận ra trường nào. Dùng dạng:\n  tên khách: Nguyễn A\nhoặc gõ /show để xem đơn.`, drafts, action: null };
  }
  const next = { ...drafts, [draft.id]: updated };
  saveDrafts(userId, next);

  const changed = changes.map(c => c.uncertain ? `  ⚠️ ${c.field}: ${c.reason}` : `  ${c.field}: ${c.value}`).join('\n');
  const still = requiredMissing(updated);
  const uncertainCount = Object.keys(updated.uncertainFields || {}).length;
  let extra = '';
  if (still.length) extra += `\n⚠️ Còn thiếu: ${still.join(', ')}`;
  if (uncertainCount) extra += `\n❓ Có ${uncertainCount} trường cần làm rõ trước khi xác nhận.`;
  if (!still.length && !uncertainCount) extra += '\n✅ Đã đủ dữ liệu — dùng /confirm để tạo đơn.';
  const warnMsg = warnings?.length ? `\n${warnings.join('\n')}` : '';

  const prefix = changed ? `✏️ Đã cập nhật:\n${changed}` : '';
  return { reply: `${prefix}${extra}${warnMsg}`.trim(), drafts: next, action: null };
}

export function isBillCaption(caption) {
  if (!caption) return false;
  return /\b(bill|hoa don|hóa đơn)\b/i.test(caption);
}

/**
 * Classify how an incoming Telegram photo (+ optional caption) should be routed
 * relative to existing drafts so two different orders are NEVER silently mixed.
 *
 * Returns one of:
 *   - { action: 'attach_active', parsed }  — clearly belongs to active draft
 *   - { action: 'create_new', parsed, reason } — clearly a new order (preserve old draft)
 *   - { action: 'ask_user', parsed, conflicts, reason } — ambiguous; ask operator to pick
 *   - { action: 'reject_no_draft' | 'reject_submitted' | 'reject_confirming' }
 */
export function classifyIncomingPhotoDraft(drafts, caption, isBill = false, options = {}) {
  const active = activeDraft(drafts);
  const trimmedCaption = String(caption || '').trim();

  if (isBill) {
    if (!active) return { action: 'reject_no_draft' };
    if (active.status === 'confirming') return { action: 'reject_confirming' };
    if (active.status === 'submitted') return { action: 'reject_submitted' };
    return { action: 'attach_active', parsed: null };
  }

  // Probe-parse caption completely in isolation (never inheriting fields from active draft)
  const probe = trimmedCaption
    ? applyFields({ id: '__probe__', fields: {}, uncertainFields: {} }, trimmedCaption, options)
    : { draft: { fields: {}, uncertainFields: {} }, changes: [], warnings: [] };
  const incoming = probe.draft.fields || {};
  const incomingUncertain = probe.draft.uncertainFields || {};

  const ORDER_CONCEPT_KEYS = [
    'customer', 'phone', 'flower', 'flowerTotal', 'date', 'time',
    'shipping', 'address', 'note', 'tagNoteFree', 'paymentState', 'cardText', 'bannerText'
  ];
  const hasVal = (obj, k) => obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '';
  const incomingConcepts = ORDER_CONCEPT_KEYS.filter(k => hasVal(incoming, k));
  const hasIncomingOrderData = incomingConcepts.length > 0 || Object.keys(incomingUncertain).length > 0;

  // Case 1: No active draft or previous draft already submitted
  // Any non-empty caption accompanying a sample photo can open a new draft (allowing Gemini or clarification questions),
  // whereas an uncaptioned bare sample photo still requires an active draft.
  const canStartNewDraft = hasIncomingOrderData || Boolean(trimmedCaption);
  if (!active) {
    return canStartNewDraft
      ? { action: 'create_new', parsed: probe, reason: 'no_active_draft' }
      : { action: 'reject_no_draft' };
  }
  if (active.status === 'submitted') {
    return canStartNewDraft
      ? { action: 'create_new', parsed: probe, reason: 'previous_submitted' }
      : { action: 'reject_submitted' };
  }
  if (active.status === 'confirming') {
    return incomingConcepts.length >= 2
      ? { action: 'create_new', parsed: probe, reason: 'previous_confirming' }
      : { action: 'reject_confirming' };
  }

  // Case 2: Active pending draft is completely empty -> attach cleanly
  if (isDraftEmpty(active)) {
    return { action: 'attach_active', parsed: probe };
  }

  // Case 3: Pure supplementary photo (empty caption or short photo label with zero order fields)
  if (!hasIncomingOrderData) {
    return { action: 'attach_active', parsed: probe };
  }

  // Case 4: Active draft already has data AND incoming photo caption has order fields
  const existing = active.fields || {};
  const existingConcepts = ORDER_CONCEPT_KEYS.filter(k => hasVal(existing, k));
  const normVal = v => String(v || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ');
  const normName = v => normVal(v).replace(/^(?:chi|anh|em|co|bac|khach|ban)\s+/i, '');
  const normPhone = v => String(v || '').replace(/\D/g, '');

  const sameCustomer = hasVal(existing, 'customer') && hasVal(incoming, 'customer') &&
    normName(existing.customer) === normName(incoming.customer);
  const samePhone = hasVal(existing, 'phone') && hasVal(incoming, 'phone') &&
    normPhone(existing.phone) === normPhone(incoming.phone);

  const conflicts = [];
  const customerConflict = hasVal(existing, 'customer') && hasVal(incoming, 'customer') && !sameCustomer;
  const phoneConflict = hasVal(existing, 'phone') && hasVal(incoming, 'phone') && !samePhone;
  const addressConflict = hasVal(existing, 'address') && hasVal(incoming, 'address') &&
    !isPendingAddress(existing.address) && !isPendingAddress(incoming.address) &&
    normVal(existing.address) !== normVal(incoming.address);
  const flowerConflict = hasVal(existing, 'flower') && hasVal(incoming, 'flower') &&
    normVal(existing.flower) !== normVal(incoming.flower);
  const priceConflict = hasVal(existing, 'flowerTotal') && hasVal(incoming, 'flowerTotal') &&
    Number(existing.flowerTotal) !== Number(incoming.flowerTotal);
  const dateConflict = hasVal(existing, 'date') && hasVal(incoming, 'date') &&
    existing.date !== incoming.date;
  const timeConflict = hasVal(existing, 'time') && hasVal(incoming, 'time') &&
    existing.time !== incoming.time;
  const noteConflict = hasVal(existing, 'note') && hasVal(incoming, 'note') &&
    normVal(existing.note) !== normVal(incoming.note);

  if (customerConflict) conflicts.push('khách hàng');
  if (phoneConflict) conflicts.push('SĐT');
  if (addressConflict) conflicts.push('địa chỉ');
  if (flowerConflict) conflicts.push('mẫu hoa');
  if (priceConflict) conflicts.push('giá tiền');
  if (dateConflict) conflicts.push('ngày nhận');
  if (timeConflict) conflicts.push('giờ nhận');
  if (noteConflict) conflicts.push('ghi chú');

  const hasIdentityConflict = customerConflict || phoneConflict;
  const hasActiveSample = (active.sampleRefs || []).length > 0;

  // Definitely a NEW order: different customer/phone, OR rich new-order caption (>= 3 fields)
  // while active draft already contains another order's data/photo and doesn't explicitly match identity.
  if (hasIdentityConflict) {
    return { action: 'create_new', parsed: probe, conflicts, reason: 'identity_conflict' };
  }
  if (!sameCustomer && !samePhone && incomingConcepts.length >= 3 &&
      (conflicts.length >= 1 || (existingConcepts.length >= 2 && hasActiveSample))) {
    return { action: 'create_new', parsed: probe, conflicts, reason: 'new_order_caption' };
  }

  // Ambiguous: conflicting fields without explicit same-customer confirmation,
  // OR active draft already has a sample photo + >= 2 fields and incoming photo carries >= 2 order fields.
  if (conflicts.length >= 1 && !sameCustomer && !samePhone) {
    return { action: 'ask_user', parsed: probe, conflicts, reason: 'conflicting_fields' };
  }
  if (!sameCustomer && !samePhone && hasActiveSample && existingConcepts.length >= 2 && incomingConcepts.length >= 2) {
    return { action: 'ask_user', parsed: probe, conflicts, reason: 'ambiguous_second_photo_caption' };
  }

  // Otherwise safe to attach as supplementary photo / same-order update
  return { action: 'attach_active', parsed: probe };
}

export {
  loadDrafts, saveDrafts, activeDraft, requiredMissing, isConfirmable,
  normalizeShipping, normalizeMoney, normalizeDate, normalizeTime,
  applyFields, isPendingAddress,
  cmdNew, cmdList, cmdSelect, cmdShow, cmdCancel, cmdConfirm
};
