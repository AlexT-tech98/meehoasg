/**
 * MEEHOA Order Bot V1 — Telegram Webhook & Messaging Utilities (Cloudflare Worker)
 */

/**
 * Constant-time string comparison to avoid leaking secret length/bytes via timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Encode binary bytes to base64 efficiently (avoids O(n^2) char concat on 5MB images).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  const chunkSize = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

/**
 * Verify an authentication secret header using constant-time comparison (fail-closed).
 * @param {Request} request
 * @param {string} headerName
 * @param {string} [expectedSecret]
 * @returns {boolean}
 */
export function verifySecretHeader(request, headerName, expectedSecret) {
  if (!expectedSecret || typeof expectedSecret !== 'string' || !headerName) return false;
  const headerSecret = request.headers.get(headerName);
  if (!headerSecret) return false;
  return timingSafeEqual(headerSecret, expectedSecret);
}

/**
 * Verify Telegram Webhook Secret Token header (fail-closed).
 * @param {Request} request
 * @param {string} [expectedSecret]
 * @returns {boolean}
 */
export function verifyWebhookSecret(request, expectedSecret) {
  return verifySecretHeader(request, 'x-telegram-bot-api-secret-token', expectedSecret);
}

/**
 * Send a message back to Telegram chat.
 * @param {string} botToken - Telegram Bot Token
 * @param {number|string} chatId - Target chat ID
 * @param {string} text - Message text
 * @param {string} [parseMode] - Optional parse mode ('HTML', 'MarkdownV2')
 * @param {Function} [fetcher=fetch] - Injectable fetch
 * @param {object} [options] - Optional Telegram parameters (e.g. { replyMarkup })
 * @returns {Promise<boolean>}
 */
export async function sendTelegramMessage(botToken, chatId, text, parseMode = null, fetcher = fetch, options = {}) {
  if (!botToken || !chatId || !text) return false;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text
  };
  if (parseMode) body.parse_mode = parseMode;
  const replyMarkup = options?.replyMarkup || options?.reply_markup || null;
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.ok;
  } catch {
    console.error('[telegram] sendMessage failed');
    return false;
  }
}

/**
 * Acknowledge a Telegram callback_query so the client stops showing a loading indicator.
 * @param {string} botToken
 * @param {string} callbackQueryId
 * @param {string} [text='']
 * @param {boolean} [showAlert=false]
 * @param {Function} [fetcher=fetch]
 * @returns {Promise<boolean>}
 */
export async function answerTelegramCallbackQuery(botToken, callbackQueryId, text = '', showAlert = false, fetcher = fetch) {
  if (!botToken || !callbackQueryId) return false;

  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const body = {
    callback_query_id: String(callbackQueryId),
    show_alert: Boolean(showAlert)
  };
  const trimmed = String(text || '').trim();
  if (trimmed) body.text = trimmed.slice(0, 190);

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.ok;
  } catch {
    console.error('[telegram] answerCallbackQuery failed');
    return false;
  }
}

/**
 * Best-effort update or removal of an inline keyboard on a previously sent Telegram message.
 * @param {string} botToken
 * @param {number|string} chatId
 * @param {number|string} messageId
 * @param {object} [replyMarkup={ inline_keyboard: [] }]
 * @param {Function} [fetcher=fetch]
 * @returns {Promise<boolean>}
 */
export async function editTelegramMessageReplyMarkup(botToken, chatId, messageId, replyMarkup = { inline_keyboard: [] }, fetcher = fetch) {
  if (!botToken || !chatId || !messageId) return false;

  const url = `https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`;
  const body = {
    chat_id: chatId,
    message_id: Number(messageId),
    reply_markup: replyMarkup || { inline_keyboard: [] }
  };

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Download a photo file from Telegram and validate size.
 * @param {string} botToken - Telegram Bot Token
 * @param {string} fileId - Telegram file_id
 * @param {number} [maxBytes=5242880] - Maximum allowed size (default 5MB)
 * @param {Function} [fetcher=fetch] - Injectable fetch
 * @returns {Promise<{ok: boolean, buffer?: ArrayBuffer, base64Url?: string, filePath?: string, mimeType?: string, byteSize?: number, error?: string}>}
 */
export async function downloadTelegramPhoto(botToken, fileId, maxBytes = 5 * 1024 * 1024, fetcher = fetch) {
  if (!botToken || !fileId) {
    return { ok: false, error: 'Thiếu thông tin tệp ảnh' };
  }
  try {
    // 1. Get file path from Telegram getFile API
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const metaRes = await fetcher(getFileUrl);
    if (!metaRes.ok) {
      return { ok: false, error: 'Không thể lấy thông tin ảnh từ Telegram' };
    }
    const meta = await metaRes.json();
    if (!meta.ok || !meta.result?.file_path) {
      return { ok: false, error: 'Ảnh không tồn tại hoặc đã hết hạn trên máy chủ Telegram' };
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
    if (!buffer.byteLength) {
      return { ok: false, error: 'File ảnh rỗng hoặc bị lỗi' };
    }
    if (buffer.byteLength > maxBytes) {
      return { ok: false, error: 'Ảnh vượt quá 5MB' };
    }

    const lowerPath = String(meta.result.file_path).toLowerCase();
    const mime = lowerPath.endsWith('.png')
      ? 'image/png'
      : lowerPath.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg';

    const bytes = new Uint8Array(buffer);
    const b64 = bytesToBase64(bytes);
    const base64Url = `data:${mime};base64,${b64}`;

    return {
      ok: true,
      buffer,
      base64Url,
      filePath: meta.result.file_path,
      mimeType: mime,
      byteSize: buffer.byteLength
    };
  } catch {
    return { ok: false, error: 'Lỗi mạng khi tải ảnh' };
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
  } catch {
    console.error('[r2] savePhotoToR2 failed');
    return false;
  }
}

/**
 * Delete an image from Cloudflare R2 bucket (best-effort cleanup).
 * @param {object} r2Bucket
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function deletePhotoFromR2(r2Bucket, key) {
  if (!r2Bucket || typeof r2Bucket.delete !== 'function' || !key) {
    return false;
  }
  try {
    await r2Bucket.delete(key);
    return true;
  } catch {
    console.error('[r2] deletePhotoFromR2 failed');
    return false;
  }
}
