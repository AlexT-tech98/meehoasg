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
9. note: Lưu ý của khách / ghi chú đơn hàng / lời dặn gói hoa hoặc giao hàng (chuỗi, 0 đ). MỌI dòng ghi "Lưu ý khách", "Lưu ý", "Lưu ý đơn", "Khách dặn", "Note", "Ghi chú" PHẢI đưa vào note, TUYỆT ĐỐI KHÔNG đưa vào cardText.
10. tagNoteFree: Nội dung in Tag note / Tag note free / tag miễn phí (chuỗi, 0 đ). MỌI dòng ghi "Tag note", "Tag note free", "tag miễn phí", "tag" PHẢI đưa vào tagNoteFree, TUYỆT ĐỐI KHÔNG đưa vào cardText hay cardQty.
11. cardText: Nội dung viết THIỆP TRẢ PHÍ (+10.000 đ/cái). CHỈ trích xuất khi tin nhắn ghi rõ khách mua/lấy thiệp trả phí (có chữ "thiệp" hoặc "card" ngoài dòng Note/Tag note). Nếu không nói rõ lấy thiệp trả phí thì BẮT BUỘC để null.
12. bannerText: Nội dung in banner/dải ruy băng (chuỗi).
13. cardQty: Số lượng thiệp trả phí (số nguyên từ 1-99, CHỈ trả khi có đề cập mua/lấy thiệp trả phí; mặc định null nếu không có).
14. bannerQty: Số lượng banner (số nguyên từ 1-99, CHỈ trả khi có đề cập banner; mặc định null nếu không có banner).
15. shipFee: Phí ship theo VNĐ (số nguyên > 0, ví dụ 45k -> 45000) CHỈ KHI tin nhắn/ghi chú nêu rõ phí ship/tiền ship; nếu không nêu rõ phí ship thì BẮT BUỘC để null, tuyệt đối không tự đoán.

QUY TẮC BẢO MẬT & CHÍNH XÁC:
- TUYỆT ĐỐI KHÔNG tự bịa hoặc suy đoán bất kỳ trường quan trọng nào (tên khách, SĐT, ngày, giờ, địa chỉ, hình thức ship, giá tiền, phí ship). Trường nào không có trong tin nhắn thì để null.
- Không tự gán shipFee nếu khách không ghi rõ số tiền phí ship.
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
  'tagNoteFree',
  'cardText',
  'bannerText',
  'cardQty',
  'bannerQty',
  'shipFee'
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

export const CORRUPTED_CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/;

export function hasCorruptedControlChars(value) {
  return typeof value === 'string' && CORRUPTED_CONTROL_CHAR_REGEX.test(value);
}

export function findCorruptedAiFields(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const corrupted = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (!ALLOWED_AI_FIELDS.has(k)) continue;
    if (typeof v === 'string' && hasCorruptedControlChars(v)) {
      corrupted.push(k);
    }
  }
  return corrupted;
}

/**
 * Sanitize AI-extracted fields against strict allowlist and anti-guesswork rules.
 * Strips fields containing ASCII control characters or Unicode replacement chars so corrupted
 * model tokens can never pollute drafts or OPS orders, while preserving valid Vietnamese fields.
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
    if (typeof v === 'string' && hasCorruptedControlChars(v)) continue;
    const cleaned = String(v).replace(/[\r\n]+/g, ' ').trim();
    if (!cleaned) continue;
    if (PLACEHOLDER_VALUES.has(cleaned.toLowerCase())) continue;
    if (k === 'cardQty' || k === 'bannerQty') {
      const qty = Math.floor(Number(cleaned));
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) continue;
      result[k] = qty;
      continue;
    }
    if (k === 'shipFee') {
      const fee = Math.round(Number(cleaned));
      if (!Number.isFinite(fee) || fee <= 0) continue;
      result[k] = fee;
      continue;
    }
    result[k] = typeof v === 'number' ? v : cleaned;
  }
  return Object.keys(result).length ? result : null;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';
export const DEFAULT_GEMINI_TIMEOUT_MS = 20000;

/**
 * Total time budget for the entire AI extraction (including backoff retries).
 * Kept safely below Cloudflare Worker & Telegram webhook response expectations.
 */
export const TOTAL_AI_BUDGET_MS = 36000;

