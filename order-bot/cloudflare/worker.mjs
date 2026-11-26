/**
 * MEEHOA Order Bot V1 — Cloudflare Worker Entrypoint
 *
 * Serverless Telegram Webhook handler running on Cloudflare Workers edge.
 * Integrates:
 *   - Telegram Webhook (authentication, update deduplication, private-chat security)
 *   - Cloudflare D1 (persistent drafts, per-user concurrency locking, audit logs)
 *   - Cloudflare R2 (storage for sample flower photos and unverified bill photos)
 *   - Gemini AI (conversational text extraction with fallback)
 *   - MEEHOA OPS Staging (order creation with idempotent retry protection)
 */

import {
  normalizeMoney,
  normalizeDate,
  normalizeTime,
  normalizeShipping,
  detectPromptInjection,
  isBillCaption,
  cmdNew,
  cmdList,
  cmdSelect,
  cmdShow,
  cmdCancel,
  cmdConfirm,
  addSampleRef,
  addBillRef,
  activeDraft,
  isDraftEmpty,
  classifyIncomingPhotoDraft,
  computeDraftTotal,
  mapPaymentToOps,
  stripPaymentClaimTags,
  applyFields,
  draftSummary,
  requiredMissing,
  validateOrderAgainstRules,
  DEFAULT_BOT_SALE,
  DEFAULT_OPS_ORDER_RULES,
  formatSaleDisplay
} from '../core.mjs';

import {
  loadDrafts,
  saveDrafts,
  withLock,
  isUpdateProcessed,
  markUpdateProcessed,
  findStaleConfirming,
  resetStaleConfirming,
  logAudit,
  linkUnverifiedBillsToD1Order
} from './d1-store.mjs';

import {
  verifySecretHeader,
  verifyWebhookSecret,
  sendTelegramMessage,
  downloadTelegramPhoto,
  savePhotoToR2,
  deletePhotoFromR2,
  bytesToBase64
} from './telegram.mjs';

import { callCreateOrder, syncOrderPaymentToOps, fetchOpsOrderRules, getCachedOpsOrderRules } from './ops-client.mjs';
import {
  extractFieldsWithGeminiDetailed,
  sanitizeAiFields,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS
} from './gemini.mjs';

const DEFAULT_ALLOWED_USER_ID = 5252724920;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OPS_PAYLOAD_BYTES = Math.floor(11.5 * 1024 * 1024);
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const replyTg = (env, chatId, text, parseMode = null) =>
  sendTelegramMessage(env.BOT_TOKEN, chatId, text, parseMode, env.TELEGRAM_FETCHER || fetch);

const downloadTgPhoto = (env, fileId, maxBytes = MAX_IMAGE_BYTES) =>
  downloadTelegramPhoto(env.BOT_TOKEN, fileId, maxBytes, env.TELEGRAM_FETCHER || fetch);

const ALLOWED_GEMINI_PROXY_PREFIXES = [
  'https://generativelanguage.googleapis.com/',
  'https://aiplatform.googleapis.com/'
];

/**
 * Durable Object acting as a clean outbound proxy in US-West (`locationHint: "wnam"`)
 * so Gemini API requests NEVER egress from Cloudflare's HKG PoP (blocked by AI Studio).
 * Compatible with plain Workers Free SQLite Durable Objects and Node.js unit test imports.
 */
export class GeminiEgressProxy {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const targetUrl = String(request.headers.get('x-gemini-target-url') || '').trim();
    if (!ALLOWED_GEMINI_PROXY_PREFIXES.some(prefix => targetUrl.startsWith(prefix))) {
      return new Response(JSON.stringify({ error: { code: 400, message: 'INVALID_GEMINI_TARGET' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const apiKey = request.headers.get('x-goog-api-key') || this.env?.GEMINI_API_KEY || '';
    const bodyText = await request.text();
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-goog-api-key': apiKey } : {})
      },
      body: bodyText,
      signal: AbortSignal.timeout(35000)
    });

    const outHeaders = new Headers();
    const ct = upstream.headers.get('content-type');
    if (ct) outHeaders.set('content-type', ct);
    const ra = upstream.headers.get('retry-after');
    if (ra) outHeaders.set('retry-after', ra);
    outHeaders.set('x-gemini-proxy-colo', String(request.cf?.colo || 'do-wnam'));

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders
    });
  }
}

export function resolveGeminiFetcher(env) {
  if (env?.GEMINI_FETCHER) return env.GEMINI_FETCHER;
  if (env?.GEMINI_EGRESS_DO && typeof env.GEMINI_EGRESS_DO.idFromName === 'function') {
    return async (targetUrl, opts = {}) => {
      const id = env.GEMINI_EGRESS_DO.idFromName('gemini-egress-wnam-v1');
      const stub = env.GEMINI_EGRESS_DO.get(id, { locationHint: 'wnam' });
      const headers = {
        'Content-Type': 'application/json',
        'x-gemini-target-url': String(targetUrl)
      };
      const apiKey = opts?.headers?.['x-goog-api-key'] || opts?.headers?.['X-Goog-Api-Key'] || '';
      if (apiKey) headers['x-goog-api-key'] = apiKey;

      const doPromise = stub.fetch('https://gemini-egress.internal/proxy', {
        method: 'POST',
        headers,
        body: opts?.body
      });
      if (!opts?.signal) return doPromise;
      return new Promise((resolve, reject) => {
        if (opts.signal.aborted) {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          reject(e);
          return;
        }
        const onAbort = () => {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          reject(e);
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        doPromise.then(
          res => { opts.signal.removeEventListener('abort', onAbort); resolve(res); },
          err => { opts.signal.removeEventListener('abort', onAbort); reject(err); }
        );
      });
    };
  }
  return fetch;
}

function formatAiFailureNotice(aiRes) {
  if (!aiRes || aiRes.ok) return null;
  const status = Number(aiRes.status);
  const err = String(aiRes.error || 'UNKNOWN');
  if (status === 429 || /RESOURCE_EXHAUSTED|QUOTA/i.test(err)) {
    return '⚠️ AI đang tạm hết hạn mức (HTTP 429). Ảnh mẫu và chú thích vẫn được giữ nguyên trong nháp — bạn có thể gõ /reparse sau ít phút để đọc lại cùng nháp hoặc bổ sung thủ công.';
  }
  if ([400, 401, 403, 404].includes(status) || err === 'NO_API_KEY') {
    return `⚠️ Dịch vụ AI đang gặp lỗi cấu hình/xác thực (${status ? 'HTTP ' + status : err}). Ảnh mẫu và chú thích vẫn được giữ nguyên trong nháp — vui lòng nhập bổ sung thủ công các trường còn thiếu.`;
  }
  if (err === 'STREAM_INTERRUPTED' || err === 'EMPTY_RESPONSE' || err === 'INVALID_JSON' || aiRes.stage === 'sse_read' || aiRes.stage === 'json_parse') {
    return `⚠️ Phản hồi từ AI bị gián đoạn hoặc chưa đúng định dạng (${err}). Ảnh mẫu và chú thích vẫn được giữ nguyên trong nháp — gõ /reparse để thử đọc lại cùng nháp hoặc bổ sung thủ công.`;
  }
  return `⚠️ AI đang quá tải tạm thời hoặc hết thời gian chờ (${status ? 'HTTP ' + status : err}). Ảnh mẫu và chú thích vẫn được giữ nguyên trong nháp — gõ /reparse để thử đọc lại cùng nháp hoặc bổ sung thủ công.`;
}

const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[char]));

/**
 * Read a stored photo from R2 and return a validated base64 data URL.
 * Fails closed (returns null) if missing, unreadable, oversize, or invalid MIME.
 */
export async function evidenceDataUrl(ref, env) {
  if (!ref?.r2_key || !env?.MEDIA_R2) return null;
  try {
    const object = await env.MEDIA_R2.get(ref.r2_key);
    if (!object) return null;
    const source = typeof object.arrayBuffer === 'function'
      ? await object.arrayBuffer()
      : (object.buffer || object.body);
    if (!source) return null;
    const bytes = source instanceof Uint8Array
      ? source
      : ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const lowerKey = String(ref.r2_key).toLowerCase();
    const type = object.httpMetadata?.contentType || (
      lowerKey.endsWith('.png')
        ? 'image/png'
        : lowerKey.endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg'
    );
    if (!ALLOWED_IMAGE_MIMES.has(type)) return null;
    return `data:${type};base64,${bytesToBase64(bytes)}`;
  } catch {
    console.error('[r2] evidenceDataUrl read failed');
    return null;
  }
}

/**
 * Safely delete R2 images belonging to a cancelled draft.
 * NEVER deletes images from submitted drafts, other active drafts, or any OPS order in D1.
 */
export async function cleanupCancelledDraftMedia(draftToCancel, remainingDrafts, env) {
  if (!env?.MEDIA_R2 || !draftToCancel?.id) return { deleted: [], skipped: [] };
  if (draftToCancel.status === 'submitted' || draftToCancel.opsOrderId) {
    return { deleted: [], skipped: [] };
  }

  const candidateKeys = [
    ...(draftToCancel.sampleRefs || []).map(r => r?.r2_key),
    ...(draftToCancel.draftBillRefs || []).map(r => r?.r2_key)
  ].filter(Boolean);

  if (!candidateKeys.length) return { deleted: [], skipped: [] };

  const ownedSamplePrefix = `order-images/sample-${draftToCancel.id}-`;
  const ownedBillPrefix = `settlement-bills/unverified-${draftToCancel.id}-`;

  // Collect keys still referenced by any other draft
  const referencedByOtherDrafts = new Set();
  for (const [k, d] of Object.entries(remainingDrafts || {})) {
    if (k.startsWith('__') || !d || d.id === draftToCancel.id) continue;
    for (const ref of [...(d.sampleRefs || []), ...(d.draftBillRefs || [])]) {
      if (ref?.r2_key) referencedByOtherDrafts.add(ref.r2_key);
    }
  }

  const deleted = [];
  const skipped = [];

  for (const key of new Set(candidateKeys)) {
    if (!key.startsWith(ownedSamplePrefix) && !key.startsWith(ownedBillPrefix)) {
      skipped.push(key);
      continue;
    }
    if (referencedByOtherDrafts.has(key)) {
      skipped.push(key);
      continue;
    }
    if (env.DB) {
      try {
        const usedInOrders = await env.DB.prepare(
          'SELECT row_key FROM orders WHERE data LIKE ? LIMIT 1'
        ).bind(`%${key}%`).first();
        if (usedInOrders) {
          skipped.push(key);
          continue;
        }
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        if (!msg.includes('no such table')) {
          // On unexpected D1 error, fail safe: do NOT delete R2 object
          skipped.push(key);
          continue;
        }
      }
    }
    const ok = await deletePhotoFromR2(env.MEDIA_R2, key);
    if (ok) deleted.push(key);
    else skipped.push(key);
  }

  return { deleted, skipped };
}

/**
 * Pure transition of draft status without filesystem calls
 */
export function transitionDraftStatus(drafts, draftId, status, extra = {}) {
  const draft = drafts[draftId];
  if (!draft) return drafts;
  return {
    ...drafts,
    [draftId]: {
      ...draft,
      status,
      ...extra,
      updatedAt: new Date().toISOString()
    }
  };
}

