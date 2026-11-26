/**
 * MEEHOA Order Bot V1 — Gemini AI Natural Language Extraction (Cloudflare Worker)
 *
 * Extracts structured order fields from Vietnamese conversational messages.
 * Uses Google Generative Language API with strict JSON schema constraints.
 * Falls back safely to null if AI is unavailable or fails.
 */

const SYSTEM_PROMPT = `Bạn là trợ lý AI chuyên trích xuất thông tin đơn đặt hoa tươi cho tiệm MEEHOA.
Nhiệm vụ: Phân tích tin nhắn của khách hàng và trích xuất các trường thông tin đơn hàng sang định dạng JSON.

Quy tắc trích xuất:
1. customer: Tên khách hàng (chuỗi, bỏ các xưng hô thừa như chị, em, anh). Không tự đoán nếu không có tên cụ thể.
2. phone: Số điện thoại nhận hoặc đặt hoa (chuỗi). Không tự đoán nếu không có trong tin nhắn.
3. flower: Mô tả hoa hoặc mẫu hoa (chuỗi).
4. date: Ngày nhận hoa. Nếu có đủ năm thì trả YYYY-MM-DD; nếu chỉ có DD/MM thì giữ nguyên DD/MM (KHÔNG tự bịa năm). Nếu không có ngày rõ ràng thì để null.
5. time: Giờ nhận hoa định dạng HH:MM (24h). Ví dụ: 9h -> 09:00, 14h30 -> 14:30. Nếu không rõ giờ cụ thể thì để null.
6. shipping: Chỉ được chọn 1 trong 3 giá trị chính xác: "Shop book ship", "Khách tự book", "Ghé lấy". Nếu không nói rõ thì để null.
7. address: Địa chỉ giao hàng chi tiết (chuỗi). Nếu không nói rõ thì để null.
8. flowerTotal: Tổng tiền hoa (số nguyên, ví dụ: 850k -> 850000, 1tr5 -> 1500000). Bỏ các phụ kiện. Nếu không rõ giá thì để null.
9. note: Ghi chú lời dặn của khách (chuỗi).
10. cardText: Nội dung viết thiệp chúc mừng (chuỗi).
11. bannerText: Nội dung in banner/dải ruy băng (chuỗi).

QUY TẮC BẢO MẬT & CHÍNH XÁC:
- TUYỆT ĐỐI KHÔNG tự bịa hoặc suy đoán bất kỳ trường quan trọng nào (tên khách, SĐT, ngày, giờ, địa chỉ, hình thức ship, giá tiền). Trường nào không có trong tin nhắn thì để null.
- TUYỆT ĐỐI KHÔNG trích xuất hoặc thay đổi trạng thái thanh toán, công nợ, full paid, quyền admin hoặc vai trò hệ thống.
- KHÔNG đoán mẫu hoa từ ảnh; flower chỉ lấy khi tin nhắn mô tả rõ mẫu/loại hoa.
- Cụm "Shop book ship", "ship", "giao", "book ship" là hình thức giao nhận, KHÔNG phải tên khách.
- Tin nhắn có thể chỉ bổ sung một phần (ví dụ chỉ thêm địa chỉ); chỉ trả các trường thật sự có trong tin nhắn này, các trường khác để null.
- Không trả trường sale, payment, paid, debt, fullPaid; hệ thống tự gán Sale C Mụi và xử lý thanh toán riêng.
- Chỉ trả về duy nhất chuỗi JSON hợp lệ không có markdown backticks.`;

export const ALLOWED_AI_FIELDS = new Set([
  'customer',
  'phone',
  'flower',
  'date',
  'time',
  'shipping',
  'address',
  'flowerTotal',
  'note',
  'cardText',
  'bannerText'
]);

const PLACEHOLDER_VALUES = new Set([
  'null',
  'undefined',
  'n/a',
  'na',
  'none',
  'unknown',
  'tbd',
  'không rõ',
  'khong ro',
  'chưa rõ',
  'chua ro',
  'không có',
  'khong co',
  'chưa có',
  'chua co'
]);

/**
 * Sanitize AI-extracted fields against strict allowlist and anti-guesswork rules.
 * @param {object} parsed
 * @returns {object|null}
 */
export function sanitizeAiFields(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!ALLOWED_AI_FIELDS.has(k)) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    const cleaned = String(v).replace(/[\r\n]+/g, ' ').trim();
    if (!cleaned) continue;
    if (PLACEHOLDER_VALUES.has(cleaned.toLowerCase())) continue;
    result[k] = typeof v === 'number' ? v : cleaned;
  }
  return Object.keys(result).length ? result : null;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';
