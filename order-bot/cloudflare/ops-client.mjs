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
 * - Supabase Production: probes `POST getOrderRules` first with Gateway Auth + App Session token;
 *   when live OPS v33 delegates unknown `getOrderRules` to `meehoasg-api` ("Thao tác không được hỗ trợ."),
 *   falls back to lightweight read-only `getOrder` (`__BOT_HEALTH_CHECK__`) directly on `meehoasg-api-core`
 *   to verify Gateway JWT, `app_sessions` expiry, `app_users.active`, and `THO_OPS/ADMIN/SALE` role.
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
    const classifyAppAuthError = (json, httpStatus) => {
      const msg = String(json?.message || '');
      const inferredCode = /phiên đăng nhập|hết hạn|invalid jwt|unauthorized/i.test(msg)
        ? 'OPS_SESSION_EXPIRED'
        : (/bị khóa/i.test(msg)
          ? 'OPS_ACCOUNT_LOCKED'
          : (/không có quyền|forbidden/i.test(msg) ? 'OPS_FORBIDDEN' : (json?.code || 'OPS_APP_ERROR')));
      return {
        ok: false,
        authMode: 'supabase_gateway_jwt+app_session',
        httpStatus,
        error: inferredCode,
        message: msg || null
      };
    };

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
      if (json?.ok) {
        return {
          ok: true,
          authMode: 'supabase_gateway_jwt+app_session',
          httpStatus: res.status,
          error: null,
          schemaVersion: json.rules?.schemaVersion || null,
          callerRole: json.caller?.role || null,
          apiCompatibility: 'getOrderRules'
        };
      }

      const rulesMsg = String(json?.message || '');
      if (!/không được hỗ trợ/i.test(rulesMsg)) {
        return classifyAppAuthError(json, res.status);
      }

      // Live Production meehoasg-api-core v33 compatibility probe:
      // verify session/role directly on `meehoasg-api-core` via read-only `getOrder`.
      const compatController = new AbortController();
      const compatTimeout = setTimeout(() => compatController.abort(), 5000);
      try {
        const probeRes = await fetcher(url, {
          method: 'POST',
          headers: buildOpsHeaders(opsToken, gatewayKey),
          body: JSON.stringify({
            name: 'getOrder',
            payload: { token: opsToken, orderId: '__BOT_HEALTH_CHECK__' }
          }),
          signal: compatController.signal
        });
        clearTimeout(compatTimeout);
        if (!probeRes.ok) {
          return {
            ok: false,
            authMode: 'supabase_gateway_jwt+app_session',
            httpStatus: probeRes.status,
            error: probeRes.status === 401 ? 'GATEWAY_UNAUTHORIZED' : `HTTP_${probeRes.status}`
          };
        }
        const probeJson = await probeRes.json();
        if (probeJson?.ok || (!probeJson?.code && /không tìm thấy đơn/i.test(String(probeJson?.message || '')))) {
          return {
            ok: true,
            authMode: 'supabase_gateway_jwt+app_session',
            httpStatus: probeRes.status,
            error: null,
            schemaVersion: DEFAULT_OPS_ORDER_RULES.schemaVersion,
            callerRole: 'THO_OPS_OR_COMPAT',
            apiCompatibility: 'live_v33'
          };
        }
        return classifyAppAuthError(probeJson, probeRes.status);
      } catch {
        clearTimeout(compatTimeout);
        return { ok: false, authMode: 'supabase_gateway_jwt+app_session', httpStatus: null, error: 'OPS_HEALTH_UNAVAILABLE' };
      }
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

const MAX_DIRECT_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;
const DIRECT_UPLOAD_EXPIRY_BUFFER_MS = 15 * 1000;

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  try {
    const raw = atob(match[2].replace(/\s+/g, ''));
    if (!raw.length || raw.length > MAX_DIRECT_UPLOAD_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { mimeType, bytes };
  } catch {
    return null;
  }
}

function makeUploadClaim(part) {
  return {
    path: part.path,
    storage: part.storage || 'supabase',
    expiresAt: part.expiresAt,
    proof: part.proof,
    ...(part.backup ? {
      backup: {
        path: part.backup.path,
        storage: 'supabase',
        expiresAt: part.backup.expiresAt,
        proof: part.backup.proof
      }
    } : {})
  };
}

async function putStagedImage(bytes, uploadUrl, storage, uploadFetcher) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = storage === 'r2'
      ? { 'Content-Type': 'image/jpeg' }
      : { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' };
    const res = await uploadFetcher(uploadUrl, {
      method: 'PUT',
      headers,
      body: bytes,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      if (storage !== 'supabase' || res.status !== 400 || !/already exists/i.test(errorText)) {
        return { ok: false, code: `UPLOAD_HTTP_${res.status}` };
      }
    }
    return { ok: true };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, code: err?.name === 'AbortError' ? 'UPLOAD_TIMEOUT' : 'UPLOAD_NETWORK_ERROR' };
  }
}