export default {
  /**
   * Main fetch router for Cloudflare Worker
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Health check endpoint
    if (path === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        service: 'meehoa-order-bot-staging',
        version: '1.0.0',
        environment: 'staging',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Status / Diagnostics endpoint (Read-only)
    if (path === '/status') {
      try {
        let d1Test = false;
        if (env.DB) {
          const row = await env.DB.prepare('SELECT 1 as alive').first();
          d1Test = row?.alive === 1;
        }

        let opsHealth = false;
        let opsError = null;
        try {
          const fetcher = env.OPS_SERVICE ? env.OPS_SERVICE.fetch.bind(env.OPS_SERVICE) : fetch;
          const opsBase = (env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core').replace(/\/api-core\/?$/, '');
          const opsRes = await fetcher(`${opsBase}/health`, { method: 'GET' });
          if (opsRes.ok) {
            const data = await opsRes.json();
            opsHealth = Boolean(data?.ok);
          } else {
            opsError = `HTTP_${opsRes.status}`;
          }
        } catch {
          opsHealth = false;
          opsError = 'OPS_HEALTH_UNAVAILABLE';
        }

        const stale = env.DB ? await findStaleConfirming(env.DB) : [];
        let lastGeminiCall = null;
        if (env.DB) {
          try {
            const gRow = await env.DB.prepare(
              "SELECT payload_json, created_at FROM bot_audit_logs WHERE action = 'geminiExtract' ORDER BY id DESC LIMIT 1"
            ).first();
            if (gRow?.payload_json) {
              const p = JSON.parse(gRow.payload_json);
              lastGeminiCall = {
                model: p.model || null,
                endpoint: p.endpoint || null,
                ok: Boolean(p.ok),
                status: p.status ?? null,
                headersMs: p.headersMs ?? null,
                latencyMs: Number(p.latencyMs) || 0,
                thoughtParts: Number(p.thoughtParts) || 0,
                textParts: Number(p.textParts) || 0,
                finishReason: p.finishReason || null,
                extractedKeys: Array.isArray(p.extractedKeys) ? p.extractedKeys : [],
                createdAt: gRow.created_at || null
              };
            }
          } catch {
            // Non-critical diagnostic read
          }
        }
        let webhookInfo = null;
        const botToken = env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
          try {
            const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
            if (tgRes.ok) {
              const tgData = await tgRes.json();
              if (tgData.ok) {
                webhookInfo = {
                  url: tgData.result?.url || '',
                  has_custom_certificate: Boolean(tgData.result?.has_custom_certificate),
                  pending_update_count: Number(tgData.result?.pending_update_count) || 0,
                  last_error_date: tgData.result?.last_error_date || null,
                  has_last_error: Boolean(tgData.result?.last_error_message),
                  max_connections: Number(tgData.result?.max_connections) || 40
                };
              }
            }
          } catch {
            webhookInfo = { error: 'WEBHOOK_INFO_UNAVAILABLE' };
          }
        }

        return new Response(JSON.stringify({
          ok: true,
          service: 'meehoa-order-bot-staging',
          environment: 'staging',
          d1Connected: d1Test,
          r2Connected: Boolean(env.MEDIA_R2),
          opsConnected: opsHealth,
          opsError: opsError,
          staleConfirmingDrafts: stale.length,
          telegramConfigured: Boolean(botToken),
          webhookSecretConfigured: Boolean(env.TELEGRAM_SECRET_TOKEN),
          geminiConfigured: Boolean(env.GEMINI_API_KEY),
          geminiModel: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
          lastGeminiCall,
          webhookInfo: webhookInfo,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch {
        return new Response(JSON.stringify({ ok: false, error: 'STATUS_UNAVAILABLE' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 3. AI Probe endpoint (POST /ai-probe) — Staging-only authenticated test harness.
    //    Supports two modes:
    //    - mode: "minimal"  → calls extractFieldsWithGeminiDetailed directly using Worker's GEMINI_API_KEY Secret.
    //    - mode: "bot-flow" → runs the real handleTelegramWebhook flow (caption/photo, Gemini, merge, /reparse,
    //                         deduplication) inside an in-memory D1/R2 sandbox with OPS writes strictly blocked.
    //    Protected by AI_PROBE_TOKEN (x-ai-probe-token) or OPS_TOKEN (x-ops-token). Never weakens /webhook auth.
    if (request.method === 'POST' && path === '/ai-probe') {
      return handleAiProbe(request, env);
    }

    // 4. Telegram Webhook endpoint (POST /webhook or POST /)
    if (request.method === 'POST' && (path === '/webhook' || path === '/' || path === '')) {
      return handleTelegramWebhook(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

function buildProbeFaultFetcher(faultConfig, captionForMock = '') {
  if (!faultConfig) return null;
  const spec = typeof faultConfig === 'string' ? { type: faultConfig } : faultConfig;
  const type = String(spec.type || '').trim();
  let callCount = 0;

  const thmJson = JSON.stringify({
    customer: 'Thảo My',
    flower: 'kệ chúc mừng tông vàng',
    flowerTotal: 650000,
    shipping: 'Shop book ship',
    address: '88 Võ Văn Tần, Quận 3',
    date: '29/12',
    time: '16:00',
    phone: null,
    note: null,
    cardText: null,
    bannerText: null
  });
  const resolveOkText = (reqBodyStr = '') => {
    if (spec.mockJson) return JSON.stringify(spec.mockJson);
    const hasThaoMy = /thảo my|thao my/i.test(captionForMock) || /thảo my|thao my/i.test(reqBodyStr);
    return hasThaoMy
      ? thmJson
      : JSON.stringify({ customer: 'Khách Test', flower: 'Bó hoa test', flowerTotal: 500000, shipping: 'Ghé lấy', date: '29/12', time: '10:00' });
  };
  const sseOk = (reqBodyStr = '') => new Response(
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: resolveOkText(reqBodyStr) }] }, finishReason: 'STOP' }] })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );

  return async (_url, opts) => {
    callCount += 1;
    if (type === '503_then_200') {
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Simulated 503 overload' } }),
          { status: 503, headers: { 'Retry-After': String(spec.retryAfterSec ?? 0) } }
        );
      }
      return sseOk(String(opts?.body || ''));
    }
    if (type === '503_persistent') {
      return new Response(
        JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Simulated persistent 503 overload' } }),
        { status: 503, headers: { 'Retry-After': String(spec.retryAfterSec ?? 0) } }
      );
    }
    if (type === '429' || type === '429_quota') {
      return new Response(
        JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Simulated quota exceeded' } }),
        { status: 429, headers: { 'Retry-After': String(spec.retryAfterSec ?? 0) } }
      );
    }
    if (type === 'timeout') {
      return new Promise((_, reject) => {
        const abortErr = () => {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          reject(e);
        };
        if (opts?.signal?.aborted) { abortErr(); return; }
        opts?.signal?.addEventListener('abort', abortErr, { once: true });
      });
    }
    if (type === 'stream_cut') {
      if (callCount === 1 && !spec.persistent) {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"{\\"customer\\":\\"Thảo"}]}}]}\n\n'));
            controller.error(new Error('Simulated SSE stream reset'));
          }
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (spec.persistent) {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"{\\"customer\\":\\"Thảo"}]}}]}\n\n'));
            controller.error(new Error('Simulated SSE stream reset'));
          }
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return sseOk(String(opts?.body || ''));
    }
    if (type === 'malformed_json') {
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"customer": "Thảo My", BROKEN_JSON' }] }, finishReason: 'STOP' }] })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    return new Response(JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: `Unknown fault type: ${type}` } }), { status: 500 });
  };
}

function createIsolatedProbeEnv(realEnv, userId, initialDraftState = null, probeOptions = {}) {
  const draftRows = new Map();
  if (initialDraftState) {
    draftRows.set(Number(userId), {
      active_draft_id: initialDraftState.activeDraftId || null,
      drafts_json: JSON.stringify(initialDraftState.drafts || {}),
      lock_acquired_at: null
    });
  }
  const processedUpdates = new Set();
  const sandboxAuditLogs = [];
  const r2Objects = new Map();
  const telegramReplies = [];
  const blockedOpsWrites = [];
  const aiCalls = [];

  if (initialDraftState?.sampleR2Keys?.length) {
    const dummyJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    for (const k of initialDraftState.sampleR2Keys) {
      r2Objects.set(k, { body: dummyJpeg, httpMetadata: { contentType: 'image/jpeg' } });
    }
  }

  const sandboxDb = {
    prepare(sql) {
      const bindStmt = (args = []) => ({
        bind: (...a) => bindStmt(a),
        first: async () => {
          if (/SELECT 1 as alive/i.test(sql)) return { alive: 1 };
          if (/FROM bot_drafts WHERE user_id/i.test(sql)) {
            const row = draftRows.get(Number(args[0]));
            return row ? { active_draft_id: row.active_draft_id, drafts_json: row.drafts_json } : null;
          }
          if (/FROM bot_processed_updates WHERE update_id/i.test(sql)) {
            const uid = Number(args[0]);
            return processedUpdates.has(uid) ? { update_id: uid } : null;
          }
          return null;
        },
        all: async () => ({ results: [], success: true, meta: { changes: 0 } }),
        run: async () => {
          if (/INSERT INTO bot_drafts[\s\S]*ON CONFLICT\(user_id\) DO NOTHING/i.test(sql)) {
            const uid = Number(args[0]);
            if (!draftRows.has(uid)) {
              draftRows.set(uid, { active_draft_id: null, drafts_json: '{}', lock_acquired_at: null });
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE bot_drafts\s+SET lock_acquired_at = datetime/i.test(sql)) {
            const uid = Number(args[0]);
            const row = draftRows.get(uid) || { active_draft_id: null, drafts_json: '{}', lock_acquired_at: null };
            row.lock_acquired_at = new Date().toISOString();
            draftRows.set(uid, row);
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE bot_drafts SET lock_acquired_at = NULL/i.test(sql)) {
            const row = draftRows.get(Number(args[0]));
            if (row) row.lock_acquired_at = null;
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT INTO bot_drafts[\s\S]*ON CONFLICT\(user_id\) DO UPDATE/i.test(sql)) {
            const uid = Number(args[0]);
            const prev = draftRows.get(uid) || { lock_acquired_at: null };
            draftRows.set(uid, {
              active_draft_id: args[1] || null,
              drafts_json: String(args[2] || '{}'),
              lock_acquired_at: prev.lock_acquired_at
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT INTO bot_processed_updates/i.test(sql)) {
            processedUpdates.add(Number(args[0]));
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT INTO bot_audit_logs/i.test(sql)) {
            let parsedPayload = null;
            try { parsedPayload = args[4] ? JSON.parse(args[4]) : null; } catch {}
            sandboxAuditLogs.push({
              userId: args[0],
              action: args[1],
              draftId: args[2],
              requestId: args[3],
              payload: parsedPayload
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
      });
      return bindStmt([]);
    }
  };

  const sandboxR2 = {
    async put(key, value, opts) {
      const buf = value instanceof ArrayBuffer ? new Uint8Array(value) : (value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));
      r2Objects.set(key, { body: buf, httpMetadata: opts?.httpMetadata || {} });
      return { key };
    },
    async get(key) {
      const o = r2Objects.get(key);
      if (!o) return null;
      return {
        key,
        body: o.body,
        httpMetadata: o.httpMetadata,
        size: o.body.length,
        async arrayBuffer() { return o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength); }
      };
    },
    async delete(key) {
      r2Objects.delete(key);
    }
  };

  const sampleBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const telegramFetcher = async (url, opts) => {
    const u = String(url);
    if (u.includes('/getFile')) {
      return new Response(JSON.stringify({
        ok: true,
        result: { file_path: 'photos/sample-flower-staging-test.jpg', file_size: sampleBytes.length }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/file/bot')) {
      return new Response(sampleBytes, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (u.includes('/sendMessage')) {
      let body = {};
      try { body = JSON.parse(opts?.body || '{}'); } catch {}
      telegramReplies.push({
        chatId: body.chat_id,
        parseMode: body.parse_mode || null,
        text: String(body.text || '')
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: telegramReplies.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Probe Telegram mock: unsupported route', { status: 404 });
  };

  const opsService = {
    async fetch(input, init) {
      let body = {};
      try {
        if (init && typeof init.body === 'string') {
          body = JSON.parse(init.body);
        } else if (input && typeof input.json === 'function') {
          body = await input.json();
        }
      } catch {}
      const name = String(body?.name || '');
      if (name === 'getOrderRules') {
        return new Response(JSON.stringify({
          ok: true,
          rules: probeOptions.opsRules || DEFAULT_OPS_ORDER_RULES,
          caller: { username: 'cmui', role: 'ADMIN', canAssignDefaultSale: true }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      blockedOpsWrites.push({ action: name, at: new Date().toISOString() });
      return new Response(JSON.stringify({
        ok: false,
        code: 'PROBE_OPS_BLOCKED',
        message: 'OPS write operations are strictly blocked in /ai-probe'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
  };

  const probeWebhookSecret = 'probe-internal-webhook-secret';
  const isolatedEnv = {
    ...realEnv,
    DB: sandboxDb,
    MEDIA_R2: sandboxR2,
    BOT_TOKEN: realEnv.BOT_TOKEN || realEnv.TELEGRAM_BOT_TOKEN || 'probe-bot-token',
    OPS_TOKEN: realEnv.OPS_TOKEN || 'probe-ops-token',
    OPS_SERVICE: opsService,
    TELEGRAM_SECRET_TOKEN: probeWebhookSecret,
    ALLOWED_USER_IDS: String(userId),
    GEMINI_MODEL: probeOptions.model || realEnv.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    GEMINI_TIMEOUT_MS: probeOptions.timeoutMs,
    GEMINI_OPTIONS: probeOptions.geminiOptions,
    GEMINI_FETCHER: probeOptions.geminiFetcher || undefined,
    TELEGRAM_FETCHER: telegramFetcher,
    PROBE_COLLECTOR: aiCalls
  };

  return {
    isolatedEnv,
    probeWebhookSecret,
    readDraftsState: () => {
      const row = draftRows.get(Number(userId));
      if (!row) return { activeDraftId: null, drafts: {} };
      return { activeDraftId: row.active_draft_id, drafts: JSON.parse(row.drafts_json || '{}') };
    },
    sandboxAuditLogs,
    telegramReplies,
    blockedOpsWrites,
    r2Keys: () => [...r2Objects.keys()],
    aiCalls
  };
}

async function handleAiProbe(request, env) {
  const authorized =
    verifySecretHeader(request, 'x-ai-probe-token', env.AI_PROBE_TOKEN) ||
    verifySecretHeader(request, 'x-ops-token', env.OPS_TOKEN);
  if (!authorized) {
    return new Response(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'NO_GEMINI_API_KEY' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let probeBody;
  try {
    probeBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'BAD_JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const mode = probeBody?.mode === 'minimal' ? 'minimal' : 'bot-flow';
  const probeModel = String(probeBody?.model || env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  const preferredEndpoint = probeBody?.preferredEndpoint || null;
  const geminiOptions = {
    ...(probeBody?.geminiOptions && typeof probeBody.geminiOptions === 'object' ? probeBody.geminiOptions : {}),
    ...(preferredEndpoint ? { preferredEndpoint } : {})
  };
  const timeoutMs = Number.isFinite(Number(probeBody?.timeoutMs)) ? Number(probeBody.timeoutMs) : undefined;
  const faultInjection = probeBody?.faultInjection || null;
  const hasStepFaultInjection = Array.isArray(probeBody?.steps) &&
    probeBody.steps.some(s => s && typeof s === 'object' && s.faultInjection);
  const anyFaultInjection = Boolean(faultInjection || hasStepFaultInjection);
  const recordAudit = probeBody?.recordAudit !== false && !anyFaultInjection;

  // Mode 1: minimal direct AI probe (verifies endpoint, key, model, SSE reading, latency, attempts)
  if (mode === 'minimal') {
    const probeCaption = String(probeBody?.caption || '').trim();
    if (!probeCaption || probeCaption.length < 5) {
      return new Response(JSON.stringify({ ok: false, error: 'CAPTION_REQUIRED' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const faultFetcher = buildProbeFaultFetcher(faultInjection, probeCaption);
    const aiRes = await extractFieldsWithGeminiDetailed(
      env.GEMINI_API_KEY,
      probeCaption,
      probeModel,
      faultFetcher || resolveGeminiFetcher(env),
      timeoutMs || DEFAULT_GEMINI_TIMEOUT_MS,
      geminiOptions
    );
    const aiExtracted = aiRes.ok ? sanitizeAiFields(aiRes.fields) : null;

    let realD1AuditLogged = false;
    if (recordAudit && env.DB) {
      try {
        await logAudit(env.DB, null, 'geminiExtract', 'probe-minimal', null, {
          model: aiRes.model,
          endpoint: aiRes.endpoint || null,
          ok: aiRes.ok,
          status: aiRes.status ?? null,
          headersMs: aiRes.headersMs ?? null,
          latencyMs: aiRes.latencyMs,
          retries: aiRes.retries ?? 0,
          stage: aiRes.stage || null,
          thoughtParts: aiRes.thoughtParts ?? 0,
          textParts: aiRes.textParts ?? 0,
          finishReason: aiRes.finishReason || null,
          error: aiRes.ok ? null : String(aiRes.error || 'UNKNOWN').slice(0, 180),
          extractedKeys: aiExtracted ? Object.keys(aiExtracted) : [],
          probeRun: true,
          probeMode: 'minimal'
        });
        realD1AuditLogged = true;
      } catch {}
    }

    return new Response(JSON.stringify({
      ok: aiRes.ok,
      mode: 'minimal',
      source: anyFaultInjection ? 'worker-fault-injection' : 'worker-real-secret',
      model: aiRes.model,
      endpoint: aiRes.endpoint || null,
      status: aiRes.status ?? null,
      headersMs: aiRes.headersMs ?? null,
      latencyMs: aiRes.latencyMs,
      retries: aiRes.retries ?? 0,
      budgetExhausted: Boolean(aiRes.budgetExhausted),
      stage: aiRes.stage || null,
      thoughtParts: aiRes.thoughtParts ?? 0,
      textParts: aiRes.textParts ?? 0,
      finishReason: aiRes.finishReason || null,
      error: aiRes.ok ? null : String(aiRes.error || 'UNKNOWN'),
      attempts: aiRes.attempts || [],
      extractedKeys: aiExtracted ? Object.keys(aiExtracted) : [],
      extractedFields: aiExtracted || null,
      executionProof: {
        workerRuntime: true,
        handleTelegramWebhookUsed: false,
        realGeminiSecretUsed: !anyFaultInjection,
        realD1AuditLogged,
        d1DraftsSavedToRealDb: false,
        r2SavedToRealBucket: false,
        telegramNetworkSent: false,
        opsOrderCreationBlocked: true
      },
      isolationNote: 'NO_OPS_WRITE NO_REAL_D1_DRAFT_WRITE NO_REAL_R2_WRITE NO_TELEGRAM_SEND'
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Mode 2: full handleTelegramWebhook bot-flow in an isolated in-memory D1/R2 sandbox
  const rawSteps = Array.isArray(probeBody?.steps) ? probeBody.steps : null;
  const singleCaption = String(probeBody?.caption || '').trim();
  const cloneFromDraftId = String(probeBody?.cloneFromDraftId || '').trim();
  if (!rawSteps?.length && !singleCaption && !cloneFromDraftId) {
    return new Response(JSON.stringify({ ok: false, error: 'CAPTION_OR_STEPS_REQUIRED' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const probeUserId = Number((env.ALLOWED_USER_IDS || String(DEFAULT_ALLOWED_USER_ID)).split(',')[0].trim()) || DEFAULT_ALLOWED_USER_ID;

  // Read-only clone of a specific Staging draft (e.g. #b0dca9) into isolated memory without touching real D1
  let initialDraftState = null;
  if (cloneFromDraftId && env.DB) {
    const row = await env.DB.prepare('SELECT active_draft_id, drafts_json FROM bot_drafts WHERE user_id = ?')
      .bind(probeUserId)
      .first();
    if (!row?.drafts_json) {
      return new Response(JSON.stringify({ ok: false, error: 'CLONE_SOURCE_NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const parsedDrafts = JSON.parse(row.drafts_json);
    const matchedKey = Object.keys(parsedDrafts).find(k =>
      !k.startsWith('__') && (k === cloneFromDraftId || k.endsWith(cloneFromDraftId))
    );
    if (!matchedKey || !parsedDrafts[matchedKey]) {
      return new Response(JSON.stringify({ ok: false, error: 'CLONE_DRAFT_NOT_FOUND', cloneFromDraftId }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const clonedDraft = JSON.parse(JSON.stringify(parsedDrafts[matchedKey]));
    const sampleR2Keys = (clonedDraft.sampleRefs || []).map(r => r?.r2_key).filter(Boolean);
    initialDraftState = {
      activeDraftId: matchedKey,
      drafts: { [matchedKey]: clonedDraft, __active: matchedKey },
      sampleR2Keys
    };
  }

  const steps = rawSteps?.length
    ? rawSteps
    : (cloneFromDraftId
      ? [{ text: String(probeBody?.command || '/reparse') }]
      : [{ photo: probeBody?.withPhoto !== false, caption: singleCaption }]);

  const firstCaptionText = singleCaption || String(steps.find(s => typeof s === 'object' && (s.caption || s.text))?.caption || '');
  const globalFaultFetcher = buildProbeFaultFetcher(faultInjection, firstCaptionText);

  const probeCtx = createIsolatedProbeEnv(env, probeUserId, initialDraftState, {
    model: probeModel,
    timeoutMs,
    geminiOptions,
    geminiFetcher: globalFaultFetcher,
    opsRules: probeBody?.opsRules || null
  });

  const stepResults = [];
  let seq = Number(probeBody?.baseUpdateId || 900001);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const stepObj = typeof s === 'string' ? { text: s } : (s || {});
    const updateId = stepObj.update_id ?? (seq + i);
    const msgId = stepObj.message_id ?? (seq + i);
    const msgDate = stepObj.date ?? (1795700000 + i * 2);

    // Allow per-step faultInjection override so callers can test 503 failure -> /reparse recovery
    if (stepObj.faultInjection !== undefined) {
      const stepCaptionHint = stepObj.caption ||
        (stepObj.text && !String(stepObj.text).trim().startsWith('/') ? stepObj.text : '') ||
        firstCaptionText;
      const stepFault = buildProbeFaultFetcher(stepObj.faultInjection, stepCaptionHint);
      probeCtx.isolatedEnv.GEMINI_FETCHER = stepFault || undefined;
    } else {
      probeCtx.isolatedEnv.GEMINI_FETCHER = globalFaultFetcher || undefined;
    }

    const message = {
      message_id: msgId,
      date: msgDate,
      chat: { id: probeUserId, type: 'private' },
      from: { id: probeUserId }
    };
    if (stepObj.photo) {
      message.photo = [{ file_id: stepObj.file_id || `probe_photo_${i}`, file_unique_id: stepObj.file_unique_id || `probe_u_${i}` }];
      if (stepObj.caption !== undefined) message.caption = stepObj.caption;
    } else {
      message.text = String(stepObj.text || '');
    }

    const replyCountBefore = probeCtx.telegramReplies.length;
    const req = new Request('https://meehoa-order-bot-staging.meehoasg.workers.dev/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': probeCtx.probeWebhookSecret
      },
      body: JSON.stringify({ update_id: updateId, message })
    });
    const res = await handleTelegramWebhook(req, probeCtx.isolatedEnv);
    const resText = await res.text();
    stepResults.push({
      step: i + 1,
      updateId,
      httpStatus: res.status,
      webhookResponse: resText,
      replies: probeCtx.telegramReplies.slice(replyCountBefore)
    });
  }

  let realD1AuditLogged = false;
  if (recordAudit && env.DB && probeCtx.sandboxAuditLogs.length) {
    for (const entry of probeCtx.sandboxAuditLogs) {
      if (entry.action !== 'geminiExtract' || !entry.payload) continue;
      try {
        const auditDraftId = cloneFromDraftId
          ? `probe-clone-${cloneFromDraftId.slice(-6)}`
          : `probe-${String(entry.draftId || 'botflow').slice(-12)}`;
        await logAudit(env.DB, null, 'geminiExtract', auditDraftId, null, {
          ...entry.payload,
          probeRun: true,
          probeMode: 'bot-flow'
        });
        realD1AuditLogged = true;
      } catch {}
    }
  }

  const finalState = probeCtx.readDraftsState();
  const draftEntries = Object.entries(finalState.drafts || {})
    .filter(([k, d]) => !k.startsWith('__') && d && d.id)
    .map(([, d]) => d);
  const activeDraftObj = finalState.activeDraftId ? finalState.drafts[finalState.activeDraftId] || null : null;
  const latestAi = probeCtx.aiCalls[probeCtx.aiCalls.length - 1] || null;
  const anyRealGeminiFail = !anyFaultInjection && probeCtx.aiCalls.some(c => !c.ok);

  return new Response(JSON.stringify({
    ok: !anyRealGeminiFail && stepResults.every(s => s.httpStatus === 200),
    mode: 'bot-flow',
    source: anyFaultInjection ? 'worker-fault-injection' : 'worker-real-secret',
    model: latestAi?.model || probeModel,
    endpoint: latestAi?.endpoint || null,
    status: latestAi?.status ?? null,
    headersMs: latestAi?.headersMs ?? null,
    latencyMs: latestAi?.latencyMs ?? null,
    retries: latestAi?.retries ?? 0,
    error: latestAi && !latestAi.ok ? latestAi.error : null,
    extractedKeys: latestAi?.ok && latestAi.fields ? Object.keys(sanitizeAiFields(latestAi.fields) || {}) : [],
    extractedFields: latestAi?.ok ? sanitizeAiFields(latestAi.fields) : null,
    aiCalls: probeCtx.aiCalls.map(c => ({
      model: c.model,
      endpoint: c.endpoint || null,
      ok: c.ok,
      status: c.status ?? null,
      headersMs: c.headersMs ?? null,
      latencyMs: c.latencyMs,
      retries: c.retries ?? 0,
      budgetExhausted: Boolean(c.budgetExhausted),
      stage: c.stage || null,
      finishReason: c.finishReason || null,
      error: c.ok ? null : (c.error || null),
      attempts: c.attempts || [],
      extractedFields: c.ok ? sanitizeAiFields(c.fields) : null
    })),
    stepResults,
    draftsCount: draftEntries.length,
    activeDraftId: finalState.activeDraftId,
    activeDraft: activeDraftObj ? {
      id: activeDraftObj.id,
      status: activeDraftObj.status,
      fields: activeDraftObj.fields || {},
      sampleCount: (activeDraftObj.sampleRefs || []).length,
      billCount: (activeDraftObj.draftBillRefs || []).length,
      pendingAiText: activeDraftObj.pendingAiText || null,
      lastAiError: activeDraftObj.lastAiError || null,
      uncertainFields: activeDraftObj.uncertainFields || {}
    } : null,
    draftsSummaryList: draftEntries.map(d => ({
      id: d.id,
      status: d.status,
      fields: d.fields,
      sampleCount: (d.sampleRefs || []).length
    })),
    auditLogs: probeCtx.sandboxAuditLogs,
    executionProof: {
      workerRuntime: true,
      handleTelegramWebhookUsed: true,
      realGeminiSecretUsed: !anyFaultInjection,
      realD1AuditLogged,
      d1DraftsSavedToRealDb: false,
      r2SavedToRealBucket: false,
      telegramNetworkSent: false,
      opsOrderCreationBlocked: true,
      opsWriteAttemptsCount: probeCtx.blockedOpsWrites.length,
      sandboxR2ObjectsCount: probeCtx.r2Keys().length
    },
    isolationNote: 'NO_OPS_WRITE NO_REAL_D1_DRAFT_WRITE NO_REAL_R2_WRITE NO_TELEGRAM_SEND'
  }), { headers: { 'Content-Type': 'application/json' } });
}

/**
 * Handle incoming Telegram Webhook updates
 * @param {Request} request
 * @param {object} env - Cloudflare Worker environment bindings
 * @returns {Promise<Response>}
 */
export async function handleTelegramWebhook(request, rawEnv) {
  const env = {
    ...rawEnv,
    BOT_TOKEN: rawEnv?.BOT_TOKEN || rawEnv?.TELEGRAM_BOT_TOKEN,
    OPS_TOKEN: rawEnv?.OPS_TOKEN || rawEnv?.OPS_SERVICE_ROLE_TOKEN
  };
  // A. Security Check 1: Webhook Secret Token (fail-closed)
  const expectedSecret = env.TELEGRAM_SECRET_TOKEN;
  if (!verifyWebhookSecret(request, expectedSecret)) {
    return new Response('Forbidden: Invalid Secret Token', { status: 403 });
  }
  if (!env.DB || !env.BOT_TOKEN) {
    return new Response('Service unavailable', { status: 503 });
  }

  // B. Parse incoming JSON
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('Bad Request: Invalid JSON', { status: 400 });
  }

  const updateId = update?.update_id;
  const message = update?.message;

  // If no message or update_id, acknowledge and ignore
  if (!updateId || !message) {
    return new Response('OK', { status: 200 });
  }

  // C. Deduplication check: Has this update already been processed?
  try {
    if (await isUpdateProcessed(env.DB, updateId)) {
      return new Response('OK: Already Processed', { status: 200 });
    }
  } catch {
    console.error('[worker] D1 error checking processed update');
    return new Response('Service unavailable', {
      status: 503,
      headers: { 'Retry-After': '5' }
    });
  }

  const chatId = message.chat?.id;
  const fromUser = message.from;
  const userId = fromUser?.id;

  // D. Security Check 2: Private Chat Only
  if (message.chat?.type !== 'private') {
    if (env.DB) await markUpdateProcessed(env.DB, updateId, userId);
    return new Response('OK: Ignored Group Chat', { status: 200 });
  }

  // E. Security Check 3: Allowed Telegram User ID whitelist
  const allowedUserIds = (env.ALLOWED_USER_IDS || String(DEFAULT_ALLOWED_USER_ID))
    .split(',')
    .map(s => Number(s.trim()))
    .filter(Boolean);

  if (!userId || !allowedUserIds.includes(userId)) {
    if (chatId) {
      await replyTg(
        env,
        chatId,
        '⛔ Bạn không có quyền sử dụng bot này. Chỉ tài khoản quản trị được phân quyền mới có thể truy cập.'
      );
    }
    if (env.DB) await markUpdateProcessed(env.DB, updateId, userId);
    return new Response('OK: Unauthorized User Handled', { status: 200 });
  }

  // F. Concurrency Lock & Draft Processing
  const executeProcess = async () => {
    let drafts = env.DB ? await loadDrafts(env.DB, userId) : {};

    // 1. Photo message handler
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      if (!env.MEDIA_R2) {
        await replyTg(env, chatId, '⚠️ Kho ảnh chưa sẵn sàng. Ảnh chưa được thêm vào đơn nháp.');
        return;
      }

      const highestPhoto = message.photo[message.photo.length - 1];
      const caption = (message.caption || '').trim();
      if (caption && detectPromptInjection(caption)) {
        await replyTg(env, chatId, '🛡️ Tin nhắn bị từ chối do chứa nội dung can thiệp hệ thống hoặc quyền hạn.');
        return;
      }

      const isBill = isBillCaption(caption);
      const decision = classifyIncomingPhotoDraft(drafts, caption, isBill);

      if (decision.action === 'reject_no_draft') {
        await replyTg(env, chatId, '⚠️ Chưa có đơn nháp nào đang chọn. Gửi ảnh mẫu kèm chú thích đơn hàng hoặc gõ /new để tạo đơn mới.');
        return;
      }
      if (decision.action === 'reject_confirming') {
        await replyTg(env, chatId, '⏳ Đơn đang trong tiến trình xác nhận với OPS, không thể bổ sung ảnh.');
        return;
      }
      if (decision.action === 'reject_submitted') {
        await replyTg(env, chatId, '⚠️ Đơn này đã được tạo thành công trên OPS. Gửi ảnh mẫu kèm chú thích đơn mới hoặc gõ /new để tạo đơn mới.');
        return;
      }

      const currentActive = activeDraft(drafts);
      if (decision.action === 'attach_active' && currentActive) {
        if ((isBill ? currentActive.draftBillRefs : currentActive.sampleRefs)?.length >= 10) {
          await replyTg(env, chatId, '⚠️ Mỗi nhóm chỉ nhận tối đa 10 ảnh. Ảnh này chưa được thêm vào đơn nháp.');
          return;
        }
      }

      // Download photo with 5MB validation
      const downloadResult = await downloadTgPhoto(env, highestPhoto.file_id, MAX_IMAGE_BYTES);
      if (!downloadResult.ok) {
        await replyTg(env, chatId, `⚠️ Không thể tải ảnh: ${downloadResult.error}`);
        return;
      }

      const ext = downloadResult.mimeType === 'image/png'
        ? 'png'
        : downloadResult.mimeType === 'image/webp'
          ? 'webp'
          : 'jpg';
      const fileHash = (highestPhoto.file_unique_id || String(Date.now())).slice(0, 12);

      // Ambiguous photo+caption against an existing populated draft -> NEVER silently merge!
      // Store photo safely in R2 pending slot and ask operator to choose.
      if (decision.action === 'ask_user' && currentActive) {
        const pendingId = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : String(Date.now());
        const pendingKey = `order-images/pending-${pendingId}-${fileHash}.${ext}`;
        const stored = await savePhotoToR2(env.MEDIA_R2, pendingKey, downloadResult.buffer, downloadResult.mimeType);
        if (!stored) {
          await replyTg(env, chatId, '⚠️ Chưa lưu được ảnh vào kho lưu trữ. Vui lòng gửi lại; ảnh này chưa được thêm vào đơn nháp.');
          return;
        }

        const previousPendingKey = drafts.__pendingPhoto?.r2_key || null;
        drafts = {
          ...drafts,
          __pendingPhoto: {
            id: pendingId,
            fileId: highestPhoto.file_id,
            fileHash,
            ext,
            r2_key: pendingKey,
            uri: `supabase://${pendingKey}`,
            mimeType: downloadResult.mimeType,
            byteSize: downloadResult.byteSize,
            caption,
            activeDraftId: currentActive.id,
            updateId: updateId || 0,
            messageDate: Number(message.date) || 0,
            messageId: Number(message.message_id) || 0,
            createdAt: new Date().toISOString()
          }
        };

        try {
          await saveDrafts(env.DB, userId, drafts);
        } catch (saveErr) {
          await deletePhotoFromR2(env.MEDIA_R2, pendingKey);
          throw saveErr;
        }
        if (previousPendingKey && previousPendingKey !== pendingKey) {
          await deletePhotoFromR2(env.MEDIA_R2, previousPendingKey);
        }

        const oldShort = currentActive.id.slice(-6);
        const oldCust = currentActive.fields?.customer || '(chưa có tên)';
        const conflictText = decision.conflicts?.length
          ? ` (${decision.conflicts.join(', ')})`
          : '';
        await replyTg(
          env,
          chatId,
          `❓ Ảnh kèm chú thích vừa gửi có thông tin chưa chắc thuộc nháp hiện tại #${oldShort} — ${oldCust}${conflictText}.\n` +
          `Bot KHÔNG tự gộp để tránh trộn dữ liệu hai đơn.\n\n` +
          `Vui lòng chọn:\n` +
          `1️⃣ Gõ /new_from_photo (hoặc nhắn 1) — Tạo đơn nháp MỚI từ ảnh & chú thích này (giữ nguyên nháp #${oldShort})\n` +
          `2️⃣ Gõ /attach (hoặc nhắn 2) — Gộp ảnh & cập nhật chú thích vào nháp hiện tại #${oldShort}\n` +
          `3️⃣ Gõ /discard_photo (hoặc nhắn 3) — Hủy ảnh vừa gửi`
        );
        return;
      }

      // If caption clearly represents a NEW order, preserve old draft and create a brand-new draft!
      let prevDraft = null;
      if (decision.action === 'create_new') {
        prevDraft = currentActive;
        const created = cmdNew(drafts, '');
        drafts = created.drafts;
      }

      const targetDraft = activeDraft(drafts);
      const r2Key = isBill
        ? `settlement-bills/unverified-${targetDraft.id}-${fileHash}.${ext}`
        : `order-images/sample-${targetDraft.id}-${fileHash}.${ext}`;

      const stored = await savePhotoToR2(env.MEDIA_R2, r2Key, downloadResult.buffer, downloadResult.mimeType);
      if (!stored) {
        await replyTg(env, chatId, '⚠️ Chưa lưu được ảnh vào kho lưu trữ. Vui lòng gửi lại; ảnh này chưa được thêm vào đơn nháp.');
        return;
      }

      const result = isBill
        ? addBillRef(drafts, highestPhoto.file_id, caption)
        : addSampleRef(drafts, highestPhoto.file_id, caption);

      if (result.ok) {
        drafts = result.drafts;
        // D1 stores ONLY durable R2 references & metadata — NEVER base64 data_url.
        const list = isBill ? drafts[drafts.__active].draftBillRefs : drafts[drafts.__active].sampleRefs;
        if (list && list.length > 0) {
          const ref = list[list.length - 1];
          ref.r2_key = r2Key;
          ref.uri = `supabase://${r2Key}`;
          ref.mimeType = downloadResult.mimeType;
          ref.byteSize = downloadResult.byteSize;
        }
        const activeItem = drafts[drafts.__active];
        if (activeItem) {
          activeItem.lastUpdateId = Math.max(Number(activeItem.lastUpdateId) || 0, updateId || 0);
          activeItem.lastMessageDate = Math.max(Number(activeItem.lastMessageDate) || 0, Number(message.date) || 0);
          activeItem.lastMessageId = Math.max(Number(activeItem.lastMessageId) || 0, Number(message.message_id) || 0);
        }

        let extraReply = '';
        let captionApplied = false;
        let aiNotice = null;
        const opsRules = getCachedOpsOrderRules(env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core', env.OPS_TOKEN || '');
        if (caption && !isBill) {
          const mergedRes = await mergeAiFallback(
            drafts[drafts.__active],
            caption,
            applyFields(drafts[drafts.__active], caption, { rules: opsRules }),
            env,
            opsRules,
            userId
          );
          const { draft: updatedDraft, changes, warnings } = mergedRes;
          aiNotice = mergedRes.aiNotice || null;
          if (changes && changes.length > 0) {
            drafts[drafts.__active] = updatedDraft;
            captionApplied = true;
            const changedText = changes.map(c => c.uncertain ? `  ⚠️ ${c.field}: ${c.reason}` : `  ${c.field}: ${c.value}`).join('\n');
            extraReply = `\n\n✏️ Đã nhận thông tin từ chú thích:\n${changedText}`;
          } else if (aiNotice && updatedDraft) {
            drafts[drafts.__active] = updatedDraft;
          }
          if (warnings?.length) {
            extraReply += `\n${warnings.join('\n')}`;
          }
          if (aiNotice) {
            extraReply += `\n\n${aiNotice}`;
          }
        }

        try {
          await saveDrafts(env.DB, userId, drafts);
        } catch (saveErr) {
          // Avoid leaking orphaned R2 object if D1 save fails
          await deletePhotoFromR2(env.MEDIA_R2, r2Key);
          throw saveErr;
        }

        if (decision.action === 'create_new') {
          const newDraft = drafts[drafts.__active];
          const newShort = newDraft.id.slice(-6);
          const header = prevDraft && prevDraft.status !== 'submitted'
            ? `🆕 Phát hiện đơn mới khác với nháp cũ #${prevDraft.id.slice(-6)} (${prevDraft.fields?.customer || 'chưa có tên'}).\nĐã giữ nguyên nháp cũ (dùng /list hoặc /select ${prevDraft.id.slice(-6)} để xem lại) và tạo nháp mới #${newShort}:`
            : `🆕 Đã tạo đơn nháp mới #${newShort} kèm 1 ảnh mẫu:`;
          const noticeBlock = aiNotice ? `\n\n${html(aiNotice)}` : '';
          await replyTg(
            env,
            chatId,
            `${html(header)}${noticeBlock}\n\n${html(draftSummary(newDraft, opsRules))}`,
            'HTML'
          );
        } else if (captionApplied || aiNotice) {
          const updatedNow = drafts[drafts.__active];
          await replyTg(
            env,
            chatId,
            `${html(result.reply)}${html(extraReply)}\n\n${html(draftSummary(updatedNow, opsRules))}`,
            'HTML'
          );
        } else {
          await replyTg(env, chatId, `${html(result.reply)}${html(extraReply)}`, 'HTML');
        }
      } else {
        await deletePhotoFromR2(env.MEDIA_R2, r2Key);
        await replyTg(env, chatId, `⚠️ ${result.reply}`);
      }
      return;
    }

    // 2. Text message handler
    const rawText = (message.text || '').trim();
    if (!rawText) return;

    // Check Prompt Injection
    const injectionType = detectPromptInjection(rawText);
    if (injectionType) {
      await replyTg(env, chatId, '🛡️ Tin nhắn bị từ chối do chứa nội dung can thiệp hệ thống hoặc quyền hạn.');
      return;
    }

    // A. Commands: /new, /list, /select, /show, /reparse, /cancel, /confirm, and pending-photo choices
    if (drafts.__pendingPhoto) {
      const choiceNorm = rawText.toLowerCase();
      if (choiceNorm === '1' || choiceNorm === 'mới' || choiceNorm === 'moi') {
        await resolvePendingPhotoChoice(drafts, 'new', env, userId, chatId);
        return;
      }
      if (choiceNorm === '2' || choiceNorm === 'gộp' || choiceNorm === 'gop') {
        await resolvePendingPhotoChoice(drafts, 'attach', env, userId, chatId);
        return;
      }
      if (choiceNorm === '3' || choiceNorm === 'bỏ' || choiceNorm === 'bo') {
        await resolvePendingPhotoChoice(drafts, 'discard', env, userId, chatId);
        return;
      }
    }

    if (rawText.startsWith('/')) {
      const parts = rawText.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();

      if (cmd === '/new_from_photo') {
        await resolvePendingPhotoChoice(drafts, 'new', env, userId, chatId);
      } else if (cmd === '/attach') {
        await resolvePendingPhotoChoice(drafts, 'attach', env, userId, chatId);
      } else if (cmd === '/discard_photo') {
        await resolvePendingPhotoChoice(drafts, 'discard', env, userId, chatId);
      } else if (cmd === '/new') {
        const res = cmdNew(drafts, arg);
        drafts = res.drafts;
        if (env.DB && !res.reused) await saveDrafts(env.DB, userId, drafts);
        await replyTg(env, chatId, res.reply);
      } else if (cmd === '/list') {
        const res = cmdList(drafts);
        await replyTg(env, chatId, res.reply);
      } else if (cmd === '/select') {
        const opsRules = getCachedOpsOrderRules(env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core', env.OPS_TOKEN || '');
        const res = cmdSelect(drafts, arg);
        if (res.drafts) drafts = res.drafts;
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        const selected = activeDraft(drafts);
        const reply = selected ? `Đang xem đơn #${selected.id.slice(-6)}.\n\n${draftSummary(selected, opsRules)}` : res.reply;
        await replyTg(env, chatId, reply);
      } else if (cmd === '/show') {
        const { rules: opsRules } = await loadCurrentOpsRules(env, { forceRefresh: false });
        const res = cmdShow(drafts, arg, opsRules);
        await replyTg(env, chatId, res.reply);
      } else if (cmd === '/reparse' || cmd === '/retry_ai') {
        await handleReparseCommand(drafts, arg, env, userId, chatId);
      } else if (cmd === '/cancel') {
        const draftToCancel = activeDraft(drafts);
        const res = cmdCancel(drafts, arg);
        if (res.drafts) drafts = res.drafts;
        let orphanPendingKey = null;
        if (draftToCancel && !drafts[draftToCancel.id] && drafts.__pendingPhoto?.activeDraftId === draftToCancel.id) {
          orphanPendingKey = drafts.__pendingPhoto.r2_key || null;
          delete drafts.__pendingPhoto;
        }
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        if (draftToCancel && !drafts[draftToCancel.id]) {
          await cleanupCancelledDraftMedia(draftToCancel, drafts, env);
        }
        if (orphanPendingKey && env.MEDIA_R2) {
          await deletePhotoFromR2(env.MEDIA_R2, orphanPendingKey);
        }
        await replyTg(env, chatId, res.reply);
      } else if (cmd === '/confirm') {
        await handleConfirmCommand(drafts, env, userId, chatId);
      } else if (cmd === '/retry_payment' || cmd === '/sync_payment') {
        await handleRetryPaymentCommand(drafts, arg, env, userId, chatId);
      } else if (cmd === '/relink' || cmd === '/retry_bill') {
        await handleRelinkCommand(drafts, arg, env, userId, chatId);
      } else {
        await replyTg(env, chatId, '❓ Lệnh không nhận ra. Các lệnh hỗ trợ:\n/new — Tạo đơn mới\n/list — Danh sách đơn nháp\n/select <id> — Chọn đơn nháp\n/show — Xem chi tiết đơn\n/reparse — Đọc lại chú thích của nháp hiện tại bằng AI\n/confirm — Xác nhận tạo đơn OPS\n/retry_payment — Đồng bộ lại thanh toán/cọc vào đơn OPS đã tạo\n/relink — Gắn lại bill vào đơn OPS đã tạo\n/cancel — Xóa đơn nháp đang chọn');
      }
      return;
    }

    // B. Field updates
    const draft = activeDraft(drafts);
    if (!draft) {
      await replyTg(env, chatId, '⚠️ Dùng /new để tạo đơn nháp trước khi nhập thông tin.');
      return;
    }

    if (draft.status === 'confirming') {
      await replyTg(env, chatId, '⏳ Đơn đang trong tiến trình xác nhận với OPS, không thể chỉnh sửa.');
      return;
    }
    if (draft.status === 'submitted') {
      await replyTg(env, chatId, '⚠️ Đơn này đã được tạo thành công trên OPS. Gõ /new để tạo đơn mới.');
      return;
    }

    const messageId = Number(message.message_id) || 0;
    const messageDate = Number(message.date) || Math.floor(Date.now() / 1000);
    const lastUpdateId = Number(draft.lastUpdateId) || 0;
    const lastMessageDate = Number(draft.lastMessageDate) || 0;
    const lastMessageId = Number(draft.lastMessageId) || 0;
    const isOutOfOrder = (updateId && lastUpdateId && updateId < lastUpdateId) ||
                         (messageDate && lastMessageDate && messageDate < lastMessageDate) ||
                         (messageDate && lastMessageDate && messageDate === lastMessageDate && messageId && lastMessageId && messageId < lastMessageId);

    // Apply structured fields via core applyFields against cached/default OPS validation rules
    const opsRules = getCachedOpsOrderRules(env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core', env.OPS_TOKEN || '');
    const mergedText = await mergeAiFallback(
      draft,
      rawText,
      applyFields(draft, rawText, { rules: opsRules }),
      env,
      opsRules,
      userId
    );
    let updated = mergedText.draft;
    let changes = mergedText.changes;
    const warnings = mergedText.warnings;
    const aiNotice = mergedText.aiNotice || null;

    if (isOutOfOrder && changes?.length) {
      // If an older message arrives after a newer message, do NOT overwrite fields that are already set
      changes = changes.filter(c => !draft.fields[c.field] || String(draft.fields[c.field]).trim() === '');
      if (changes.length === 0) {
        await replyTg(env, chatId, 'ℹ️ Đã nhận tin nhắn gửi trước đó nhưng các thông tin này đã được cập nhật bởi tin nhắn mới hơn.');
        return;
      }
      // Re-apply only non-conflicting changes
      const filteredLines = changes.map(c => `${c.field}: ${c.value}`).join('\n');
      const filteredApplied = applyFields(draft, filteredLines, { rules: opsRules });
      updated = filteredApplied.draft;
      changes = filteredApplied.changes;
    }

    if (changes && (changes.length > 0 || warnings?.length > 0)) {
      if (!isOutOfOrder) {
        updated.lastUpdateId = Math.max(lastUpdateId, updateId || 0);
        updated.lastMessageDate = Math.max(lastMessageDate, messageDate || 0);
        updated.lastMessageId = Math.max(lastMessageId, messageId || 0);
      }
      drafts = { ...drafts, [draft.id]: updated };
      if (env.DB) await saveDrafts(env.DB, userId, drafts);

      const changedText = changes.map(c => c.uncertain ? `  ⚠️ ${c.field}: ${c.reason}` : `  ${c.field}: ${c.value}`).join('\n');
      const validation = validateOrderAgainstRules(updated, opsRules);
      const uncertainCount = Object.keys(updated.uncertainFields || {}).length;

      let extra = '';
      if (validation.unsupportedRules.length) {
        extra += `\n🚧 OPS vừa thêm quy tắc mới bot chưa hỗ trợ (${validation.unsupportedRules.join(', ')}). Nháp vẫn được giữ nguyên.`;
      }
      if (validation.missing.length) extra += `\n⚠️ Còn thiếu: ${validation.missing.join(', ')}`;
      if (validation.ruleErrors.length) extra += `\n⛔ ${validation.ruleErrors.join(' | ')}`;
      if (uncertainCount) extra += `\n❓ Có ${uncertainCount} trường cần làm rõ trước khi xác nhận.`;
      if (validation.ok) extra += `\n✅ Đã đủ dữ liệu (Sale: ${formatSaleDisplay(updated.fields?.sale, opsRules)}) — dùng /confirm để tạo đơn.`;
      const warnMsg = warnings?.length ? `\n${warnings.join('\n')}` : '';
      const aiMsg = aiNotice ? `\n\n${aiNotice}` : '';

      const prefix = changedText ? `✏️ Đã cập nhật:\n${changedText}` : '';
      await replyTg(env, chatId, `${prefix}${extra}${warnMsg}${aiMsg}`.trim());
    } else if (aiNotice) {
      if (!isOutOfOrder) {
        updated.lastUpdateId = Math.max(lastUpdateId, updateId || 0);
        updated.lastMessageDate = Math.max(lastMessageDate, messageDate || 0);
        updated.lastMessageId = Math.max(lastMessageId, messageId || 0);
      }
      drafts = { ...drafts, [draft.id]: updated };
      if (env.DB) await saveDrafts(env.DB, userId, drafts);
      await replyTg(env, chatId, `${aiNotice}\n\n${draftSummary(updated, opsRules)}`);
    } else {
      await replyTg(
        env,
        chatId,
        '⚠️ Không nhận ra trường nào. Dùng dạng:\n  tên khách: Nguyễn A\n  hoa: Bó hồng đỏ\n  ngày: 2026-12-01\nhoặc gõ /show để xem đơn.'
      );
    }
  };

  // Run inside per-user lock; fail closed (HTTP 503) on D1 error without marking update processed
  try {
    const lockResult = await withLock(env.DB, userId, executeProcess);
    if (lockResult.busy) {
      await replyTg(env, chatId, '⏳ Hệ thống đang xử lý yêu cầu trước của bạn hoặc đang xác nhận đơn. Vui lòng thử lại sau giây lát.');
      return new Response('Busy: Update Queued or System Confirming', {
        status: 503,
        headers: { 'Retry-After': '3' }
      });
    }
    await markUpdateProcessed(env.DB, updateId, userId);
  } catch {
    console.error('[worker] Storage failure during webhook execution');
    await replyTg(
      env,
      chatId,
      '⚠️ Hệ thống lưu trữ đang tạm gián đoạn. Dữ liệu đơn nháp của bạn vẫn được bảo toàn; vui lòng thử lại sau giây lát.'
    );
    return new Response('Service unavailable', {
      status: 503,
      headers: { 'Retry-After': '5' }
    });
  }

  return new Response('OK', { status: 200 });
}

const AI_FILLABLE_FIELDS = ['customer', 'phone', 'flower', 'date', 'time', 'shipping', 'address', 'flowerTotal'];
const isBlankField = v => v === undefined || v === null || String(v).trim() === '';
const hasExplicitEditIntent = text => {
  const norm = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  return /\b(sua|doi|thay\s*doi|cap\s*nhat|chinh|chuyen\s*sang)\b/.test(norm);
};
const isShippingLikeName = val => {
  const norm = String(val || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  return /\b(shop\s*(?:book|ship|giao)|khach\s*tu\s*book|tu\s*book|ghe\s*lay|tai\s*tiem|tu\s*lay|grab|aha)\b/.test(norm);
};

/**
 * Run Gemini AI fallback on top of the deterministic parser for photo captions, text, and /reparse.
 * - Preserves all previously confirmed fields unless explicit edit intent is active (and not disabled via preserveExisting).
 * - When AI fails after retries/budget, preserves pendingAiText + lastAiError on the draft and returns an actionable aiNotice.
 */
export async function mergeAiFallback(baseDraft, text, structured, env, opsRules, userId = null, options = {}) {
  const result = structured || { draft: baseDraft, changes: [], warnings: [] };
  if (!env?.GEMINI_API_KEY || !text || String(text).trim().length < 5) {
    return { ...result, aiNotice: null, aiResult: null };
  }
  const after = result.draft || baseDraft;
  const preserveExisting = Boolean(options?.preserveExisting);
  const explicitEdit = !preserveExisting && hasExplicitEditIntent(text);
  const stillMissing = AI_FILLABLE_FIELDS.filter(f => isBlankField(after?.fields?.[f]));
  if (result.changes?.length && stillMissing.length === 0 && !explicitEdit) {
    return { ...result, aiNotice: null, aiResult: null };
  }

  let aiRes = null;
  let aiExtracted = null;
  try {
    aiRes = await extractFieldsWithGeminiDetailed(
      env.GEMINI_API_KEY,
      text,
      env.GEMINI_MODEL,
      resolveGeminiFetcher(env),
      env.GEMINI_TIMEOUT_MS,
      env.GEMINI_OPTIONS || {}
    );
    aiExtracted = aiRes.ok ? sanitizeAiFields(aiRes.fields) : null;
  } catch (err) {
    aiRes = {
      ok: false,
      fields: null,
      model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      endpoint: null,
      status: null,
      latencyMs: 0,
      retries: 0,
      stage: 'connect',
      error: String(err?.name || 'NETWORK_ERROR')
    };
  }

  if (Array.isArray(env?.PROBE_COLLECTOR) && aiRes) {
    env.PROBE_COLLECTOR.push({
      model: aiRes.model,
      endpoint: aiRes.endpoint || null,
      ok: aiRes.ok,
      status: aiRes.status ?? null,
      headersMs: aiRes.headersMs ?? null,
      latencyMs: aiRes.latencyMs,
      retries: aiRes.retries ?? 0,
      budgetExhausted: Boolean(aiRes.budgetExhausted),
      stage: aiRes.stage || null,
      thoughtParts: aiRes.thoughtParts ?? 0,
      textParts: aiRes.textParts ?? 0,
      finishReason: aiRes.finishReason || null,
      error: aiRes.ok ? null : (aiRes.error || null),
      attempts: aiRes.attempts || [],
      fields: aiRes.ok ? aiRes.fields : null
    });
  }

  if (env?.DB && aiRes) {
    try {
      await logAudit(env.DB, userId, 'geminiExtract', after?.id || null, null, {
        model: aiRes.model,
        endpoint: aiRes.endpoint || null,
        ok: aiRes.ok,
        status: aiRes.status ?? null,
        headersMs: aiRes.headersMs ?? null,
        latencyMs: aiRes.latencyMs,
        retries: aiRes.retries ?? 0,
        stage: aiRes.stage || null,
        thoughtParts: aiRes.thoughtParts ?? 0,
        textParts: aiRes.textParts ?? 0,
        finishReason: aiRes.finishReason || null,
        error: aiRes.ok ? null : String(aiRes.error || 'UNKNOWN').slice(0, 180),
        extractedKeys: aiExtracted ? Object.keys(aiExtracted) : []
      });
    } catch {
      // Never block order intake on audit log write failure
    }
  }

  if (!aiRes?.ok) {
    const failedDraft = after
      ? {
          ...after,
          pendingAiText: String(text),
          lastAiError: {
            status: aiRes?.status ?? null,
            endpoint: aiRes?.endpoint || null,
            stage: aiRes?.stage || null,
            error: String(aiRes?.error || 'UNKNOWN').slice(0, 120),
            at: new Date().toISOString()
          }
        }
      : after;
    const shouldNotify = stillMissing.length > 0 || !(result.changes?.length);
    return {
      draft: failedDraft,
      changes: result.changes || [],
      warnings: result.warnings || [],
      aiNotice: shouldNotify ? formatAiFailureNotice(aiRes) : null,
      aiResult: aiRes
    };
  }

  // AI succeeded: clear any stale pendingAiText / lastAiError markers
  const clearAiPending = d => {
    if (!d) return d;
    const nextD = { ...d };
    delete nextD.pendingAiText;
    delete nextD.lastAiError;
    return nextD;
  };

  if (!aiExtracted || !Object.keys(aiExtracted).length) {
    return {
      draft: clearAiPending(after),
      changes: result.changes || [],
      warnings: result.warnings || [],
      aiNotice: null,
      aiResult: aiRes
    };
  }

  const touched = new Set((result.changes || []).map(c => c.field));
  const lines = Object.entries(aiExtracted)
    .filter(([k, v]) => {
      if (touched.has(k)) return false;
      if (k === 'customer' && isShippingLikeName(v)) return false;
      if (isBlankField(after?.fields?.[k])) return true;
      return explicitEdit && k !== 'customer';
    })
    .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ').trim()}`);
  if (!lines.length) {
    return {
      draft: clearAiPending(after),
      changes: result.changes || [],
      warnings: result.warnings || [],
      aiNotice: null,
      aiResult: aiRes
    };
  }

  const aiApplied = applyFields(after, lines.join('\n'), { rules: opsRules });
  if (!aiApplied.changes?.length) {
    return {
      draft: clearAiPending(after),
      changes: result.changes || [],
      warnings: result.warnings || [],
      aiNotice: null,
      aiResult: aiRes
    };
  }
  return {
    draft: clearAiPending(aiApplied.draft),
    changes: [...(result.changes || []), ...aiApplied.changes.map(c => ({ ...c, source: 'ai' }))],
    warnings: [...(result.warnings || []), ...(aiApplied.warnings || [])],
    aiNotice: null,
    aiResult: aiRes
  };
}

/**
 * Re-run caption/text AI extraction on the exact same pending draft without creating duplicates
 * and while strictly preserving all already confirmed fields.
 */
async function handleReparseCommand(drafts, arg, env, userId, chatId) {
  const shortArg = String(arg || '').trim();
  let target = null;

  if (shortArg) {
    const matches = Object.entries(drafts || {})
      .filter(([k, d]) => !k.startsWith('__') && d && d.id && (d.id === shortArg || d.id.endsWith(shortArg)))
      .map(([, d]) => d);
    if (matches.length === 0) {
      await replyTg(env, chatId, `⚠️ Không tìm thấy nháp #${shortArg} để đọc lại. Dùng /list để xem.`);
      return;
    }
    if (matches.length > 1) {
      await replyTg(env, chatId, `⚠️ Mã #${shortArg} khớp nhiều nháp. Vui lòng nhập đầy đủ hơn.`);
      return;
    }
    target = matches[0];
  } else {
    target = activeDraft(drafts);
  }

  if (!target) {
    await replyTg(env, chatId, '⚠️ Chưa có đơn nháp nào để đọc lại. Gửi ảnh kèm chú thích hoặc /new để tạo mới.');
    return;
  }
  if (target.status === 'submitted') {
    await replyTg(env, chatId, `⚠️ Nháp #${target.id.slice(-6)} đã tạo đơn trên OPS (${target.opsOrderId || ''}), không thể đọc lại.`);
    return;
  }
  if (target.status === 'confirming') {
    await replyTg(env, chatId, '⏳ Đơn đang trong tiến trình xác nhận với OPS, không thể cập nhật.');
    return;
  }

  const refCaption = [...(target.sampleRefs || [])]
    .reverse()
    .find(r => r?.caption && String(r.caption).trim())?.caption || '';
  const textToParse = String(target.pendingAiText || refCaption || '').trim();
  if (!textToParse || textToParse.length < 5) {
    await replyTg(env, chatId, `ℹ️ Nháp #${target.id.slice(-6)} không có chú thích đã lưu để đọc lại.`);
    return;
  }

  const { rules: opsRules } = await loadCurrentOpsRules(env, { forceRefresh: false });
  const detProbe = applyFields({ ...target, fields: {}, uncertainFields: {} }, textToParse, { rules: opsRules });
  const detBlankLines = (detProbe.changes || [])
    .filter(c => !c.uncertain && isBlankField(target.fields?.[c.field]))
    .map(c => `${c.field}: ${c.value}`);
  const structuredForBlank = detBlankLines.length
    ? applyFields(target, detBlankLines.join('\n'), { rules: opsRules })
    : { draft: target, changes: [], warnings: [] };

  const merged = await mergeAiFallback(
    target,
    textToParse,
    structuredForBlank,
    env,
    opsRules,
    userId,
    { preserveExisting: true }
  );

  const updated = merged.draft || target;
  drafts = { ...drafts, [target.id]: updated, __active: target.id };
  if (env.DB) await saveDrafts(env.DB, userId, drafts);

  const changes = merged.changes || [];
  const shortId = target.id.slice(-6);
  if (merged.aiNotice) {
    await replyTg(env, chatId, `🔄 Đã giữ nguyên nháp #${shortId}.\n${merged.aiNotice}\n\n${draftSummary(updated, opsRules)}`);
    return;
  }
  const changedText = changes.length
    ? `✏️ Đã đọc lại chú thích cho nháp #${shortId} và cập nhật:\n` +
      changes.map(c => c.uncertain ? `  ⚠️ ${c.field}: ${c.reason}` : `  ${c.field}: ${c.value}`).join('\n')
    : `ℹ️ Đã kiểm tra lại nháp #${shortId} (giữ nguyên các trường đã xác nhận).`;
  await replyTg(env, chatId, `${changedText}\n\n${draftSummary(updated, opsRules)}`);
}

async function loadCurrentOpsRules(env, { forceRefresh = false } = {}) {
  if (!env?.OPS_TOKEN) return { rules: DEFAULT_OPS_ORDER_RULES, caller: null };
  const fetcher = env.OPS_SERVICE ? env.OPS_SERVICE.fetch.bind(env.OPS_SERVICE) : fetch;
  const opsUrl = env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core';
  const res = await fetchOpsOrderRules(opsUrl, env.OPS_TOKEN, fetcher, { forceRefresh });
  return { rules: res.rules || DEFAULT_OPS_ORDER_RULES, caller: res.caller || null };
}

function expectedPaymentDetails(fields = {}) {
  const f = fields || {};
  const expectedPayment = mapPaymentToOps(f.paymentState, f.depositAmount, f.flowerTotal);
  let expectedPaid = 0;
  if (f.paymentState === 'deposit' && Number(f.depositAmount) > 0) {
    expectedPaid = Number(f.depositAmount);
  } else if (f.paymentState === 'bankfull' && Number(f.flowerTotal) > 0) {
    expectedPaid = Number(f.flowerTotal);
  }
  return { expectedPayment, expectedPaid };
}

/**
 * Handle /confirm command execution
 */
async function handleConfirmCommand(drafts, env, userId, chatId) {
  const draft = activeDraft(drafts);
  if (!draft) {
    await replyTg(env, chatId, '⚠️ Chưa có đơn nháp nào để xác nhận. Gõ /new để tạo đơn mới.');
    return;
  }

  // If order was already created on OPS but payment sync failed previously,
  // retry ONLY payment sync — NEVER call createOrder a second time.
  if (draft.status === 'submitted' && draft.opsOrderId && draft.paymentSynced === false) {
    await replyTg(
      env,
      chatId,
      `ℹ️ Đơn ${draft.opsOrderId} đã được tạo trên OPS (không tạo đơn trùng). Đang đồng bộ lại trạng thái thanh toán...`
    );
    await handleRetryPaymentCommand(drafts, draft.opsOrderId, env, userId, chatId);
    return;
  }

  // 1. Pre-validation right before createOrder against fresh shared OPS validation rules
  const { rules: opsRules, caller: opsCaller } = await loadCurrentOpsRules(env, { forceRefresh: true });

  // 1a. Pre-check: can the connected OPS account assign the default sale (cmui)?
  const expectedSale = String(draft.fields?.sale || opsRules.saleDefault || DEFAULT_BOT_SALE).trim();
  if (opsCaller && opsCaller.canAssignDefaultSale === false) {
    await replyTg(
      env,
      chatId,
      `❌ Tài khoản OPS hiện tại (<code>${html(opsCaller.username || '?')}</code>, vai trò: ${html(opsCaller.role || '?')}) không có quyền gán Sale phụ trách <code>${html(expectedSale)}</code>.\n\n` +
      `Đơn nháp được giữ nguyên. Vui lòng đổi tài khoản OPS hoặc liên hệ Admin.`,
      'HTML'
    );
    return;
  }

  const confirmResult = cmdConfirm(drafts, '', opsRules);
  if (confirmResult.reply !== '__CONFIRM__') {
    await replyTg(env, chatId, confirmResult.reply);
    return;
  }

  drafts = confirmResult.drafts;
  const confirmedDraft = drafts[draft.id];

  // 2. Mark status confirming in D1
  drafts = transitionDraftStatus(drafts, draft.id, 'confirming', {
    confirmingAt: new Date().toISOString(),
    requestId: confirmedDraft.requestId
  });
  if (env.DB) await saveDrafts(env.DB, userId, drafts);

  await replyTg(env, chatId, '⏳ Đang kiểm tra ảnh và gửi yêu cầu tạo đơn sang MEEHOA OPS Staging...');

  // 3. Prepare images: load durably from R2 (fallback to Telegram ONLY for legacy refs without r2_key)
  const expectedSampleCount = (draft.sampleRefs || []).length;
  const sampleFiles = [];
  for (const ref of draft.sampleRefs || []) {
    let dataUrl = null;
    if (ref.r2_key) {
      dataUrl = await evidenceDataUrl(ref, env);
      if (!dataUrl) {
        drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await replyTg(env, chatId, '❌ Xác nhận bị hủy: Không đọc được ảnh mẫu đã lưu trong kho ảnh. Đơn nháp được giữ nguyên; vui lòng gửi lại ảnh.');
        return;
      }
    } else if (ref.fileId || ref.file_id) {
      const fileId = ref.fileId || ref.file_id;
      const dl = await downloadTgPhoto(env, fileId, MAX_IMAGE_BYTES);
      if (!dl.ok) {
        drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await replyTg(env, chatId, `❌ Xác nhận bị hủy: Không thể tải ảnh mẫu từ Telegram (${dl.error}). Đơn nháp được giữ nguyên; vui lòng gửi lại ảnh.`);
        return;
      }
      dataUrl = dl.base64Url;
    } else {
      drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
      if (env.DB) await saveDrafts(env.DB, userId, drafts);
      await replyTg(env, chatId, '❌ Xác nhận bị hủy: Thiếu tham chiếu ảnh mẫu hợp lệ. Vui lòng gửi lại ảnh.');
      return;
    }
    sampleFiles.push({ data: dataUrl });
  }

  const expectedBillCount = (draft.draftBillRefs || []).length;
  const unverifiedBillFiles = [];
  for (const ref of draft.draftBillRefs || []) {
    let dataUrl = null;
    if (ref.r2_key) {
      dataUrl = await evidenceDataUrl(ref, env);
      if (!dataUrl) {
        drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await replyTg(env, chatId, '❌ Xác nhận bị hủy: Không đọc được ảnh bill đã lưu trong kho ảnh. Đơn nháp được giữ nguyên; vui lòng gửi lại ảnh.');
        return;
      }
    } else if (ref.fileId || ref.file_id) {
      const fileId = ref.fileId || ref.file_id;
      const dl = await downloadTgPhoto(env, fileId, MAX_IMAGE_BYTES);
      if (!dl.ok) {
        drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await replyTg(env, chatId, `❌ Xác nhận bị hủy: Không thể tải ảnh bill từ Telegram (${dl.error}). Đơn nháp được giữ nguyên; vui lòng gửi lại ảnh.`);
        return;
      }
      dataUrl = dl.base64Url;
    } else {
      drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
      if (env.DB) await saveDrafts(env.DB, userId, drafts);
      await replyTg(env, chatId, '❌ Xác nhận bị hủy: Thiếu tham chiếu ảnh bill hợp lệ. Vui lòng gửi lại ảnh.');
      return;
    }
    unverifiedBillFiles.push({ data: dataUrl });
  }

  if (sampleFiles.length !== expectedSampleCount || unverifiedBillFiles.length !== expectedBillCount) {
    drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
    if (env.DB) await saveDrafts(env.DB, userId, drafts);
    await replyTg(env, chatId, '❌ Xác nhận bị hủy: Số lượng ảnh đọc được không khớp với bản nháp. Vui lòng thử lại.');
    return;
  }

  // Respect OPS HTTP body size limit (12 MB) before calling createOrder
  const samplePayloadBytes = sampleFiles.reduce((sum, f) => sum + (f.data?.length || 0), 0);
  const billPayloadBytes = unverifiedBillFiles.reduce((sum, f) => sum + (f.data?.length || 0), 0);
  if (samplePayloadBytes > MAX_OPS_PAYLOAD_BYTES) {
    drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
    if (env.DB) await saveDrafts(env.DB, userId, drafts);
    await replyTg(env, chatId, '❌ Xác nhận bị hủy: Tổng dung lượng ảnh mẫu vượt quá giới hạn một lần gửi của OPS (tối đa ~8.5 MB tổng ảnh). Vui lòng gửi ảnh nhỏ hơn hoặc giảm số lượng ảnh.');
    return;
  }

  const allBillsInR2 = expectedBillCount > 0 && Boolean(env.DB && env.MEDIA_R2) &&
    (draft.draftBillRefs || []).every(ref => Boolean(ref.r2_key));
  const billsForCreateOrder = (samplePayloadBytes + billPayloadBytes > MAX_OPS_PAYLOAD_BYTES && allBillsInR2)
    ? []
    : unverifiedBillFiles;

  if (samplePayloadBytes + billsForCreateOrder.reduce((sum, f) => sum + (f.data?.length || 0), 0) > MAX_OPS_PAYLOAD_BYTES) {
    drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
    if (env.DB) await saveDrafts(env.DB, userId, drafts);
    await replyTg(env, chatId, '❌ Xác nhận bị hủy: Tổng dung lượng ảnh vượt quá giới hạn một lần gửi của OPS. Vui lòng giảm dung lượng ảnh và thử lại.');
    return;
  }

  // 4. Call OPS Staging API
  const fetcher = env.OPS_SERVICE ? env.OPS_SERVICE.fetch.bind(env.OPS_SERVICE) : fetch;
  const opsRes = await callCreateOrder(
    env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    env.OPS_TOKEN || '',
    drafts[draft.id],
    sampleFiles,
    billsForCreateOrder,
    fetcher,
    { expectedBillCount }
  );

  if (opsRes.ok && opsRes.orderId) {
    const opsUrl = env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core';
    const opsToken = env.OPS_TOKEN || '';
    const { expectedPayment, expectedPaid } = expectedPaymentDetails(draft.fields);
    const paymentSyncRequestId = draft.paymentSyncRequestId || `${confirmedDraft.requestId}:pay:${draft.fields?.paymentState || 'unpaid'}:${expectedPaid}`;

    let finalOpsOrder = opsRes.order || null;
    const returnedPaid = finalOpsOrder ? Number(finalOpsOrder.paid) : null;
    const returnedPayment = finalOpsOrder ? String(finalOpsOrder.payment || '').trim() : '';
    const needsPaymentSync = expectedPaid > 0 && (
      !finalOpsOrder ||
      !Number.isFinite(returnedPaid) ||
      returnedPaid !== expectedPaid ||
      returnedPayment !== expectedPayment
    );

    let paymentSynced = !needsPaymentSync;
    let paymentSyncError = null;
    let paymentRecordedAmount = needsPaymentSync ? (Number.isFinite(returnedPaid) ? returnedPaid : 0) : expectedPaid;

    // Immediately persist submitted + opsOrderId BEFORE any follow-up step
    // so createOrder can NEVER be called twice even if Step 2 or bill linking fails.
    drafts = transitionDraftStatus(drafts, draft.id, 'submitted', {
      opsOrderId: opsRes.orderId,
      submittedAt: new Date().toISOString(),
      paymentSynced,
      paymentSyncRequestId,
      paymentRecordedAmount,
      paymentSyncError: null
    });

    if (env.DB) {
      await saveDrafts(env.DB, userId, drafts);
      await logAudit(env.DB, userId, 'createOrder', draft.id, confirmedDraft.requestId, {
        orderId: opsRes.orderId,
        expectedPayment,
        expectedPaid,
        paymentSynced
      });
    }

    // Step 2 (only if createOrder did not already return verified expected payment/paid)
    if (needsPaymentSync) {
      const syncRes = await syncOrderPaymentToOps({
        opsUrl,
        opsToken,
        orderId: opsRes.orderId,
        expectedPayment,
        expectedPaid,
        requestId: paymentSyncRequestId,
        cleanNote: stripPaymentClaimTags(draft.fields?.note),
        fetcher
      });

      if (syncRes.ok && syncRes.order) {
        finalOpsOrder = syncRes.order;
        paymentSynced = true;
        paymentRecordedAmount = Number(syncRes.order.paid) || 0;
        paymentSyncError = null;
        drafts = transitionDraftStatus(drafts, draft.id, 'submitted', {
          opsOrderId: opsRes.orderId,
          paymentSynced: true,
          paymentSyncRequestId,
          paymentRecordedAmount,
          paymentSyncError: null
        });
        if (env.DB) {
          await saveDrafts(env.DB, userId, drafts);
          await logAudit(env.DB, userId, 'syncPayment', draft.id, paymentSyncRequestId, {
            orderId: opsRes.orderId,
            payment: syncRes.order.payment,
            paid: syncRes.order.paid,
            debt: syncRes.order.debt
          });
        }
      } else {
        paymentSynced = false;
        paymentSyncError = syncRes.message || 'Không thể ghi nhận khoản thanh toán lên OPS.';
        drafts = transitionDraftStatus(drafts, draft.id, 'submitted', {
          opsOrderId: opsRes.orderId,
          paymentSynced: false,
          paymentSyncRequestId,
          paymentRecordedAmount,
          paymentSyncError
        });
        if (env.DB) {
          await saveDrafts(env.DB, userId, drafts);
          await logAudit(env.DB, userId, 'syncPaymentFailed', draft.id, paymentSyncRequestId, {
            orderId: opsRes.orderId,
            code: syncRes.code || 'SYNC_FAILED'
          });
        }
      }
    }

    let billLinkSuccess = true;
    let billLinkError = null;
    let linkedResult = null;

    const opsAlreadyAttachedBills = Array.isArray(finalOpsOrder?.unverifiedBillUrls)
      ? finalOpsOrder.unverifiedBillUrls.length
      : (Array.isArray(finalOpsOrder?.unverified_bill_urls) ? finalOpsOrder.unverified_bill_urls.length : 0);

    if (expectedBillCount > 0 && opsAlreadyAttachedBills >= expectedBillCount) {
      linkedResult = {
        ok: true,
        linked: opsAlreadyAttachedBills,
        verifiedCount: opsAlreadyAttachedBills,
        uris: finalOpsOrder?.unverifiedBillUrls || finalOpsOrder?.unverified_bill_urls || []
      };
    } else if (env.DB && expectedBillCount > 0) {
      linkedResult = await linkUnverifiedBillsToD1Order(
        env.DB,
        opsRes.orderId,
        draft.draftBillRefs,
        env.MEDIA_R2
      );

      if (!linkedResult.ok || (linkedResult.verifiedCount || 0) < expectedBillCount) {
        billLinkSuccess = false;
        billLinkError = linkedResult.error || `Chỉ xác nhận được ${linkedResult.linked || 0}/${expectedBillCount} bill trong đơn.`;
      } else {
        await logAudit(env.DB, userId, 'linkBills', draft.id, confirmedDraft.requestId, {
          orderId: opsRes.orderId,
          linkedCount: linkedResult.linked,
          verifiedCount: linkedResult.verifiedCount,
          uris: linkedResult.uris
        });
      }
    }

    drafts = transitionDraftStatus(drafts, draft.id, 'submitted', {
      opsOrderId: opsRes.orderId,
      billsLinked: expectedBillCount > 0 ? billLinkSuccess : true,
      billLinkError: billLinkError,
      verifiedBillCount: linkedResult?.verifiedCount || 0
    });

    if (env.DB) {
      await saveDrafts(env.DB, userId, drafts);
    }

    const customer = finalOpsOrder?.customer || draft.fields.customer || '';
    const flower = finalOpsOrder?.flower || draft.fields.flower || '';
    const date = finalOpsOrder?.date || draft.fields.date || '';
    const time = finalOpsOrder?.time || draft.fields.time || '';
    const shipping = finalOpsOrder?.shipping || draft.fields.shipping || '';
    const flowerTotal = finalOpsOrder ? Number(finalOpsOrder.flowerTotal) : (Number(draft.fields.flowerTotal) || 0);
    const totalDue = finalOpsOrder ? Number(finalOpsOrder.totalDue ?? flowerTotal) : computeDraftTotal(draft.fields);
    const opsPaymentStr = finalOpsOrder?.payment || (paymentSynced ? expectedPayment : 'Chưa thanh toán');
    const opsPaid = finalOpsOrder ? (Number(finalOpsOrder.paid) || 0) : (paymentSynced ? expectedPaid : 0);
    const opsDebt = finalOpsOrder ? (Number(finalOpsOrder.debt) || 0) : Math.max(0, totalDue - opsPaid);
    const expectedSaleUsername = String(draft.fields?.sale || opsRules.saleDefault || DEFAULT_BOT_SALE).trim();
    const opsSaleUsername = String(finalOpsOrder?.saleUsername || '').trim();
    const opsSaleName = finalOpsOrder?.sale || formatSaleDisplay(expectedSaleUsername, opsRules);
    const saleLine = opsSaleUsername
      ? `🧑‍💼 Sale phụ trách (OPS): ${html(opsSaleName)} (<code>${html(opsSaleUsername)}</code>)\n`
      : `🧑‍💼 Sale phụ trách: ${html(opsSaleName)}\n`;
    const saleMismatchWarning = (opsSaleUsername && opsSaleUsername.toLowerCase() !== expectedSaleUsername.toLowerCase())
      ? `\n⚠️ <b>LƯU Ý SALE PHỤ TRÁCH:</b> OPS đang lưu tài khoản <code>${html(opsSaleUsername)}</code> thay vì <code>${html(expectedSaleUsername)}</code>.\n`
      : '';

    let successMsg = `✅ <b>TẠO ĐƠN THÀNH CÔNG TRÊN MEEHOA OPS STAGING!</b>\n\n` +
      `🆔 <b>Mã đơn:</b> <code>${html(opsRes.orderId)}</code>\n` +
      saleLine +
      `👤 Khách: ${html(customer)}\n` +
      `🌸 Mẫu hoa: ${html(flower)}\n` +
      `📅 Ngày nhận: ${html(date)} lúc ${html(time)}\n` +
      `🚚 Giao nhận: ${html(shipping)}\n` +
      `💰 Tiền hoa: ${flowerTotal.toLocaleString('vi-VN')} đ\n` +
      (totalDue !== flowerTotal ? `🧾 Tổng đơn: ${totalDue.toLocaleString('vi-VN')} đ\n` : '') +
      `💳 Trạng thái OPS: ${html(opsPaymentStr)}\n` +
      `💵 Đã thu: ${opsPaid.toLocaleString('vi-VN')} đ\n` +
      `📌 Còn phải thu: ${opsDebt.toLocaleString('vi-VN')} đ\n` +
      `🖼️ Ảnh mẫu: ${sampleFiles.length} ảnh\n` +
      saleMismatchWarning;

    if (!paymentSynced) {
      successMsg += `\n⚠️ <b>CẢNH BÁO GHI NHẬN THANH TOÁN:</b>\n` +
        `Đơn đã tạo trên OPS nhưng chưa ghi nhận được "${html(expectedPayment)}" (${html(paymentSyncError)}).\n` +
        `👉 Gõ <code>/retry_payment</code> để thử ghi nhận lại vào mã đơn <code>${html(opsRes.orderId)}</code> mà không tạo đơn trùng.\n`;
    }

    if (expectedBillCount > 0) {
      if (billLinkSuccess) {
        successMsg += `🧾 <b>Bill đính kèm:</b> ${expectedBillCount} bill đã liên kết thành công (chưa xác minh — đối soát tại OPS).\n`;
      } else {
        successMsg += `\n⚠️ <b>CẢNH BÁO LIÊN KẾT BILL:</b>\n` +
          `Đã tạo đơn thành công nhưng chưa gắn được ${expectedBillCount} bill vào đơn (${html(billLinkError)}).\n` +
          `👉 Gõ <code>/relink</code> để thử gắn lại bill vào mã đơn <code>${html(opsRes.orderId)}</code> mà không tạo lại đơn mới.\n`;
      }
    }

    successMsg += `\nGõ /new để bắt đầu đơn hàng mới.`;
    await replyTg(env, chatId, successMsg, 'HTML');
  } else {
    // Failure or network issue: rollback confirming -> confirmed so user can retry safely
    drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
    if (env.DB) await saveDrafts(env.DB, userId, drafts);

    await replyTg(
      env,
      chatId,
      `❌ Không thể tạo đơn trên OPS Staging:\n${opsRes.message}\n\nĐơn nháp vẫn được giữ nguyên. Bạn có thể kiểm tra lại và gõ /confirm để thử lại.`
    );
  }
}

/**
 * Resolve an ambiguous pending photo+caption choice ('new' | 'attach' | 'discard').
 */
async function resolvePendingPhotoChoice(drafts, choice, env, userId, chatId) {
  const pending = drafts.__pendingPhoto;
  if (!pending) {
    await replyTg(env, chatId, 'ℹ️ Hiện không có ảnh nào đang chờ chọn nháp.');
    return;
  }

  if (choice === 'discard') {
    const nextDrafts = { ...drafts };
    delete nextDrafts.__pendingPhoto;
    if (env.DB) await saveDrafts(env.DB, userId, nextDrafts);
    if (pending.r2_key && env.MEDIA_R2) {
      await deletePhotoFromR2(env.MEDIA_R2, pending.r2_key);
    }
    await replyTg(env, chatId, '🗑 Đã hủy ảnh đang chờ xử lý. Đơn nháp hiện tại vẫn được giữ nguyên.');
    return;
  }

  if (!env.MEDIA_R2 || !pending.r2_key) {
    await replyTg(env, chatId, '⚠️ Kho ảnh chưa sẵn sàng. Vui lòng gửi lại ảnh.');
    return;
  }

  let sourceBytes = null;
  try {
    const obj = await env.MEDIA_R2.get(pending.r2_key);
    if (obj) {
      sourceBytes = typeof obj.arrayBuffer === 'function'
        ? await obj.arrayBuffer()
        : (obj.buffer || obj.body);
    }
  } catch {
    sourceBytes = null;
  }
  if (!sourceBytes) {
    const nextDrafts = { ...drafts };
    delete nextDrafts.__pendingPhoto;
    if (env.DB) await saveDrafts(env.DB, userId, nextDrafts);
    await replyTg(env, chatId, '❌ Không đọc được ảnh đang chờ trong kho R2. Vui lòng gửi lại ảnh.');
    return;
  }

  let workingDrafts = { ...drafts };
  delete workingDrafts.__pendingPhoto;

  let prevDraft = null;
  if (choice === 'new') {
    prevDraft = activeDraft(workingDrafts);
    // Force a fresh draft even if active somehow became empty
    const created = cmdNew(workingDrafts, '');
    workingDrafts = created.drafts;
  } else if (choice === 'attach') {
    const target = workingDrafts[pending.activeDraftId] || activeDraft(workingDrafts);
    if (!target) {
      await replyTg(env, chatId, '⚠️ Nháp cũ không còn tồn tại. Dùng /new_from_photo để tạo nháp mới.');
      return;
    }
    if (target.status === 'submitted' || target.status === 'confirming') {
      await replyTg(env, chatId, '⚠️ Nháp cũ không thể chỉnh sửa nữa. Dùng /new_from_photo để tạo nháp mới.');
      return;
    }
    if ((target.sampleRefs || []).length >= 10) {
      await replyTg(env, chatId, '⚠️ Nháp hiện tại đã đủ tối đa 10 ảnh mẫu.');
      return;
    }
    workingDrafts.__active = target.id;
  }

  const targetDraft = activeDraft(workingDrafts);
  const newKey = `order-images/sample-${targetDraft.id}-${pending.fileHash || 'img'}.${pending.ext || 'jpg'}`;
  const stored = await savePhotoToR2(env.MEDIA_R2, newKey, sourceBytes, pending.mimeType || 'image/jpeg');
  if (!stored) {
    await replyTg(env, chatId, '⚠️ Chưa lưu được ảnh vào kho lưu trữ. Vui lòng thử lại.');
    return;
  }

  const added = addSampleRef(workingDrafts, pending.fileId, pending.caption || '');
  if (!added.ok) {
    await deletePhotoFromR2(env.MEDIA_R2, newKey);
    await replyTg(env, chatId, `⚠️ ${added.reply}`);
    return;
  }

  workingDrafts = added.drafts;
  const refs = workingDrafts[targetDraft.id].sampleRefs;
  const lastRef = refs[refs.length - 1];
  lastRef.r2_key = newKey;
  lastRef.uri = `supabase://${newKey}`;
  lastRef.mimeType = pending.mimeType || 'image/jpeg';
  lastRef.byteSize = pending.byteSize || 0;

  const opsRules = getCachedOpsOrderRules(env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core', env.OPS_TOKEN || '');
  let aiNotice = null;
  if (pending.caption) {
    const mergedRes = await mergeAiFallback(
      workingDrafts[targetDraft.id],
      pending.caption,
      applyFields(workingDrafts[targetDraft.id], pending.caption, { rules: opsRules }),
      env,
      opsRules,
      userId
    );
    aiNotice = mergedRes.aiNotice || null;
    if (mergedRes.changes?.length || aiNotice) {
      workingDrafts[targetDraft.id] = mergedRes.draft;
    }
  }

  const finalDraft = workingDrafts[targetDraft.id];
  finalDraft.lastUpdateId = Math.max(Number(finalDraft.lastUpdateId) || 0, pending.updateId || 0);
  finalDraft.lastMessageDate = Math.max(Number(finalDraft.lastMessageDate) || 0, pending.messageDate || 0);
  finalDraft.lastMessageId = Math.max(Number(finalDraft.lastMessageId) || 0, pending.messageId || 0);

  try {
    await saveDrafts(env.DB, userId, workingDrafts);
  } catch (saveErr) {
    await deletePhotoFromR2(env.MEDIA_R2, newKey);
    throw saveErr;
  }

  if (pending.r2_key !== newKey) {
    await deletePhotoFromR2(env.MEDIA_R2, pending.r2_key);
  }

  const header = choice === 'new'
    ? `🆕 Đã tạo đơn nháp mới #${finalDraft.id.slice(-6)} (giữ nguyên nháp cũ #${prevDraft?.id?.slice(-6) || ''}):`
    : `📎 Đã gộp ảnh và cập nhật vào nháp #${finalDraft.id.slice(-6)}:`;
  const noticeBlock = aiNotice ? `\n\n${html(aiNotice)}` : '';
  await replyTg(env, chatId, `${html(header)}${noticeBlock}\n\n${html(draftSummary(finalDraft, opsRules))}`, 'HTML');
}

/**
 * Resolve target submitted draft safely for /retry_payment and /relink.
 * Rules:
 *   - When an explicit argument is supplied: ONLY match the FULL OPS order ID (exact case-insensitive)
 *     uniquely among submitted drafts owned by actorUserId. Rejects both unique suffixes and draft IDs.
 *   - When no argument is supplied: ONLY use the currently selected active draft if it is submitted
 *     with an opsOrderId owned by actorUserId. Never falls back to another draft.
 */
export function resolveSubmittedDraftTarget(drafts, arg, actorUserId = null) {
  const draftEntries = Object.entries(drafts || {})
    .filter(([k, d]) => !k.startsWith('__') && d && d.id)
    .map(([, d]) => d);

  const isOwnedByCaller = d => {
    if (!actorUserId) return true;
    const ownerId = d.userId ?? d.ownerUserId;
    return ownerId == null || String(ownerId) === String(actorUserId);
  };

  const trimmed = String(arg || '').trim();
  if (trimmed) {
    const upper = trimmed.toUpperCase();
    const opsCodeMatches = draftEntries.filter(d => d.opsOrderId && String(d.opsOrderId).toUpperCase() === upper);

    if (opsCodeMatches.length > 0) {
      const authorized = opsCodeMatches.filter(isOwnedByCaller);
      if (authorized.length === 0) {
        return { ok: false, reason: 'NOT_AUTHORIZED', query: trimmed };
      }
      const submitted = authorized.filter(d => d.status === 'submitted');
      if (submitted.length === 1) {
        return { ok: true, draft: submitted[0] };
      }
      if (submitted.length > 1) {
        return { ok: false, reason: 'AMBIGUOUS', query: trimmed, matches: submitted };
      }
      return { ok: false, reason: 'NOT_SUBMITTED', query: trimmed, draft: authorized[0] };
    }

    // Explicitly detect draft ID / short suffix attempts so we reject them clearly with zero side effects
    const looksLikeDraftOrSuffix = draftEntries.some(d =>
      String(d.id || '') === trimmed ||
      String(d.id || '').endsWith(trimmed) ||
      (d.opsOrderId && String(d.opsOrderId).toUpperCase().endsWith(upper))
    );
    if (looksLikeDraftOrSuffix) {
      return { ok: false, reason: 'EXACT_OPS_ID_REQUIRED', query: trimmed };
    }
    return { ok: false, reason: 'NOT_FOUND', query: trimmed };
  }

  const active = activeDraft(drafts);
  if (!active) {
    return { ok: false, reason: 'NO_ACTIVE_DRAFT' };
  }
  if (!isOwnedByCaller(active)) {
    return { ok: false, reason: 'NOT_AUTHORIZED', query: active.opsOrderId || active.id };
  }
  if (active.status !== 'submitted' || !active.opsOrderId) {
    return { ok: false, reason: 'ACTIVE_NOT_SUBMITTED', draft: active };
  }
  return { ok: true, draft: active };
}

function formatTargetResolutionError(resolved, commandName) {
  if (resolved.reason === 'EXACT_OPS_ID_REQUIRED') {
    return `⚠️ Lệnh ${commandName} chỉ nhận TOÀN BỘ mã đơn OPS (ví dụ: MEE-...). Từ chối hậu tố ngắn hoặc ID nháp "${resolved.query}". Không có đơn nào bị thay đổi.`;
  }
  if (resolved.reason === 'NOT_FOUND') {
    return `⚠️ Không tìm thấy đơn OPS khớp chính xác mã "${resolved.query}". Không có đơn nào bị thay đổi.`;
  }
  if (resolved.reason === 'NOT_AUTHORIZED') {
    return `🛡️ Bạn không có quyền thao tác đơn "${resolved.query || ''}". Không có đơn nào bị thay đổi.`;
  }
  if (resolved.reason === 'AMBIGUOUS') {
    const options = (resolved.matches || [])
      .slice(0, 5)
      .map(d => d.opsOrderId || `#${String(d.id || '').slice(-6)}`)
      .join(', ');
    return `⚠️ Mã "${resolved.query}" khớp nhiều bản ghi (${options}). Từ chối cập nhật tự động. Không có đơn nào bị thay đổi.`;
  }
  if (resolved.reason === 'NOT_SUBMITTED' || resolved.reason === 'ACTIVE_NOT_SUBMITTED') {
    const shortId = String(resolved.draft?.id || '').slice(-6);
    return `⚠️ Nháp đang chọn #${shortId} chưa tạo đơn trên OPS nên không thể chạy ${commandName}. Dùng /select <id> sang đơn đã tạo hoặc nhập đầy đủ ${commandName} MEE-... . Không có đơn nào bị thay đổi.`;
  }
  return `⚠️ Không có đơn đang chọn hợp lệ trên OPS để chạy ${commandName}. Dùng ${commandName} <mã_đơn_OPS_đầy_đủ> nếu cần. Không có đơn nào bị thay đổi.`;
}

/**
 * Handle /retry_payment (or /sync_payment) command:
 * Safely records verified deposit/bankfull onto an already-created OPS order via getOrder + updateOrder
 * with idempotent paymentSyncRequestId and double-deposit lock. NEVER calls createOrder.
 */
async function handleRetryPaymentCommand(drafts, arg, env, userId, chatId) {
  const resolved = resolveSubmittedDraftTarget(drafts, arg, userId);
  if (!resolved.ok || !resolved.draft?.opsOrderId) {
    await replyTg(env, chatId, formatTargetResolutionError(resolved, '/retry_payment'));
    return;
  }
  const targetDraft = resolved.draft;

  const { expectedPayment, expectedPaid } = expectedPaymentDetails(targetDraft.fields);
  if (expectedPaid <= 0 && expectedPayment === 'Chưa thanh toán') {
    await replyTg(env, chatId, `ℹ️ Đơn ${targetDraft.opsOrderId} đang ở trạng thái Chưa thanh toán, không có khoản cọc/thu nào cần ghi nhận thêm.`);
    return;
  }

  // Double-deposit guard at D1 draft level
  if (targetDraft.paymentSynced === true) {
    await replyTg(
      env,
      chatId,
      `ℹ️ Khoản thanh toán của đơn ${targetDraft.opsOrderId} đã được ghi nhận trước đó (${Number(targetDraft.paymentRecordedAmount || expectedPaid).toLocaleString('vi-VN')} đ). Bot chặn ghi lặp để tránh ghi cọc hai lần.`
    );
    return;
  }

  const paymentSyncRequestId = targetDraft.paymentSyncRequestId || `${targetDraft.requestId || targetDraft.id}:pay:${targetDraft.fields?.paymentState || 'deposit'}:${expectedPaid}`;
  const fetcher = env.OPS_SERVICE ? env.OPS_SERVICE.fetch.bind(env.OPS_SERVICE) : fetch;
  const opsUrl = env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core';
  const opsToken = env.OPS_TOKEN || '';

  const syncRes = await syncOrderPaymentToOps({
    opsUrl,
    opsToken,
    orderId: targetDraft.opsOrderId,
    expectedPayment,
    expectedPaid,
    requestId: paymentSyncRequestId,
    cleanNote: stripPaymentClaimTags(targetDraft.fields?.note),
    fetcher
  });

  if (syncRes.ok && syncRes.order) {
    const o = syncRes.order;
    targetDraft.paymentSynced = true;
    targetDraft.paymentSyncRequestId = paymentSyncRequestId;
    targetDraft.paymentRecordedAmount = Number(o.paid) || 0;
    delete targetDraft.paymentSyncError;

    if (env.DB) {
      await saveDrafts(env.DB, userId, drafts);
      await logAudit(env.DB, userId, 'retryPayment', targetDraft.id, paymentSyncRequestId, {
        orderId: targetDraft.opsOrderId,
        payment: o.payment,
        paid: o.paid,
        debt: o.debt,
        alreadyRecorded: Boolean(syncRes.alreadyRecorded)
      });
    }

    const totalDue = Number(o.totalDue ?? o.flowerTotal) || 0;
    const paid = Number(o.paid) || 0;
    const debt = Number(o.debt) || 0;
    const prefix = syncRes.alreadyRecorded
      ? 'ℹ️ <b>THANH TOÁN ĐÃ ĐƯỢC GHI NHẬN TRƯỚC ĐÓ TRÊN OPS</b>'
      : '✅ <b>ĐÃ ĐỒNG BỘ THANH TOÁN VÀO ĐƠN OPS THÀNH CÔNG!</b>';

    await replyTg(
      env,
      chatId,
      `${prefix}\n\n` +
      `🆔 Đơn: <code>${html(targetDraft.opsOrderId)}</code>\n` +
      `💰 Tổng đơn: ${totalDue.toLocaleString('vi-VN')} đ\n` +
      `💳 Trạng thái OPS: ${html(o.payment)}\n` +
      `💵 Đã thu: ${paid.toLocaleString('vi-VN')} đ\n` +
      `📌 Còn phải thu: ${debt.toLocaleString('vi-VN')} đ`,
      'HTML'
    );
  } else {
    targetDraft.paymentSynced = false;
    targetDraft.paymentSyncRequestId = paymentSyncRequestId;
    targetDraft.paymentSyncError = syncRes.message || 'Lỗi không xác định';
    if (env.DB) await saveDrafts(env.DB, userId, drafts);

    await replyTg(
      env,
      chatId,
      `❌ Đồng bộ thanh toán thất bại cho đơn ${targetDraft.opsOrderId}:\n${targetDraft.paymentSyncError}\n\nĐơn trên OPS vẫn được giữ nguyên (không tạo đơn trùng). Bạn có thể gõ /retry_payment để thử lại.`
    );
  }
}

/**
 * Handle /relink command: Retry linking bill images to an already-created OPS order
 * without calling createOrder again (100% idempotent, zero duplicate orders).
 */
async function handleRelinkCommand(drafts, arg, env, userId, chatId) {
  const resolved = resolveSubmittedDraftTarget(drafts, arg, userId);
  if (!resolved.ok || !resolved.draft?.opsOrderId) {
    await replyTg(env, chatId, formatTargetResolutionError(resolved, '/relink'));
    return;
  }
  const targetDraft = resolved.draft;

  const billCount = targetDraft.draftBillRefs?.length || 0;
  if (billCount === 0) {
    await replyTg(env, chatId, `ℹ️ Đơn ${targetDraft.opsOrderId} không có ảnh bill nào được lưu trong bản nháp.`);
    return;
  }

  if (!env.DB) {
    await replyTg(env, chatId, '⚠️ D1 Database chưa được cấu hình.');
    return;
  }

  await replyTg(env, chatId, `⏳ Đang kiểm tra và liên kết lại ${billCount} bill vào đơn ${targetDraft.opsOrderId}...`);

  const linkResult = await linkUnverifiedBillsToD1Order(
    env.DB,
    targetDraft.opsOrderId,
    targetDraft.draftBillRefs,
    env.MEDIA_R2
  );

  if (linkResult.ok && (linkResult.verifiedCount || 0) >= billCount) {
    targetDraft.billsLinked = true;
    delete targetDraft.billLinkError;
    targetDraft.verifiedBillCount = linkResult.verifiedCount;
    await saveDrafts(env.DB, userId, drafts);
    await logAudit(env.DB, userId, 'relinkBills', targetDraft.id, targetDraft.requestId, {
      orderId: targetDraft.opsOrderId,
      linkedCount: linkResult.linked,
      verifiedCount: linkResult.verifiedCount,
      uris: linkResult.uris
    });

    await replyTg(
      env,
      chatId,
      `✅ <b>LIÊN KẾT BILL THÀNH CÔNG!</b>\n\n` +
      `🆔 Đơn: <code>${html(targetDraft.opsOrderId)}</code>\n` +
      `🧾 Đã liên kết: ${billCount} bill vào đơn OPS Staging.\n` +
      `💳 Thanh toán: Chưa thanh toán (công nợ bảo lưu — vui lòng đối soát tại OPS).`,
      'HTML'
    );
  } else {
    targetDraft.billLinkError = linkResult.error;
    await saveDrafts(env.DB, userId, drafts);
    await replyTg(
      env,
      chatId,
      `❌ Liên kết lại bill thất bại:\n${linkResult.error || 'Lỗi không xác định'}\n\nMã đơn ${targetDraft.opsOrderId} vẫn an toàn trên OPS (không bị tạo trùng).`
    );
  }
}
