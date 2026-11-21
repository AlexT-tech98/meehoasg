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
1. customer: Tên khách hàng (chuỗi, bỏ các xưng hô thừa như chị, em, anh).
2. phone: Số điện thoại nhận hoặc đặt hoa (chuỗi).
3. flower: Mô tả hoa hoặc mẫu hoa (chuỗi).
4. date: Ngày nhận hoa định dạng YYYY-MM-DD. Nếu khách nói dạng DD/MM hoặc DD-MM, tự chuyển thành YYYY-MM-DD (năm hiện tại hoặc năm phù hợp). Nếu không rõ ngày cụ thể thì để null.
5. time: Giờ nhận hoa định dạng HH:MM (24h). Ví dụ: 9h -> 09:00, 14h30 -> 14:30. Nếu không rõ giờ thì để null.
6. shipping: Chỉ được chọn 1 trong 3 giá trị chính xác: "Shop book ship", "Khách tự book", "Ghé lấy". Nếu không nói rõ thì để null.
7. address: Địa chỉ giao hàng chi tiết (chuỗi).
8. flowerTotal: Tổng tiền hoa (số nguyên, ví dụ: 850k -> 850000, 1tr5 -> 1500000). Bỏ các phụ kiện.
9. note: Ghi chú lời dặn của khách (chuỗi).
10. cardText: Nội dung viết thiệp chúc mừng (chuỗi).
11. bannerText: Nội dung in banner/dải ruy băng (chuỗi).

TUYỆT ĐỐI KHÔNG tự bịa thông tin. Trường nào không có trong tin nhắn thì để null.
Chỉ trả về duy nhất chuỗi JSON hợp lệ không có markdown backticks.`;

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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
      headers: { 'Content-Type': 'application/json' },
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

    if (typeof parsed !== 'object' || parsed === null) return null;

    // Clean null/empty keys
    const result = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== null && v !== undefined && v !== '') {
        result[k] = v;
      }
    }

    return Object.keys(result).length ? result : null;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[gemini] Extraction failed or timed out:', err.name || err.message);
    return null;
  }
}
