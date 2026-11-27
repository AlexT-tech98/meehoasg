/**
 * MEEHOA Order Bot V1 — OPS API Client (Cloudflare Worker)
 *
 * Communicates with MEEHOA OPS backend:
 *   - Staging: Cloudflare Worker (`meehoasg-ops-staging`) using app session token
 *   - Production: Supabase Edge Function (`meehoasg-api-core`, `verify_jwt: true`)
 *     using strict separation between Supabase Gateway Auth (`apikey` + `Authorization: Bearer <OPS_SUPABASE_ANON_KEY>`)
 *     and OPS Application Session (`payload.token = OPS_TOKEN` of `cmui`).
 *
 * Enforces owner-verified payment recording and strict invariants:
 *   - unpaid, deposit ("Đã cọc X đ"), and bankfull ("Đã thanh toán đủ tiền hoa (Full)")
 *     are recorded through OPS createOrder / updateOrder RPCs
 *   - fullPaidRequested is always false (Full Paid requires bill + ship evidence in OPS)
 *   - requestId / paymentSyncRequestId are fixed for idempotent retries
 *   - All secrets and technical error messages are sanitized
 */

import {
  mapPaymentToOps,
  formatPaymentClaimNote,
  stripPaymentClaimTags,
  DEFAULT_BOT_SALE,
  DEFAULT_OPS_ORDER_RULES
} from '../core.mjs';

export { mapPaymentToOps, formatPaymentClaimNote, stripPaymentClaimTags };

export function isSupabaseOpsUrl(opsUrl) {
  const raw = String(opsUrl || '').trim();
  return /supabase\.co\/functions\/v1\//i.test(raw) || /\/functions\/v1\/meehoasg-api/i.test(raw);
}

/**
 * Build HTTP headers for OPS API requests.
 * Strictly separates Supabase Edge Gateway JWT (`opsApiKey`) from the opaque OPS app session (`opsToken`).
 * - When `opsApiKey` is set (Supabase Production with `verify_jwt: true`):
 *     `apikey: <opsApiKey>` and `Authorization: Bearer <opsApiKey>` satisfy the gateway,
 *     while `payload.token` carries the opaque 64-hex OPS session (`opsToken`).
 * - When `opsApiKey` is empty (Cloudflare OPS Staging):
 *     `Authorization: Bearer <opsToken>` preserves existing Staging compatibility.
 */
