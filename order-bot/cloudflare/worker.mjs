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
  applyFields,
  draftSummary,
  requiredMissing
} from '../core.mjs';

import {
  loadDrafts,
  saveDrafts,
  withLock,
  isUpdateProcessed,
  markUpdateProcessed,
  findStaleConfirming,
  resetStaleConfirming,
  logAudit
} from './d1-store.mjs';

import {
  verifyWebhookSecret,
  sendTelegramMessage,
  downloadTelegramPhoto,
  savePhotoToR2
} from './telegram.mjs';

import { callCreateOrder } from './ops-client.mjs';
import { extractFieldsWithGemini } from './gemini.mjs';

const DEFAULT_ALLOWED_USER_ID = 5252724920;

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
        const stale = env.DB ? await findStaleConfirming(env.DB) : [];
        return new Response(JSON.stringify({
          ok: true,
          d1Connected: Boolean(env.DB),
          r2Connected: Boolean(env.MEDIA_R2),
          staleConfirmingDrafts: stale.length,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 3. Telegram Webhook endpoint (POST /webhook or POST /)
    if (request.method === 'POST' && (path === '/webhook' || path === '/' || path === '')) {
      return handleTelegramWebhook(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * Handle incoming Telegram Webhook updates
 * @param {Request} request
 * @param {object} env - Cloudflare Worker environment bindings
 * @returns {Promise<Response>}
 */
export async function handleTelegramWebhook(request, env) {
  // A. Security Check 1: Webhook Secret Token
  const expectedSecret = env.TELEGRAM_SECRET_TOKEN;
  if (!verifyWebhookSecret(request, expectedSecret)) {
    return new Response('Forbidden: Invalid Secret Token', { status: 403 });
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
  if (env.DB && await isUpdateProcessed(env.DB, updateId)) {
    return new Response('OK: Already Processed', { status: 200 });
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
      await sendTelegramMessage(
        env.BOT_TOKEN,
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
      const draft = activeDraft(drafts);

      if (!draft) {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, '⚠️ Chưa có đơn nháp nào đang chọn. Gõ /new để tạo đơn mới.');
        return;
      }

      if (draft.status === 'confirming') {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, '⏳ Đơn đang trong tiến trình xác nhận với OPS, không thể bổ sung ảnh.');
        return;
      }
      if (draft.status === 'submitted') {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, '⚠️ Đơn này đã được tạo thành công trên OPS. Gõ /new để tạo đơn mới.');
        return;
      }

      const highestPhoto = message.photo[message.photo.length - 1];
      const caption = message.caption || '';
      const isBill = isBillCaption(caption);

      // Download photo with 5MB validation
      const downloadResult = await downloadTelegramPhoto(env.BOT_TOKEN, highestPhoto.file_id, 5 * 1024 * 1024);
      if (!downloadResult.ok) {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, `⚠️ Không thể tải ảnh: ${downloadResult.error}`);
        return;
      }

      // Save directly to R2 if bound
      let r2Key = null;
      if (env.MEDIA_R2) {
        const ext = downloadResult.mimeType === 'image/png' ? 'png' : 'jpg';
        const fileHash = (highestPhoto.file_unique_id || String(Date.now())).slice(0, 12);
        r2Key = isBill
          ? `settlement-bills/unverified-${draft.id}-${fileHash}.${ext}`
          : `order-images/sample-${draft.id}-${fileHash}.${ext}`;
        await savePhotoToR2(env.MEDIA_R2, r2Key, downloadResult.buffer, downloadResult.mimeType);
      }

      const result = isBill
        ? addBillRef(drafts, highestPhoto.file_id, caption)
        : addSampleRef(drafts, highestPhoto.file_id, caption);

      if (result.ok) {
        drafts = result.drafts;
        // attach data url for preview/OPS createOrder payload
        const list = isBill ? drafts[drafts.__active].draftBillRefs : drafts[drafts.__active].sampleRefs;
        if (list && list.length > 0) {
          list[list.length - 1].data_url = downloadResult.base64Url;
          list[list.length - 1].r2_key = r2Key;
        }
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, result.reply, 'HTML');
      } else {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, `⚠️ ${result.reply}`);
      }
      return;
    }

    // 2. Text message handler
    const rawText = (message.text || '').trim();
    if (!rawText) return;

    // Check Prompt Injection
    const injectionType = detectPromptInjection(rawText);
    if (injectionType) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '🛡️ Tin nhắn bị từ chối do chứa nội dung can thiệp hệ thống hoặc quyền hạn.');
      return;
    }

    // A. Commands: /new, /list, /select, /show, /cancel, /confirm
    if (rawText.startsWith('/')) {
      const parts = rawText.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();

      if (cmd === '/new') {
        const res = cmdNew(drafts, arg);
        drafts = res.drafts;
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, res.reply);
      } else if (cmd === '/list') {
        const res = cmdList(drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, res.reply);
      } else if (cmd === '/select') {
        const res = cmdSelect(drafts, arg);
        if (res.drafts) drafts = res.drafts;
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, res.reply);
      } else if (cmd === '/show') {
        const res = cmdShow(drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, res.reply);
      } else if (cmd === '/cancel') {
        const res = cmdCancel(drafts, arg);
        if (res.drafts) drafts = res.drafts;
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, res.reply);
      } else if (cmd === '/confirm') {
        await handleConfirmCommand(drafts, env, userId, chatId);
      } else {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, '❓ Lệnh không nhận ra. Các lệnh hỗ trợ:\n/new — Tạo đơn mới\n/list — Danh sách đơn nháp\n/select <id> — Chọn đơn nháp\n/show — Xem chi tiết đơn\n/confirm — Xác nhận tạo đơn OPS\n/cancel — Xóa đơn nháp đang chọn');
      }
      return;
    }

    // B. Field updates
    const draft = activeDraft(drafts);
    if (!draft) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '⚠️ Dùng /new để tạo đơn nháp trước khi nhập thông tin.');
      return;
    }

    if (draft.status === 'confirming') {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '⏳ Đơn đang trong tiến trình xác nhận với OPS, không thể chỉnh sửa.');
      return;
    }
    if (draft.status === 'submitted') {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '⚠️ Đơn này đã được tạo thành công trên OPS. Gõ /new để tạo đơn mới.');
      return;
    }

    // Apply structured fields via core applyFields
    let { draft: updated, changes, warnings } = applyFields(draft, rawText);

    // AI Fallback if structured parsing yields nothing and Gemini Key is available
    if ((!changes || changes.length === 0) && env.GEMINI_API_KEY) {
      const aiExtracted = await extractFieldsWithGemini(env.GEMINI_API_KEY, rawText, env.GEMINI_MODEL);
      if (aiExtracted && Object.keys(aiExtracted).length > 0) {
        // Convert extracted JSON to lines and apply
        const lines = Object.entries(aiExtracted).map(([k, v]) => `${k}: ${v}`).join('\n');
        const aiApplied = applyFields(draft, lines);
        if (aiApplied.changes?.length) {
          updated = aiApplied.draft;
          changes = aiApplied.changes;
          warnings = aiApplied.warnings;
        }
      }
    }

    if (changes && (changes.length > 0 || warnings?.length > 0)) {
      drafts = { ...drafts, [draft.id]: updated };
      if (env.DB) await saveDrafts(env.DB, userId, drafts);

      const changedText = changes.map(c => c.uncertain ? `  ⚠️ ${c.field}: ${c.reason}` : `  ${c.field}: ${c.value}`).join('\n');
      const missing = requiredMissing(updated);
      const uncertainCount = Object.keys(updated.uncertainFields || {}).length;

      let extra = '';
      if (missing.length) extra += `\n⚠️ Còn thiếu: ${missing.join(', ')}`;
      if (uncertainCount) extra += `\n❓ Có ${uncertainCount} trường cần làm rõ trước khi xác nhận.`;
      if (!missing.length && !uncertainCount) extra += '\n✅ Đã đủ dữ liệu — dùng /confirm để tạo đơn.';
      const warnMsg = warnings?.length ? `\n${warnings.join('\n')}` : '';

      const prefix = changedText ? `✏️ Đã cập nhật:\n${changedText}` : '';
      await sendTelegramMessage(env.BOT_TOKEN, chatId, `${prefix}${extra}${warnMsg}`.trim());
    } else {
      await sendTelegramMessage(
        env.BOT_TOKEN,
        chatId,
        '⚠️ Không nhận ra trường nào. Dùng dạng:\n  tên khách: Nguyễn A\n  hoa: Bó hồng đỏ\n  ngày: 2026-12-01\nhoặc gõ /show để xem đơn.'
      );
    }
  };

  // Run inside per-user lock if D1 is configured
  if (env.DB) {
    const lockResult = await withLock(env.DB, userId, executeProcess);
    if (lockResult.busy) {
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '⏳ Yêu cầu trước của bạn đang được xử lý, vui lòng chờ trong giây lát...');
      return new Response('OK: Concurrency Guarded', { status: 200 });
    }
    await markUpdateProcessed(env.DB, updateId, userId);
  } else {
    await executeProcess();
  }

  return new Response('OK', { status: 200 });
}