/** HTTP status codes that are transient and safe to retry. */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Parse an HTTP Retry-After header (integer seconds or HTTP-date) into milliseconds.
 * @param {string|null|undefined} headerVal
 * @param {number} [nowMs=Date.now()]
 * @returns {number}
 */
export function parseRetryAfterMs(headerVal, nowMs = Date.now()) {
  if (!headerVal) return 0;
  const raw = String(headerVal).trim();
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const secs = Number(raw);
    return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : 0;
  }
  const targetMs = Date.parse(raw);
  if (!Number.isFinite(targetMs)) return 0;
  return Math.max(0, targetMs - nowMs);
}

/**
 * Compute retry delay (ms) respecting Retry-After header when present.
 * Uses exponential backoff capped at maxDelay when Retry-After is absent or smaller.
 * @param {number} attempt - 0-based retry index (0 = first retry)
 * @param {number} [retryAfterMs=0] - value of Retry-After header in ms (0 = none)
 * @param {number} [maxDelay=8000]
 * @param {number} [baseDelay=1000]
 */
export function retryDelayMs(attempt, retryAfterMs = 0, maxDelay = 8000, baseDelay = 1000) {
  const backoff = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const ra = Number(retryAfterMs);
  return Math.max(backoff, Number.isFinite(ra) && ra > 0 ? ra : 0);
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
    tagNoteFree: { type: 'STRING', nullable: true },
    cardText: { type: 'STRING', nullable: true },
    bannerText: { type: 'STRING', nullable: true },
    cardQty: { type: 'INTEGER', nullable: true },
    bannerQty: { type: 'INTEGER', nullable: true },
    shipFee: { type: 'INTEGER', nullable: true }
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
  let stage = 'connect';
  let isSseHeader = false;
  let sseParsedCount = 0;

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
      stage = 'http_status';
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startedAt;
      let errMsg = `HTTP_${res.status}`;
      let retryAfterMs = 0;
      try {
        const retryAfterRaw = res.headers?.get?.('retry-after') || null;
        retryAfterMs = parseRetryAfterMs(retryAfterRaw);
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
        stage,
        thoughtParts: 0,
        textParts: 0,
        finishReason: null,
        error: errMsg,
        retryAfterMs,
        retryable: RETRYABLE_STATUSES.has(Number(state.status))
      };
    }

    stage = 'sse_read';
    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    isSseHeader = contentType.includes('text/event-stream');
    let rawBody = '';
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
      stage = 'json_parse';
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
        stage: 'sse_read',
        thoughtParts: state.thoughtParts,
        textParts: state.textParts,
        finishReason: state.finishReason,
        error: 'EMPTY_RESPONSE',
        retryAfterMs: 0,
        retryable: state.finishReason !== 'STOP' && (isSseHeader || sseParsedCount > 0)
      };
    }

    stage = 'json_parse';
    // Clean JSON markdown fences if any
    const jsonStr = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    stage = 'sanitize';
    const corruptedFields = findCorruptedAiFields(parsed);
    return {
      ok: true,
      fields: sanitizeAiFields(parsed),
      corruptedFields: corruptedFields.length ? corruptedFields : undefined,
      model: activeModel,
      endpoint: endpointName,
      status: state.status,
      headersMs: state.headersMs,
      latencyMs,
      stage,
      thoughtParts: state.thoughtParts,
      textParts: state.textParts,
      finishReason: state.finishReason
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startedAt;
    const isAbort = err?.name === 'AbortError' || /AbortError/i.test(String(err?.message || ''));
    let errorCode;
    let retryable = false;

    if (stage === 'json_parse' || err?.name === 'SyntaxError') {
      stage = 'json_parse';
      errorCode = 'INVALID_JSON';
      retryable = Boolean(sseParsedCount > 0 && state.finishReason !== 'STOP');
    } else if (stage === 'sse_read') {
      errorCode = isAbort ? 'AbortError' : 'STREAM_INTERRUPTED';
      retryable = true;
    } else {
      stage = 'connect';
      errorCode = isAbort ? 'AbortError' : 'NETWORK_ERROR';
      retryable = true;
    }

    console.warn(`[gemini] Extraction failed at stage=${stage}:`, errorCode);
    return {
      ok: false,
      fields: null,
      model: activeModel,
      endpoint: endpointName,
      status: state.status,
      headersMs: state.headersMs,
      latencyMs,
      stage,
      thoughtParts: state.thoughtParts,
      textParts: state.textParts,
      finishReason: state.finishReason,
      error: errorCode,
      retryAfterMs: 0,
      retryable
    };
  }
}

