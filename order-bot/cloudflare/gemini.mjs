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

/**
 * Extract order fields from conversational text using Gemini API.
 * @param {string} apiKey - Gemini API Key
 * @param {string} text - Message text from user
 * @param {string} [model='gemini-2.5-flash'] - Gemini model name
 * @param {Function} [fetcher=fetch] - Fetch implementation
 * @returns {Promise<object|null>} Extracted fields object or null on failure
 */
export async function extractFieldsWithGemini(apiKey, text, model = 'gemini-2.5-flash', fetcher = fetch) {
  if (!apiKey || !text || text.trim().length < 5) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${SYSTEM_PROMPT}\n\nTin nhắn khách hàng:\n"""\n${text}\n"""` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

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

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[gemini] API responded with HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) return null;

    // Clean JSON markdown fences if any
    const jsonStr = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    return sanitizeAiFields(parsed);
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[gemini] Extraction failed or timed out:', err?.name || 'Error');
    return null;
  }
}