async function putStagedUploadPart(bytes, part, uploadFetcher) {
  if (!part?.uploadUrl || !part?.proof || !part?.path) {
    return { ok: false, code: 'UPLOAD_TICKET_INVALID' };
  }
  const primary = await putStagedImage(bytes, part.uploadUrl, part.storage || 'supabase', uploadFetcher);
  if (!primary.ok) return primary;
  if (part.backup) {
    if (part.backup.path !== part.path || !part.backup.uploadUrl || !part.backup.proof) {
      return { ok: false, code: 'UPLOAD_BACKUP_TICKET_INVALID' };
    }
    const backup = await putStagedImage(bytes, part.backup.uploadUrl, 'supabase', uploadFetcher);
    if (!backup.ok) return backup;
  }
  return { ok: true };
}

/**
 * Upload JPEG sample images through OPS `prepareOrderUploads` -> direct R2/Storage PUT
 * (uploading BOTH `<uuid>.jpg` and `<uuid>.preview.jpg`) so OPS thumbnails render immediately
 * without modifying OPS v33 API or web code.
 */
export async function prepareAndUploadOrderSamples({
  opsUrl,
  opsToken,
  opsApiKey = '',
  requestId,
  sampleFiles = [],
  cachedStagedUpload = null,
  fetcher = fetch,
  uploadFetcher = null
}) {
  const jpegSamples = [];
  const nonJpegSamples = [];
  for (const item of sampleFiles || []) {
    if (/^data:image\/jpeg;base64,/i.test(String(item?.data || ''))) {
      jpegSamples.push(item);
    } else {
      nonJpegSamples.push(item);
    }
  }

  if (!jpegSamples.length) {
    return { ok: true, mode: 'legacy', reused: false, imageFiles: sampleFiles, preuploadedSamples: [], stagedOpsUpload: null };
  }

  // Reuse already-uploaded claims for idempotent retries with the same requestId
  if (
    cachedStagedUpload &&
    cachedStagedUpload.requestId === requestId &&
    Number(cachedStagedUpload.sampleCount) === jpegSamples.length &&
    Array.isArray(cachedStagedUpload.preuploadedSamples) &&
    cachedStagedUpload.preuploadedSamples.length === jpegSamples.length &&
    Number(cachedStagedUpload.expiresAt) > Date.now() + DIRECT_UPLOAD_EXPIRY_BUFFER_MS
  ) {
    return {
      ok: true,
      mode: 'preuploaded',
      reused: true,
      imageFiles: nonJpegSamples,
      preuploadedSamples: cachedStagedUpload.preuploadedSamples,
      stagedOpsUpload: cachedStagedUpload
    };
  }

  const parsedJpegs = jpegSamples.map(item => {
    const original = parseImageDataUrl(item?.data);
    const parsedPreview = item?.previewData ? parseImageDataUrl(item.previewData) : null;
    const previewBytes = (parsedPreview && parsedPreview.mimeType === 'image/jpeg')
      ? parsedPreview.bytes
      : original?.bytes || null;
    return { originalBytes: original?.bytes || null, previewBytes };
  });
  if (parsedJpegs.some(p => !p.originalBytes || !p.previewBytes)) {
    return { ok: false, code: 'IMAGE_INVALID', message: 'File ảnh mẫu không hợp lệ hoặc vượt quá 5 MB.' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetcher(opsUrl, {
      method: 'POST',
      headers: buildOpsHeaders(opsToken, opsApiKey),
      body: JSON.stringify({
        name: 'prepareOrderUploads',
        payload: {
          token: opsToken,
          requestId,
          samples: jpegSamples.length,
          bills: 0
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError';
    return {
      ok: false,
      code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: isTimeout
        ? 'Quá thời gian khi xin quyền tải ảnh mẫu lên OPS. Vui lòng thử lại.'
        : 'Không thể kết nối đến OPS để tải ảnh mẫu do lỗi mạng.'
    };
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  const msg = String(json?.message || '');
  if (res.status === 401) {
    return { ok: false, code: 'HTTP_401', message: 'Hệ thống OPS phản hồi mã lỗi HTTP 401.' };
  }
  if (json?.code === 'AUTH_REQUIRED' || /phiên đăng nhập|hết hạn|bị khóa|không có quyền/i.test(msg)) {
    return { ok: false, code: json?.code || 'AUTH_REQUIRED', message: msg || 'Phiên đăng nhập OPS không hợp lệ hoặc đã hết hạn.' };
  }

  // Only fall back to legacy `imageFiles` when the upstream explicitly does not implement `prepareOrderUploads`
  // (e.g., isolated test mocks or non-R2 staging endpoints). Live Production meehoasg-api-core v33 implements it.
  if (
    (!res.ok && (json?.code === 'UNSUPPORTED' || /không được hỗ trợ|\bunsupported\b/i.test(msg))) ||
    (json && json.ok === false && (json.code === 'UNSUPPORTED' || /không được hỗ trợ|\bunsupported\b/i.test(msg)))
  ) {
    return { ok: true, mode: 'legacy', reused: false, imageFiles: sampleFiles, preuploadedSamples: [], stagedOpsUpload: null };
  }

  if (!res.ok) {
    return {
      ok: false,
      code: `HTTP_${res.status}`,
      message: `Hệ thống OPS phản hồi mã lỗi HTTP ${res.status} khi chuẩn bị tải ảnh.`
    };
  }

  const tickets = json?.ok && Array.isArray(json.tickets) ? json.tickets : null;
  if (!tickets || tickets.length !== jpegSamples.length) {
    return {
      ok: false,
      code: json?.code || 'UPLOAD_TICKETS_INVALID',
      message: msg || 'Không cấp được quyền tải ảnh mẫu lên OPS.'
    };
  }

  const doPutFetch = uploadFetcher || fetcher;
  for (let offset = 0; offset < tickets.length; offset += 3) {
    const batch = tickets.slice(offset, offset + 3).map(async (ticket, idx) => {
      const sample = parsedJpegs[offset + idx];
      if (!ticket || ticket.kind !== 'sample' || !ticket.uploadUrl || !ticket.proof || !ticket.preview?.uploadUrl || !ticket.preview?.proof) {
        return { ok: false, code: 'UPLOAD_TICKET_INVALID' };
      }
      const previewPut = await putStagedUploadPart(sample.previewBytes, ticket.preview, doPutFetch);
      if (!previewPut.ok) return previewPut;
      const originalPut = await putStagedUploadPart(sample.originalBytes, ticket, doPutFetch);
      if (!originalPut.ok) return originalPut;
      return { ok: true };
    });
    const results = await Promise.all(batch);
    const failed = results.find(r => !r.ok);
    if (failed) {
      return {
        ok: false,
        code: failed.code || 'UPLOAD_FAILED',
        message: 'Không thể tải ảnh mẫu (kèm ảnh thu nhỏ) lên kho ảnh OPS. Vui lòng thử lại.'
      };
    }
  }

  const preuploadedSamples = tickets.map(ticket => ({
    ...makeUploadClaim(ticket),
    preview: makeUploadClaim(ticket.preview)
  }));
  const expiryCandidates = tickets
    .flatMap(t => [Number(t.expiresAt) || 0, Number(t.preview?.expiresAt) || 0])
    .filter(n => n > 0);
  const expiresAt = expiryCandidates.length ? Math.min(...expiryCandidates) : Date.now() + 10 * 60 * 1000;

  return {
    ok: true,
    mode: 'preuploaded',
    reused: false,
    imageFiles: nonJpegSamples,
    preuploadedSamples,
    stagedOpsUpload: {
      requestId,
      sampleCount: jpegSamples.length,
      preuploadedSamples,
      expiresAt
    }
  };
}

/**
 * Call OPS createOrder endpoint.
 * @param {string} opsUrl - Base URL of OPS Staging (e.g. https://meehoasg-ops-staging.meehoasg.workers.dev/api-core)
 * @param {string} opsToken - Authentication token for OPS
 * @param {object} draft - Draft order object
 * @param {Array<{data: string, previewData?: string}>} sampleFiles - Sample flower image files (base64 Data URLs)
 * @param {Array<{data: string}>} unverifiedBillFiles - Bill image files (base64 Data URLs)
 * @param {Function} [fetcher=fetch] - Fetch implementation (injectable for testing)
 * @param {object} [options] - Optional overrides (e.g. expectedBillCount, opsApiKey, cachedStagedUpload, onStagedUpload)
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
  const opsApiKey = String(options?.opsApiKey || '').trim();
  const shouldUseDirectUpload = sampleFiles.length > 0 &&
    options?.disableDirectUpload !== true &&
    (isSupabaseOpsUrl(opsUrl) || Boolean(opsApiKey));

  let imageFilesToSend = sampleFiles.map(item => ({ data: item.data }));
  let preuploadedSamples = null;
  let stagedOpsUpload = null;

  if (shouldUseDirectUpload) {
    const prepared = await prepareAndUploadOrderSamples({
      opsUrl,
      opsToken,
      opsApiKey,
      requestId: draft.requestId,
      sampleFiles,
      cachedStagedUpload: options?.cachedStagedUpload || draft?.stagedOpsUpload || null,
      fetcher,
      uploadFetcher: options?.uploadFetcher || null
    });
    if (!prepared.ok) {
      return {
        ok: false,
        code: prepared.code || 'UPLOAD_FAILED',
        message: prepared.message || 'Không thể tải ảnh mẫu lên OPS.'
      };
    }
    if (prepared.mode === 'preuploaded') {
      imageFilesToSend = prepared.imageFiles.map(item => ({ data: item.data }));
      preuploadedSamples = prepared.preuploadedSamples;
      stagedOpsUpload = prepared.stagedOpsUpload;
      if (!prepared.reused && typeof options?.onStagedUpload === 'function') {
        await options.onStagedUpload(stagedOpsUpload);
      }
    }
  }

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
        imageFiles: imageFilesToSend,
        ...(preuploadedSamples ? { preuploadedSamples } : {}),
        unverifiedBillFiles: unverifiedBillFiles
      }
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetcher(opsUrl, {
      method: 'POST',
      headers: buildOpsHeaders(opsToken, opsApiKey),
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
      sampleCount: sampleFiles.length,
      usedPreuploadedSamples: Boolean(preuploadedSamples),
      stagedOpsUpload
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