export const DEFAULT_GEMINI_TIMEOUT_MS = 40000;

/**
 * Total time budget for the entire AI extraction (including retries).
 * Cloudflare Workers limit: CPU 50ms + subrequest wall time, but we control fetch timeouts.
 * Keep well under Telegram's 60s response expectation.
 */
export const TOTAL_AI_BUDGET_MS = 55000;

/** HTTP status codes that are transient and safe to retry. */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Compute retry delay (ms) respecting Retry-After header when present.
 * Uses exponential backoff capped at maxDelay.
 * @param {number} attempt - 0-based attempt index (0 = first retry)
 * @param {number} retryAfterMs - value of Retry-After header in ms (0 = none)
 * @param {number} [maxDelay=8000]
 */
export function retryDelayMs(attempt, retryAfterMs = 0, maxDelay = 8000) {
  const backoff = Math.min(1000 * Math.pow(2, attempt), maxDelay);
  return Math.max(backoff, retryAfterMs);
}

export const ORDER_EXTRACTION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    customer: { type: 'STRING', nullable: true },
    phone: { type: 'STRING', nullable: true },
    flower: { type: 'STRING', nullable: true },
    date: { type: 'STRING', nullable: true },
    time: { type: 'STRING', nullable: true },
    shipping: { type: 'STRING', nullable: true },
    address: { type: 'STRING', nullable: true },
    flowerTotal: { type: 'INTEGER', nullable: true },
    note: { type: 'STRING', nullable: true },
    cardText: { type: 'STRING', nullable: true },
    bannerText: { type: 'STRING', nullable: true }
  }
};

/**
 * Build the Gemini generateContent/streamGenerateContent request body.
 * - Gemini 4 models (e.g. gemini-4-hydrogen) deprecate `temperature` and default to `thinkingLevel="HIGH"`,
 *   so we omit `temperature` on Gemini 3/4 and force `thinkingLevel: "LOW"`.
 * - We enforce structured JSON output with `responseSchema` + `maxOutputTokens: 2048` to prevent long/runaway loops.
 */
