/**
 * MEEHOA Order Bot V1 — OPS Staging API Client (Cloudflare Worker)
 *
 * Communicates with MEEHOA OPS Staging backend (meehoasg-ops-staging).
 * Enforces strict financial and payment invariants:
 *   - payment is always "Chưa thanh toán"
 *   - fullPaidRequested is always false
 *   - requestId is fixed for idempotent retries
 *   - All secrets and technical error messages are sanitized
 */

/**
 * Call OPS createOrder endpoint.
 * @param {string} opsUrl - Base URL of OPS Staging (e.g. https://meehoasg-ops-staging.meehoasg.workers.dev/api-core)
 * @param {string} opsToken - Authentication token for OPS
 * @param {object} draft - Draft order object
 * @param {Array<{data: string}>} sampleFiles - Sample flower image files (base64 Data URLs)
 * @param {Array<{data: string}>} unverifiedBillFiles - Bill image files (base64 Data URLs)
 * @param {Function} [fetcher=fetch] - Fetch implementation (injectable for testing)
 * @returns {Promise<{ok: boolean, orderId?: string, message?: string, code?: string, unverifiedBillCount?: number}>}
 */
export async function callCreateOrder(opsUrl, opsToken, draft, sampleFiles = [], unverifiedBillFiles = [], fetcher = fetch) {
  const f = draft.fields || {};
  let note = String(f.note || '').trim();
  if (unverifiedBillFiles.length > 0 && !note.includes('Bill đính kèm')) {
    const billTag = `[🧾 Đính kèm ${unverifiedBillFiles.length} bill chưa xác minh]`;
    note = note ? `${note} ${billTag}` : billTag;
  }

  // Construct payload adhering strictly to OPS createOrder schema
  const payload = {
    name: 'createOrder',
    payload: {
      token: opsToken,
      requestId: draft.requestId,
      order: {
        customer: String(f.customer || '').trim(),
        phone: String(f.phone || '').trim(),
        order_date: String(f.date || '').trim(),
        order_time: String(f.time || '').trim(),
        flower: String(f.flower || '').trim(),
        note: note,
        shipping: String(f.shipping || '').trim(),
        address: String(f.address || '').trim(),
        flower_total: Number(f.flowerTotal) || 0,
        // STRICT INVARIANT: Always unpaid on creation
        payment: 'Chưa thanh toán',
        sale: String(f.sale || '').trim(),
        card: Boolean(f.card),
        card_qty: f.card ? Math.max(1, Number(f.cardQty) || 1) : 0,
        card_text: String(f.cardText || '').trim(),
        banner: Boolean(f.banner),
        banner_qty: f.banner ? Math.max(1, Number(f.bannerQty) || 1) : 0,
        banner_text: String(f.bannerText || '').trim(),
        charm_fee: Number(f.charmFee) || 0,
        charm_text: String(f.charmText || '').trim(),
        paper_fee: Number(f.paperFee) || 0,
        paper_text: String(f.paperText || '').trim(),
        vat: Number(f.vat) || 0,
        ship_fee: Number(f.shipFee) || 0,
        ship_confirmed: false,
        // STRICT INVARIANT: No auto-full-paid
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opsToken}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        ok: false,
        code: `HTTP_${res.status}`,
        message: `Hệ thống OPS Staging phản hồi mã lỗi HTTP ${res.status}.`
      };
    }

    const json = await res.json();
    return {
      ok: Boolean(json.ok),
      orderId: json.orderId || json.row?.id || null,
      code: json.code || null,
      message: json.message || (json.ok ? 'Đã tạo đơn thành công.' : 'Tạo đơn thất bại.'),
      unverifiedBillCount: unverifiedBillFiles.length,
      sampleCount: sampleFiles.length
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === 'AbortError';
    return {
      ok: false,
      code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: isTimeout
        ? 'Kết nối tới OPS Staging bị quá thời gian (timeout). Vui lòng kiểm tra lại trạng thái đơn trước khi thử lại.'
        : 'Không thể kết nối đến OPS Staging do lỗi mạng.'
    };
  }
}
