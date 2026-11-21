/**
 * MEEHOA Order Bot V1 — Telegram Webhook & Messaging Utilities (Cloudflare Worker)
 */

/**
 * Verify Telegram Webhook Secret Token header.
 * @param {Request} request
 * @param {string} [expectedSecret]
 * @returns {boolean}
 */
export function verifyWebhookSecret(request, expectedSecret) {
  if (!expectedSecret) return true; // If no secret configured, allow (e.g. testing)
  const headerSecret = request.headers.get('x-telegram-bot-api-secret-token');
  return headerSecret === expectedSecret;
}

/**
 * Send a message back to Telegram chat.
 * @param {string} botToken - Telegram Bot Token
 * @param {number|string} chatId - Target chat ID
 * @param {string} text - Message text
 * @param {string} [parseMode] - Optional parse mode ('HTML', 'MarkdownV2')
 * @param {Function} [fetcher=fetch] - Injectable fetch
 * @returns {Promise<boolean>}
 */
export async function sendTelegramMessage(botToken, chatId, text, parseMode = null, fetcher = fetch) {
  if (!botToken || !chatId || !text) return false;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text
  };
  if (parseMode) body.parse_mode = parseMode;

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.ok;
  } catch (err) {
    console.error('[telegram] sendMessage failed:', err);
    return false;
  }
}

/**
 * Download a photo file from Telegram and validate size.
 * @param {string} botToken - Telegram Bot Token
 * @param {string} fileId - Telegram file_id
 * @param {number} [maxBytes=5242880] - Maximum allowed size (default 5MB)
 * @param {Function} [fetcher=fetch] - Injectable fetch
 * @returns {Promise<{ok: boolean, buffer?: ArrayBuffer, base64Url?: string, error?: string}>}
 */
export async function downloadTelegramPhoto(botToken, fileId, maxBytes = 5 * 1024 * 1024, fetcher = fetch) {
  try {
    // 1. Get file path from Telegram getFile API
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const metaRes = await fetcher(getFileUrl);
    if (!metaRes.ok) {
      return { ok: false, error: 'TG getFile request failed' };
    }
    const meta = await metaRes.json();
    if (!meta.ok || !meta.result?.file_path) {
      return { ok: false, error: meta.description || 'File not found on Telegram servers' };
    }

    if (meta.result.file_size && meta.result.file_size > maxBytes) {
      return { ok: false, error: `Ảnh vượt quá dung lượng tối đa cho phép (5MB). Dung lượng: ${(meta.result.file_size / (1024 * 1024)).toFixed(1)}MB.` };
    }

    // 2. Download the binary file
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`;
    const fileRes = await fetcher(downloadUrl);
    if (!fileRes.ok) {
      return { ok: false, error: 'Không thể tải ảnh từ máy chủ Telegram' };
    }

    const buffer = await fileRes.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return { ok: false, error: 'Ảnh vượt quá 5MB' };
    }

    // Convert to base64 Data URL
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    const mime = meta.result.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const base64Url = `data:${mime};base64,${b64}`;

    return {
      ok: true,
      buffer,
      base64Url,
      filePath: meta.result.file_path,
      mimeType: mime,
      byteSize: buffer.byteLength
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Lỗi mạng khi tải ảnh' };
  }
}

/**
 * Save an image directly into Cloudflare R2 bucket.
 * @param {object} r2Bucket - Cloudflare R2 bucket binding (MEDIA_R2)
 * @param {string} key - Destination key in R2
 * @param {ArrayBuffer} buffer - Binary image buffer
 * @param {string} [contentType='image/jpeg'] - MIME type
 * @returns {Promise<boolean>}
 */
export async function savePhotoToR2(r2Bucket, key, buffer, contentType = 'image/jpeg') {
  if (!r2Bucket || typeof r2Bucket.put !== 'function') {
    return false;
  }
  try {
    await r2Bucket.put(key, buffer, {
      httpMetadata: { contentType }
    });
    return true;
  } catch (err) {
    console.error(`[r2] savePhotoToR2 failed for key ${key}:`, err);
    return false;
  }
}