/**
 * Handle /confirm command execution
 */
async function handleConfirmCommand(drafts, env, userId, chatId) {
  const draft = activeDraft(drafts);
  if (!draft) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, '⚠️ Chưa có đơn nháp nào để xác nhận. Gõ /new để tạo đơn mới.');
    return;
  }

  // 1. Pre-validation via cmdConfirm
  const confirmResult = cmdConfirm(drafts);
  if (confirmResult.reply !== '__CONFIRM__') {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, confirmResult.reply);
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

  await sendTelegramMessage(env.BOT_TOKEN, chatId, '⏳ Đang kiểm tra ảnh và gửi yêu cầu tạo đơn sang MEEHOA OPS Staging...');

  // 3. Prepare images: download and encode
  const sampleFiles = [];
  for (const ref of draft.sampleRefs || []) {
    let dataUrl = ref.data_url;
    if (!dataUrl && (ref.fileId || ref.file_id)) {
      const fileId = ref.fileId || ref.file_id;
      const dl = await downloadTelegramPhoto(env.BOT_TOKEN, fileId);
      if (!dl.ok) {
        drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, `❌ Xác nhận bị hủy: Không thể tải ảnh mẫu từ Telegram (${dl.error}). Vui lòng gửi lại ảnh.`);
        return;
      }
      dataUrl = dl.base64Url;
    }
    if (dataUrl) sampleFiles.push({ data: dataUrl });
  }

  const unverifiedBillFiles = [];
  for (const ref of draft.draftBillRefs || []) {
    let dataUrl = ref.data_url;
    if (!dataUrl && (ref.fileId || ref.file_id)) {
      const fileId = ref.fileId || ref.file_id;
      const dl = await downloadTelegramPhoto(env.BOT_TOKEN, fileId);
      if (!dl.ok) {
        drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, `❌ Xác nhận bị hủy: Không thể tải ảnh bill từ Telegram (${dl.error}). Vui lòng gửi lại ảnh.`);
        return;
      }
      dataUrl = dl.base64Url;
    }
    if (dataUrl) unverifiedBillFiles.push({ data: dataUrl });
  }

  // 4. Call OPS Staging API
  const opsRes = await callCreateOrder(
    env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    env.OPS_TOKEN || '',
    drafts[draft.id],
    sampleFiles,
    unverifiedBillFiles
  );

  if (opsRes.ok && opsRes.orderId) {
    drafts = transitionDraftStatus(drafts, draft.id, 'submitted', {
      opsOrderId: opsRes.orderId,
      submittedAt: new Date().toISOString()
    });
    if (env.DB) {
      await saveDrafts(env.DB, userId, drafts);
      await logAudit(env.DB, userId, 'createOrder', draft.id, confirmedDraft.requestId, { orderId: opsRes.orderId });
    }

    const customer = draft.fields.customer || '';
    const flower = draft.fields.flower || '';
    const date = draft.fields.date || '';
    const time = draft.fields.time || '';
    const shipping = draft.fields.shipping || '';
    const flowerTotal = Number(draft.fields.flowerTotal) || 0;

    let successMsg = `✅ <b>TẠO ĐƠN THÀNH CÔNG TRÊN MEEHOA OPS STAGING!</b>\n\n` +
      `🆔 <b>Mã đơn:</b> <code>${opsRes.orderId}</code>\n` +
      `👤 Khách: ${customer}\n` +
      `🌸 Mẫu hoa: ${flower}\n` +
      `📅 Ngày nhận: ${date} lúc ${time}\n` +
      `🚚 Giao nhận: ${shipping}\n` +
      `💰 Tiền hoa: ${flowerTotal.toLocaleString('vi-VN')} đ\n` +
      `💳 Thanh toán: Chưa thanh toán (công nợ bảo lưu)\n` +
      `🖼️ Ảnh mẫu: ${sampleFiles.length} ảnh\n`;

    if (unverifiedBillFiles.length > 0) {
      successMsg += `🧾 <b>Bill đính kèm:</b> ${unverifiedBillFiles.length} bill (chưa xác minh — vui lòng đối soát tại OPS).\n`;
    }
    successMsg += `\nGõ /new để bắt đầu đơn hàng mới.`;

    await sendTelegramMessage(env.BOT_TOKEN, chatId, successMsg, 'HTML');
  } else {
    // Failure or network issue: rollback confirming -> confirmed so user can retry safely
    drafts = transitionDraftStatus(drafts, draft.id, 'confirmed', { failedAt: new Date().toISOString() });
    if (env.DB) await saveDrafts(env.DB, userId, drafts);

    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `❌ Không thể tạo đơn trên OPS Staging:\n${opsRes.message}\n\nĐơn nháp vẫn được giữ nguyên. Bạn có thể kiểm tra lại và gõ /confirm để thử lại.`
    );
  }
}