/**
 * Extract order fields from conversational text using Gemini SSE streaming API with telemetry.
 *
 * Endpoint routing policy:
 * - Primary endpoint defaults to `generativelanguage.googleapis.com` (evidence from Staging shows
 *   generativelanguage accepts the Worker's API key and routes to `gemini-4-hydrogen`), unless
 *   `options.preferredEndpoint === 'aiplatform'` is explicitly passed.
 * - Falls back once to the secondary endpoint only on auth/config errors (`400`, `401`, `403`, `404`)
 *   when the key uses the `AQ.` Vertex Express prefix or `preferredEndpoint === 'aiplatform'`.
 *
 * Retry policy for transient failures (`429`, `500`, `502`, `503`, `504`, `AbortError`, `NETWORK_ERROR`,
 * `STREAM_INTERRUPTED`, or truncated SSE `EMPTY_RESPONSE` / `INVALID_JSON`):
 * - Retries on the SAME endpoint up to `maxRetries` (default 2 -> up to 3 total attempts on primary).
 * - Uses exponential backoff (`retryDelayMs`) and respects HTTP `Retry-After` if within `budgetMs`.
 * - Hard-enforces `budgetMs` (default `TOTAL_AI_BUDGET_MS = 36000`).
 *
 * @returns {Promise<{ok: boolean, fields: object|null, model: string, endpoint?: string, latencyMs: number, headersMs?: number|null, status?: number|null, stage?: string, thoughtParts?: number, textParts?: number, finishReason?: string|null, error?: string, retries?: number, budgetExhausted?: boolean, attempts?: Array}>}
 */