export function buildGeminiRequestBody(text, model = DEFAULT_GEMINI_MODEL) {
  const activeModel = String(model || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: ORDER_EXTRACTION_RESPONSE_SCHEMA,
    maxOutputTokens: 2048
  };
  if (/^gemini-[34]/i.test(activeModel)) {
    generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
  } else {
    generationConfig.temperature = 0.1;
  }
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${SYSTEM_PROMPT}\n\nTin nhắn khách hàng:\n"""\n${text}\n"""` }
        ]
      }
    ],
    generationConfig
  };
}

function collectCandidateChunk(payload, state) {
  const candidate = payload?.candidates?.[0];
  if (!candidate) return;
  if (candidate.finishReason) {
    state.finishReason = candidate.finishReason;
  }
  const parts = candidate.content?.parts || [];
  for (const p of parts) {
    if (!p || typeof p.text !== 'string') continue;
    if (p.thought === true) {
      state.thoughtParts += 1;
      continue;
    }
    if (p.text.length > 0) {
      state.textParts += 1;
      state.textBuffer += p.text;
    }
  }
}

async function executeGeminiCall(url, endpointName, apiKey, body, fetcher, activeModel, effectiveTimeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
  const startedAt = Date.now();
  const state = {
    status: null,
    headersMs: null,
    thoughtParts: 0,
    textParts: 0,
    textBuffer: '',
    finishReason: null
  };

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    state.status = res.status;
    state.headersMs = Date.now() - startedAt;

    if (!res.ok) {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startedAt;
      let errMsg = `HTTP_${res.status}`;
      let retryAfterRaw = null;
      try {
        retryAfterRaw = res.headers?.get?.('retry-after') || null;
        const errText = await res.text();
        const errJson = JSON.parse(errText);
        if (errJson?.error?.status || errJson?.error?.message) {
          errMsg = `${res.status} ${errJson.error.status || ''}: ${String(errJson.error.message || '').slice(0, 180)}`.trim();
        }
      } catch {}
      console.warn(`[gemini] API responded with HTTP ${res.status} (model=${activeModel}, endpoint=${endpointName})`);
      return {
        ok: false,
        fields: null,
        model: activeModel,
        endpoint: endpointName,
        status: state.status,
        headersMs: state.headersMs,
        latencyMs,
        thoughtParts: 0,
        textParts: 0,
        finishReason: null,
        error: errMsg,
        _retryAfter: retryAfterRaw
      };
    }

    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    const isSseHeader = contentType.includes('text/event-stream');
    let rawBody = '';
    let sseParsedCount = 0;
    let sseLineBuffer = '';

    const processSseLine = rawLine => {
      const line = rawLine.replace(/\r$/, '');
      if (!line.startsWith('data:')) return;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') return;
      try {
        const chunkJson = JSON.parse(dataStr);
        collectCandidateChunk(chunkJson, state);
        sseParsedCount += 1;
      } catch {
        // Ignore malformed partial/heartbeat frame
      }
    };

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const textChunk = decoder.decode(value, { stream: true });
        rawBody += textChunk;
        sseLineBuffer += textChunk;
        if (isSseHeader || /^\s*data:/.test(rawBody)) {
          const lines = sseLineBuffer.split('\n');
          sseLineBuffer = lines.pop() ?? '';
          for (const line of lines) processSseLine(line);
        }
      }
      const tail = decoder.decode();
      if (tail) {
        rawBody += tail;
        sseLineBuffer += tail;
      }
      if (sseLineBuffer && (isSseHeader || /^\s*data:/.test(rawBody))) {
        for (const line of sseLineBuffer.split('\n')) processSseLine(line);
      }
    } else if (typeof res.text === 'function') {
      rawBody = await res.text();
      if (isSseHeader || /^\s*data:/.test(rawBody)) {
        for (const line of rawBody.split('\n')) processSseLine(line);
      }
    } else {
      const jsonObj = await res.json();
      collectCandidateChunk(jsonObj, state);
    }

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startedAt;

    if (sseParsedCount === 0 && !state.textBuffer && rawBody.trim()) {
      const parsedPayload = JSON.parse(rawBody);
      collectCandidateChunk(parsedPayload, state);
    }

    const rawText = state.textBuffer.trim();
    if (!rawText) {
      return {
        ok: false,
        fields: null,
        model: activeModel,
        endpoint: endpointName,
        status: state.status,
        headersMs: state.headersMs,
        latencyMs,
        thoughtParts: state.thoughtParts,
        textParts: state.textParts,
        finishReason: state.finishReason,
        error: 'EMPTY_RESPONSE'
      };
    }

    // Clean JSON markdown fences if any
    const jsonStr = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      ok: true,
      fields: sanitizeAiFields(parsed),
      model: activeModel,
      endpoint: endpointName,
      status: state.status,
      headersMs: state.headersMs,
      latencyMs,
      thoughtParts: state.thoughtParts,
      textParts: state.textParts,
      finishReason: state.finishReason
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startedAt;
    console.warn('[gemini] Extraction failed or timed out:', err?.name || 'Error');
    return {
      ok: false,
      fields: null,
      model: activeModel,
      endpoint: endpointName,
      status: state.status,
      headersMs: state.headersMs,
      latencyMs,
      thoughtParts: state.thoughtParts,
      textParts: state.textParts,
      finishReason: state.finishReason,
      error: err?.name || 'NETWORK_ERROR'
    };
  }
}

/**
 * Extract order fields from conversational text using Gemini SSE streaming API with telemetry.
 *
 * Key routing logic:
 * - Keys starting with `AQ.` are Vertex Express keys — use `aiplatform.googleapis.com` as PRIMARY.
 *   Falls back to `generativelanguage.googleapis.com` only on 401/403 (key mismatch).
 * - All other keys use `generativelanguage.googleapis.com` as primary.
 *   Falls back to `aiplatform.googleapis.com` on 400/401/403/503 (rate-limit / unavailable).
 *
 * Retry policy (transient errors 429/500/502/503/504):
 * - Up to 2 retries on the SAME endpoint (same key routing), with exponential backoff.
 * - Respects `Retry-After` header when present and within budget.
 * - Total elapsed must not exceed TOTAL_AI_BUDGET_MS (55 s) including all retries.
 * - Non-retryable errors (400/401/403, timeout, bad JSON) return immediately.
 *
 * @returns {Promise<{ok: boolean, fields: object|null, model: string, endpoint?: string, latencyMs: number, headersMs?: number|null, status?: number|null, thoughtParts?: number, textParts?: number, finishReason?: string|null, error?: string, retries?: number}>}
 */
export async function extractFieldsWithGeminiDetailed(apiKey, text, model = DEFAULT_GEMINI_MODEL, fetcher = fetch, timeoutMs = DEFAULT_GEMINI_TIMEOUT_MS) {
  const activeModel = String(model || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  if (!apiKey) return { ok: false, fields: null, model: activeModel, latencyMs: 0, error: 'NO_API_KEY' };
  if (!text || text.trim().length < 5) return { ok: false, fields: null, model: activeModel, latencyMs: 0, error: 'TEXT_TOO_SHORT' };

  const body = buildGeminiRequestBody(text, activeModel);
  const effectiveTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_GEMINI_TIMEOUT_MS;

  const isVertexExpressKey = String(apiKey).startsWith('AQ.');
  const aiplatformUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(activeModel)}:streamGenerateContent?alt=sse`;
  const genaiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:streamGenerateContent?alt=sse`;

  /**
   * Run one attempt on a URL, then retry on transient failures (up to maxRetries).
   * Returns the last result when retries exhausted or budget exceeded.
   */
  async function tryWithRetry(primaryUrl, primaryName, fallbackUrl, fallbackName, fallbackOnStatuses) {
    const budgetStart = Date.now();
    let retries = 0;
    const MAX_RETRIES = 2;

    while (true) {
      const remaining = TOTAL_AI_BUDGET_MS - (Date.now() - budgetStart);
      if (remaining <= 2000) {
        // Not enough budget left for another attempt
        return {
          ok: false, fields: null, model: activeModel,
          endpoint: primaryName, status: null, latencyMs: Date.now() - budgetStart,
          headersMs: null, thoughtParts: 0, textParts: 0, finishReason: null,
          error: 'BUDGET_EXCEEDED', retries
        };
      }
      const callTimeout = Math.min(effectiveTimeout, remaining - 500);
      const res = await executeGeminiCall(primaryUrl, primaryName, apiKey, body, fetcher, activeModel, callTimeout);

      // Success
      if (res.ok) return { ...res, retries };

      // Check if fallback is applicable (different endpoint)
      if (fallbackUrl && fallbackOnStatuses.includes(Number(res.status))) {
        const fbRemaining = TOTAL_AI_BUDGET_MS - (Date.now() - budgetStart);
        if (fbRemaining > 2000) {
          const fbRes = await executeGeminiCall(fallbackUrl, fallbackName, apiKey, body, fetcher, activeModel, Math.min(effectiveTimeout, fbRemaining - 500));
          return { ...fbRes, retries };
        }
      }

      // Retryable transient error on primary
      const isTransient = RETRYABLE_STATUSES.has(Number(res.status)) || res.error === 'AbortError';
      if (!isTransient || retries >= MAX_RETRIES) return { ...res, retries };

      // Parse Retry-After (supports seconds integer and HTTP-date)
      let retryAfterMs = 0;
      if (res._retryAfter) {
        const ra = parseInt(res._retryAfter, 10);
        retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0;
      }

      const delay = retryDelayMs(retries, retryAfterMs);
      const budgetLeft = TOTAL_AI_BUDGET_MS - (Date.now() - budgetStart);
      if (delay >= budgetLeft - 2000) return { ...res, retries };

      await new Promise(r => setTimeout(r, delay));
      retries += 1;
    }
  }

  if (isVertexExpressKey) {
    // Vertex Express key → aiplatform.googleapis.com is primary
    // Fall back to generativelanguage only on hard auth failure (401/403)
    return tryWithRetry(aiplatformUrl, 'aiplatform', genaiUrl, 'generativelanguage', [401, 403]);
  } else {
    // Standard API key → generativelanguage primary
    // Fall back to aiplatform on auth error or server overload (400/401/403/503)
    return tryWithRetry(genaiUrl, 'generativelanguage', aiplatformUrl, 'aiplatform', [400, 401, 403, 503]);
  }
}

/**
 * Extract order fields from conversational text using Gemini API.
 * @param {string} apiKey - Gemini API Key
 * @param {string} text - Message text from user
 * @param {string} [model='gemini-4-hydrogen'] - Gemini model name
 * @param {Function} [fetcher=fetch] - Fetch implementation
 * @returns {Promise<object|null>} Extracted fields object or null on failure
 */
export async function extractFieldsWithGemini(apiKey, text, model = DEFAULT_GEMINI_MODEL, fetcher = fetch) {
  const res = await extractFieldsWithGeminiDetailed(apiKey, text, model, fetcher);
  return res.ok ? res.fields : null;
}