export function buildOpsHeaders(opsToken, opsApiKey = '') {
  const gatewayKey = String(opsApiKey || '').trim();
  if (gatewayKey) {
    return {
      'Content-Type': 'application/json',
      'apikey': gatewayKey,
      'Authorization': `Bearer ${gatewayKey}`
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${opsToken}`
  };
}

/**
 * Check OPS backend reachability & session validity for `/status`.
 * - Supabase Production: probes `POST getOrderRules` with Gateway Auth + App Session token.
 * - Cloudflare Staging: probes `GET <opsBase>/health`.
 */
export async function checkOpsHealth(opsUrl, opsToken, fetcher = fetch, { opsApiKey = '' } = {}) {
  const url = String(opsUrl || '').trim();
  const gatewayKey = String(opsApiKey || '').trim();
  const useSupabaseMode = Boolean(gatewayKey) || isSupabaseOpsUrl(url);

  if (useSupabaseMode) {
    if (!opsToken) {
      return { ok: false, authMode: 'supabase_gateway_jwt+app_session', httpStatus: null, error: 'OPS_TOKEN_MISSING' };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: buildOpsHeaders(opsToken, gatewayKey),
        body: JSON.stringify({
          name: 'getOrderRules',
          payload: { token: opsToken }
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        return {
          ok: false,
          authMode: 'supabase_gateway_jwt+app_session',
          httpStatus: res.status,
          error: res.status === 401 ? 'GATEWAY_UNAUTHORIZED' : `HTTP_${res.status}`
        };
      }
      const json = await res.json();
      if (!json?.ok) {
        return {
          ok: false,
          authMode: 'supabase_gateway_jwt+app_session',
          httpStatus: res.status,
          error: json?.code || 'OPS_APP_ERROR'
        };
      }
      return {
        ok: true,
        authMode: 'supabase_gateway_jwt+app_session',
        httpStatus: res.status,
        error: null,
        schemaVersion: json.rules?.schemaVersion || null,
        callerRole: json.caller?.role || null
      };
    } catch {
      clearTimeout(timeoutId);
      return { ok: false, authMode: 'supabase_gateway_jwt+app_session', httpStatus: null, error: 'OPS_HEALTH_UNAVAILABLE' };
    }
  }

  const opsBase = url.replace(/\/api-core\/?$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetcher(`${opsBase}/health`, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      return { ok: false, authMode: 'cloudflare_worker', httpStatus: res.status, error: `HTTP_${res.status}` };
    }
    const data = await res.json();
    return {
      ok: Boolean(data?.ok),
      authMode: 'cloudflare_worker',
      httpStatus: res.status,
      error: data?.ok ? null : 'OPS_HEALTH_FALSE'
    };
  } catch {
    clearTimeout(timeoutId);
    return { ok: false, authMode: 'cloudflare_worker', httpStatus: null, error: 'OPS_HEALTH_UNAVAILABLE' };
  }
}

const OPS_RULES_CACHE = new Map();
const OPS_RULES_TTL_MS = 60 * 1000;

export function clearOpsOrderRulesCache() {
  OPS_RULES_CACHE.clear();
}

export function getCachedOpsOrderRules(opsUrl, opsToken) {
  if (!opsUrl || !opsToken) return DEFAULT_OPS_ORDER_RULES;
  const cacheKey = `${opsUrl}::${opsToken.slice(0, 8)}`;
  const cached = OPS_RULES_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < OPS_RULES_TTL_MS) {
    return cached.rules;
  }
  return DEFAULT_OPS_ORDER_RULES;
}

/**
 * Fetch order validation rules from OPS shared source (`getOrderRules`), with short cache
 * and graceful fallback to DEFAULT_OPS_ORDER_RULES when OPS hasn't exposed the route yet.
 */
export async function fetchOpsOrderRules(opsUrl, opsToken, fetcher = fetch, { forceRefresh = false, opsApiKey = '' } = {}) {
  if (!opsUrl || !opsToken) {
    return { ok: true, source: 'default', rules: DEFAULT_OPS_ORDER_RULES };
  }
  const cacheKey = `${opsUrl}::${opsToken.slice(0, 8)}`;
  const cached = OPS_RULES_CACHE.get(cacheKey);
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt) < OPS_RULES_TTL_MS) {
    return { ok: true, source: cached.source, rules: cached.rules, caller: cached.caller || null, cached: true };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetcher(opsUrl, {
      method: 'POST',
      headers: buildOpsHeaders(opsToken, opsApiKey),
      body: JSON.stringify({
        name: 'getOrderRules',
        payload: { token: opsToken }
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      return { ok: true, source: 'fallback', rules: cached?.rules || DEFAULT_OPS_ORDER_RULES };
    }
    const json = await res.json();
    if (json?.ok && json?.rules && typeof json.rules === 'object') {
      const merged = { ...DEFAULT_OPS_ORDER_RULES, ...json.rules };
      const caller = json.caller && typeof json.caller === 'object' ? json.caller : null;
      OPS_RULES_CACHE.set(cacheKey, { source: 'ops', rules: merged, caller, fetchedAt: Date.now() });
      return { ok: true, source: 'ops', rules: merged, caller };
    }
  } catch {
    clearTimeout(timeoutId);
  }
  return { ok: true, source: 'fallback', rules: cached?.rules || DEFAULT_OPS_ORDER_RULES };
}

/**
 * Call OPS createOrder endpoint.
 * @param {string} opsUrl - Base URL of OPS Staging (e.g. https://meehoasg-ops-staging.meehoasg.workers.dev/api-core)
 * @param {string} opsToken - Authentication token for OPS
 * @param {object} draft - Draft order object
 * @param {Array<{data: string}>} sampleFiles - Sample flower image files (base64 Data URLs)
 * @param {Array<{data: string}>} unverifiedBillFiles - Bill image files (base64 Data URLs)
 * @param {Function} [fetcher=fetch] - Fetch implementation (injectable for testing)
 * @param {object} [options] - Optional overrides (e.g. expectedBillCount when bills are linked via R2)
 * @returns {Promise<{ok: boolean, orderId?: string, order?: object, message?: string, code?: string, unverifiedBillCount?: number}>}
 */
export async function callCreateOrder(opsUrl, opsToken, draft, sampleFiles = [], unverifiedBillFiles = [], fetcher = fetch, options = {}) {
  const f = draft.fields || {};
  const noteParts = [];
  const cleanedUserNote = stripPaymentClaimTags(f.note);
  if (cleanedUserNote) noteParts.push(cleanedUserNote);

  const effectiveBillCount = Math.max(
    unverifiedBillFiles.length,
    Number(options?.expectedBillCount) || 0
  );
  if (effectiveBillCount > 0 && !noteParts.some(p => p.includes('bill chưa xác minh'))) {
    noteParts.push(`[🧾 Đính kèm ${effectiveBillCount} bill chưa xác minh]`);
  }

  const note = noteParts.join(' ');

  // Construct payload adhering strictly to OPS createOrder schema (providing both camelCase & snake_case)
  const payload = {
    name: 'createOrder',
    payload: {
      token: opsToken,
      requestId: draft.requestId,
      order: {
        customer: String(f.customer || '').trim(),
        phone: String(f.phone || '').trim(),
        date: String(f.date || '').trim(),
        order_date: String(f.date || '').trim(),
        time: String(f.time || '').trim(),
        order_time: String(f.time || '').trim(),
        flower: String(f.flower || '').trim(),
        note: note,
        shipping: String(f.shipping || '').trim(),
        address: String(f.address || '').trim(),
        flowerTotal: Number(f.flowerTotal) || 0,
        flower_total: Number(f.flowerTotal) || 0,
        // Owner-verified payment state ('Chưa thanh toán', 'Đã cọc <X> đ', 'Đã thanh toán đủ tiền hoa (Full)')
        // Strict invariant: fullPaidRequested remains false (Full Paid requires bill + ship confirmation in OPS)
        payment: mapPaymentToOps(f.paymentState, f.depositAmount, f.flowerTotal),
        sale: String(f.sale || DEFAULT_BOT_SALE).trim(),
        card: Boolean(f.card),
        cardQty: f.card ? Math.max(1, Number(f.cardQty) || 1) : 0,
        card_qty: f.card ? Math.max(1, Number(f.cardQty) || 1) : 0,
        cardText: String(f.cardText || '').trim(),
        card_text: String(f.cardText || '').trim(),
        banner: Boolean(f.banner),
        bannerQty: f.banner ? Math.max(1, Number(f.bannerQty) || 1) : 0,
        banner_qty: f.banner ? Math.max(1, Number(f.bannerQty) || 1) : 0,
        bannerText: String(f.bannerText || '').trim(),
        banner_text: String(f.bannerText || '').trim(),
        charmFee: Number(f.charmFee) || 0,
        charm_fee: Number(f.charmFee) || 0,
        charmText: String(f.charmText || '').trim(),
        charm_text: String(f.charmText || '').trim(),
        paperFee: Number(f.paperFee) || 0,
        paper_fee: Number(f.paperFee) || 0,
        paperText: String(f.paperText || '').trim(),
        paper_text: String(f.paperText || '').trim(),
        vat: Number(f.vat) || 0,
        shipFee: (f.shipping === 'Shop book ship' && Number(f.shipFee) > 0) ? Number(f.shipFee) : 0,
        ship_fee: (f.shipping === 'Shop book ship' && Number(f.shipFee) > 0) ? Number(f.shipFee) : 0,
        shipFeeActive: (f.shipping === 'Shop book ship' && Number(f.shipFee) > 0) ? '1' : '0',
        ship_confirmed: f.shipping === 'Shop book ship' && Number(f.shipFee) > 0,
        // STRICT INVARIANT: No auto-full-paid without OPS bill verification
        fullPaidRequested: false,
        imageFiles: sampleFiles,
        unverifiedBillFiles: unverifiedBillFiles
      }
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetcher(opsUrl, {
      method: 'POST',
      headers: buildOpsHeaders(opsToken, options?.opsApiKey || ''),
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        ok: false,
        code: `HTTP_${res.status}`,
        message: `Hệ thống OPS phản hồi mã lỗi HTTP ${res.status}.`
      };
    }

    const json = await res.json();
    return {
      ok: Boolean(json.ok),
      orderId: json.orderId || json.order?.id || json.row?.id || null,
      order: json.order || json.row || null,
      code: json.code || null,
      message: json.message || (json.ok ? 'Đã tạo đơn thành công.' : 'Tạo đơn thất bại.'),
      unverifiedBillCount: effectiveBillCount,
      sampleCount: sampleFiles.length
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === 'AbortError';
    return {
      ok: false,
      code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: isTimeout
        ? 'Kết nối tới OPS bị quá thời gian (timeout). Vui lòng kiểm tra lại trạng thái đơn trước khi thử lại.'
        : 'Không thể kết nối đến OPS do lỗi mạng.'
    };
  }
}

/**
 * Fetch current decorated order state from OPS API.
 */
export async function callGetOrder(opsUrl, opsToken, orderId, fetcher = fetch, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetcher(opsUrl, {
      method: 'POST',
      headers: buildOpsHeaders(opsToken, options?.opsApiKey || ''),
      body: JSON.stringify({
        name: 'getOrder',
        payload: {
          token: opsToken,
          orderId: String(orderId || '').trim()
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return { ok: false, code: `HTTP_${res.status}`, message: `OPS phản hồi mã lỗi HTTP ${res.status}.` };
    }

    const json = await res.json();
    return {
      ok: Boolean(json.ok),
      order: json.order || null,
      code: json.code || null,
      message: json.message || (json.ok ? 'OK' : 'Không đọc được thông tin đơn từ OPS.')
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === 'AbortError';
    return {
      ok: false,
      code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: isTimeout ? 'Quá thời gian khi đọc trạng thái đơn từ OPS.' : 'Lỗi mạng khi đọc trạng thái đơn từ OPS.'
    };
  }
}

/**
 * Update an existing OPS order's payment string through canonical OPS `updateOrder` RPC
 * using OCC (`expectedUpdatedAt`) and idempotency key (`requestId`).
 * Omits `imageUrls` so OPS retains existing `current.image_urls` without re-uploading.
 */
export async function callUpdateOrderPayment(opsUrl, opsToken, orderId, currentOrder, paymentStr, requestId, cleanNote, fetcher = fetch, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  const shipFeeActive = (String(currentOrder.shipping || '').toLowerCase().includes('shop') && currentOrder.shipConfirmed)
    ? '1'
    : '0';

  const payload = {
    name: 'updateOrder',
    payload: {
      token: opsToken,
      orderId: String(orderId || '').trim(),
      expectedUpdatedAt: currentOrder.updatedAt || '',
      requestId: String(requestId || '').trim(),
      order: {
        customer: String(currentOrder.customer || '').trim(),
        phone: String(currentOrder.phone || '').trim(),
        date: String(currentOrder.date || '').trim(),
        time: String(currentOrder.time || '').trim(),
        flower: String(currentOrder.flower || '').trim(),
        note: cleanNote !== undefined ? String(cleanNote).trim() : stripPaymentClaimTags(currentOrder.note),
        shipping: String(currentOrder.shipping || '').trim(),
        address: String(currentOrder.address || '').trim(),
        flowerTotal: Number(currentOrder.flowerTotal) || 0,
        payment: paymentStr,
        sale: String(currentOrder.saleUsername || currentOrder.sale || DEFAULT_BOT_SALE).trim(),
        card: Boolean(currentOrder.card),
        cardQty: currentOrder.card ? Math.max(1, Number(currentOrder.cardQty) || 1) : 0,
        card_qty: currentOrder.card ? Math.max(1, Number(currentOrder.cardQty) || 1) : 0,
        cardText: String(currentOrder.cardText || '').trim(),
        banner: Boolean(currentOrder.banner),
        bannerQty: currentOrder.banner ? Math.max(1, Number(currentOrder.bannerQty) || 1) : 0,
        banner_qty: currentOrder.banner ? Math.max(1, Number(currentOrder.bannerQty) || 1) : 0,
        bannerText: String(currentOrder.bannerText || '').trim(),
        charmFee: Number(currentOrder.charmFee) || 0,
        charmText: String(currentOrder.charmText || '').trim(),
        paperFee: Number(currentOrder.paperFee) || 0,
        paperText: String(currentOrder.paperText || '').trim(),
        vat: Number(currentOrder.vat) || 0,
        shipFee: Number(currentOrder.shipFee) || 0,
        shipFeeActive,
        ship_confirmed: shipFeeActive === '1',
        fullPaidRequested: false
      }
    }
  };

  try {
    const res = await fetcher(opsUrl, {
      method: 'POST',
      headers: buildOpsHeaders(opsToken, options?.opsApiKey || ''),
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return { ok: false, code: `HTTP_${res.status}`, message: `OPS phản hồi mã lỗi HTTP ${res.status} khi cập nhật thanh toán.` };
    }

    const json = await res.json();
    return {
      ok: Boolean(json.ok),
      orderId: json.orderId || orderId,
      order: json.order || json.row || null,
      idempotent: Boolean(json.idempotent),
      code: json.code || null,
      message: json.message || (json.ok ? 'Đã cập nhật thanh toán.' : 'Không thể cập nhật thanh toán trên OPS.')
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === 'AbortError';
    return {
      ok: false,
      code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: isTimeout ? 'Quá thời gian khi ghi nhận thanh toán lên OPS.' : 'Lỗi mạng khi ghi nhận thanh toán lên OPS.'
    };
  }
}

/**
 * Safely synchronize payment state to an already-created OPS order via `getOrder` + `updateOrder`.
 * Enforces double-deposit / settled-order guard and idempotent OCC updates.
 */
export async function syncOrderPaymentToOps({
  opsUrl,
  opsToken,
  opsApiKey = '',
  orderId,
  expectedPayment,
  expectedPaid = 0,
  requestId,
  cleanNote,
  fetcher = fetch
}) {
  const getRes = await callGetOrder(opsUrl, opsToken, orderId, fetcher, { opsApiKey });
  if (!getRes.ok || !getRes.order) {
    return {
      ok: false,
      code: getRes.code || 'GET_ORDER_FAILED',
      message: getRes.message || 'Không đọc được đơn từ OPS để đồng bộ thanh toán.'
    };
  }

  const current = getRes.order;

  // Double-deposit / finalized-order guard: never overwrite settled, Full Paid, or already-recorded higher payment
  if (current.settled || current.fullPaid) {
    return {
      ok: true,
      alreadySettled: true,
      order: current,
      message: 'Đơn đã tất toán trên OPS.'
    };
  }

  const currentPaid = Number(current.paid) || 0;
  const currentPayment = String(current.payment || '').trim();
  const noteHasLegacyClaim = /\[Khách báo:/i.test(String(current.note || ''));
  if (currentPayment === expectedPayment && currentPaid === expectedPaid && !noteHasLegacyClaim) {
    return {
      ok: true,
      alreadyRecorded: true,
      order: current,
      message: 'Khoản thanh toán đã được ghi nhận trên OPS.'
    };
  }
  if (expectedPaid > 0 && currentPaid >= expectedPaid && !noteHasLegacyClaim) {
    return {
      ok: true,
      alreadyRecorded: true,
      order: current,
      message: 'Số tiền đã thu trên OPS đã đạt mức cần ghi.'
    };
  }

  return callUpdateOrderPayment(
    opsUrl,
    opsToken,
    orderId,
    current,
    expectedPayment,
    requestId,
    cleanNote !== undefined ? cleanNote : stripPaymentClaimTags(current.note),
    fetcher,
    { opsApiKey }
  );
}