export async function extractFieldsWithGeminiDetailed(
  apiKey,
  text,
  model = DEFAULT_GEMINI_MODEL,
  fetcher = fetch,
  timeoutMs = DEFAULT_GEMINI_TIMEOUT_MS,
  options = {}
) {
  const activeModel = String(model || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  if (!apiKey) return { ok: false, fields: null, model: activeModel, latencyMs: 0, stage: 'connect', error: 'NO_API_KEY', retries: 0, attempts: [] };
  if (!text || text.trim().length < 5) return { ok: false, fields: null, model: activeModel, latencyMs: 0, stage: 'connect', error: 'TEXT_TOO_SHORT', retries: 0, attempts: [] };

  // Send raw verbatim caption text (photos & bills stay strictly outside AI); never log full caption.
  const body = buildGeminiRequestBody(String(text), activeModel);
  const opts = (typeof timeoutMs === 'object' && timeoutMs !== null) ? timeoutMs : (options || {});
  const rawTimeout = typeof timeoutMs === 'object' ? DEFAULT_GEMINI_TIMEOUT_MS : timeoutMs;
  const effectiveTimeout = Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0 ? Number(rawTimeout) : DEFAULT_GEMINI_TIMEOUT_MS;
  const effectiveBudgetMs = Number.isFinite(Number(opts.budgetMs)) && Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : TOTAL_AI_BUDGET_MS;
  const effectiveMaxRetries = Number.isInteger(Number(opts.maxRetries)) && Number(opts.maxRetries) >= 0 ? Number(opts.maxRetries) : 2;
  const effectiveBaseDelayMs = Number.isFinite(Number(opts.baseDelayMs)) && Number(opts.baseDelayMs) >= 0 ? Number(opts.baseDelayMs) : 1000;
  const preferredEndpoint = opts.preferredEndpoint === 'aiplatform' ? 'aiplatform' : 'generativelanguage';

  const endpointUrl = name => name === 'aiplatform'
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(activeModel)}:streamGenerateContent?alt=sse`
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:streamGenerateContent?alt=sse`;

  const budgetStart = Date.now();
  const minReserve = Math.min(1500, Math.max(50, Math.floor(effectiveTimeout / 2)));
  const attempts = [];
  let retries = 0;
  let didFallback = false;
  let currentEndpoint = preferredEndpoint;
  let lastRes = null;

  while (true) {
    const remaining = effectiveBudgetMs - (Date.now() - budgetStart);
    if (attempts.length > 0 && remaining <= minReserve) {
      return {
        ...(lastRes || {
          ok: false,
          fields: null,
          model: activeModel,
          endpoint: currentEndpoint,
          status: null,
          headersMs: null,
          thoughtParts: 0,
          textParts: 0,
          finishReason: null,
          stage: 'connect',
          error: 'BUDGET_EXCEEDED'
        }),
        latencyMs: Date.now() - budgetStart,
        retries,
        budgetExhausted: true,
        attempts
      };
    }

    const callTimeout = attempts.length === 0
      ? Math.min(effectiveTimeout, effectiveBudgetMs)
      : Math.min(effectiveTimeout, Math.max(50, remaining - Math.min(500, Math.floor(remaining / 4))));

    const res = await executeGeminiCall(
      endpointUrl(currentEndpoint),
      currentEndpoint,
      apiKey,
      body,
      fetcher,
      activeModel,
      callTimeout
    );
    lastRes = res;

    attempts.push({
      attempt: attempts.length + 1,
      endpoint: res.endpoint,
      status: res.status ?? null,
      headersMs: res.headersMs ?? null,
      latencyMs: res.latencyMs,
      thoughtParts: res.thoughtParts ?? 0,
      textParts: res.textParts ?? 0,
      finishReason: res.finishReason || null,
      stage: res.stage || null,
      error: res.ok ? null : (res.error || 'UNKNOWN'),
      retryAfterMs: res.retryAfterMs || 0,
      corruptedFields: res.corruptedFields || []
    });

    if (res.ok && (!res.corruptedFields || res.corruptedFields.length === 0)) {
      return {
        ...res,
        fields: res.fields,
        latencyMs: Date.now() - budgetStart,
        retries,
        budgetExhausted: false,
        attempts
      };
    }

    if (res.ok && Array.isArray(res.corruptedFields) && res.corruptedFields.length > 0) {
      if (retries >= effectiveMaxRetries) {
        return {
          ...res,
          fields: res.fields,
          latencyMs: Date.now() - budgetStart,
          retries,
          budgetExhausted: false,
          attempts
        };
      }
      const delay = retryDelayMs(retries, 0, 8000, effectiveBaseDelayMs);
      const budgetLeft = effectiveBudgetMs - (Date.now() - budgetStart);
      if (delay + minReserve > budgetLeft) {
        return {
          ...res,
          fields: res.fields,
          latencyMs: Date.now() - budgetStart,
          retries,
          budgetExhausted: true,
          attempts
        };
      }
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
      retries += 1;
      continue;
    }

    // Secondary endpoint fallback ONLY on true auth/credential errors ([401, 403]) for AQ. keys or aiplatform probes.
    // Never fall back to aiplatform on 400 (geo restriction) or 404 (model availability) when aiplatform is disabled.
    const canFallback = !didFallback &&
      [401, 403].includes(Number(res.status)) &&
      (String(apiKey).startsWith('AQ.') || opts.preferredEndpoint === 'aiplatform');

    if (canFallback) {
      didFallback = true;
      currentEndpoint = currentEndpoint === 'generativelanguage' ? 'aiplatform' : 'generativelanguage';
      continue;
    }

    const isTransient = Boolean(res.retryable) ||
      RETRYABLE_STATUSES.has(Number(res.status)) ||
      res.error === 'AbortError' ||
      res.error === 'NETWORK_ERROR' ||
      res.error === 'STREAM_INTERRUPTED';

    if (!isTransient || retries >= effectiveMaxRetries) {
      return {
        ...res,
        latencyMs: Date.now() - budgetStart,
        retries,
        budgetExhausted: false,
        attempts
      };
    }

    const delay = retryDelayMs(retries, res.retryAfterMs || 0, 8000, effectiveBaseDelayMs);
    const budgetLeft = effectiveBudgetMs - (Date.now() - budgetStart);
    if (delay + minReserve > budgetLeft) {
      return {
        ...res,
        latencyMs: Date.now() - budgetStart,
        retries,
        budgetExhausted: true,
        attempts
      };
    }

    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }
    retries += 1;
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
