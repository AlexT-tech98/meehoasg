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
  logAudit,
  linkUnverifiedBillsToD1Order
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
        } catch (e) {
          opsHealth = false;
          opsError = e.message;
        }

        const stale = env.DB ? await findStaleConfirming(env.DB) : [];
        return new Response(JSON.stringify({
          ok: true,
          service: 'meehoa-order-bot-staging',
          environment: 'staging',
          d1Connected: d1Test,
          r2Connected: Boolean(env.MEDIA_R2),
          opsConnected: opsHealth,
          opsError: opsError,
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
export async function handleTelegramWebhook(request, rawEnv) {
  const env = {
    ...rawEnv,
    BOT_TOKEN: rawEnv?.BOT_TOKEN || rawEnv?.TELEGRAM_BOT_TOKEN,
    OPS_TOKEN: rawEnv?.OPS_TOKEN || rawEnv?.OPS_SERVICE_ROLE_TOKEN
  };
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
          list[list.length - 1].uri = r2Key ? `supabase://${r2Key}` : null;
        }
        const activeItem = drafts[drafts.__active];
        if (activeItem) {
          activeItem.lastUpdateId = Math.max(Number(activeItem.lastUpdateId) || 0, updateId || 0);
          activeItem.lastMessageDate = Math.max(Number(activeItem.lastMessageDate) || 0, Number(message.date) || 0);
          activeItem.lastMessageId = Math.max(Number(activeItem.lastMessageId) || 0, Number(message.message_id) || 0);
        }

        let extraReply = '';
        if (caption && caption.trim() && !isBill) {
          const { draft: updatedDraft, changes } = applyFields(drafts[drafts.__active], caption.trim());
          if (changes && changes.length > 0) {
            drafts[drafts.__active] = updatedDraft;
            const changedText = changes.map(c => c.uncertain ? `  ⚠️ ${c.field}: ${c.reason}` : `  ${c.field}: ${c.value}`).join('\n');
            extraReply = `\n\n✏️ Đã nhận thông tin từ chú thích:\n${changedText}`;
          }
        }

        if (env.DB) await saveDrafts(env.DB, userId, drafts);
        await sendTelegramMessage(env.BOT_TOKEN, chatId, `${result.reply}${extraReply}`, 'HTML');
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
      } else if (cmd === '/relink' || cmd === '/retry_bill') {
        await handleRelinkCommand(drafts, arg, env, userId, chatId);
      } else {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, '❓ Lệnh không nhận ra. Các lệnh hỗ trợ:\n/new — Tạo đơn mới\n/list — Danh sách đơn nháp\n/select <id> — Chọn đơn nháp\n/show — Xem chi tiết đơn\n/confirm — Xác nhận tạo đơn OPS\n/relink — Gắn lại bill vào đơn OPS đã tạo\n/cancel — Xóa đơn nháp đang chọn');
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

    const messageId = Number(message.message_id) || 0;
    const messageDate = Number(message.date) || Math.floor(Date.now() / 1000);
    const lastUpdateId = Number(draft.lastUpdateId) || 0;
    const lastMessageDate = Number(draft.lastMessageDate) || 0;
    const lastMessageId = Number(draft.lastMessageId) || 0;
    const isOutOfOrder = (updateId && lastUpdateId && updateId < lastUpdateId) ||
                         (messageDate && lastMessageDate && messageDate < lastMessageDate) ||
                         (messageDate && lastMessageDate && messageDate === lastMessageDate && messageId && lastMessageId && messageId < lastMessageId);

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

    if (isOutOfOrder && changes?.length) {
      // If an older message arrives after a newer message, do NOT overwrite fields that are already set
      changes = changes.filter(c => !draft.fields[c.field] || String(draft.fields[c.field]).trim() === '');
      if (changes.length === 0) {
        await sendTelegramMessage(env.BOT_TOKEN, chatId, 'ℹ️ Đã nhận tin nhắn gửi trước đó nhưng các thông tin này đã được cập nhật bởi tin nhắn mới hơn.');
        return;
      }
      // Re-apply only non-conflicting changes
      const filteredLines = changes.map(c => `${c.field}: ${c.value}`).join('\n');
      const filteredApplied = applyFields(draft, filteredLines);
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
      await sendTelegramMessage(env.BOT_TOKEN, chatId, '⏳ Hệ thống đang xử lý yêu cầu trước của bạn hoặc đang xác nhận đơn. Vui lòng thử lại sau giây lát.');
      return new Response('Busy: Update Queued or System Confirming', {
        status: 503,
        headers: { 'Retry-After': '3' }
      });
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
  const fetcher = env.OPS_SERVICE ? env.OPS_SERVICE.fetch.bind(env.OPS_SERVICE) : fetch;
  const opsRes = await callCreateOrder(
    env.OPS_API_URL || 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    env.OPS_TOKEN || '',
    drafts[draft.id],
    sampleFiles,
    unverifiedBillFiles,
    fetcher
  );

  if (opsRes.ok && opsRes.orderId) {
    const expectedBillCount = draft.draftBillRefs?.length || 0;
    let billLinkSuccess = true;
    let billLinkError = null;
    let linkedResult = null;

    if (env.DB && expectedBillCount > 0) {
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

    // Always transition to submitted because order was officially created in OPS!
    // NEVER transition back to confirmed or pending, which would risk creating a duplicate order!
    drafts = transitionDraftStatus(drafts, draft.id, 'submitted', {
      opsOrderId: opsRes.orderId,
      submittedAt: new Date().toISOString(),
      billsLinked: expectedBillCount > 0 ? billLinkSuccess : true,
      billLinkError: billLinkError,
      verifiedBillCount: linkedResult?.verifiedCount || 0
    });

    if (env.DB) {
      await saveDrafts(env.DB, userId, drafts);
      await logAudit(env.DB, userId, 'createOrder', draft.id, confirmedDraft.requestId, {
        orderId: opsRes.orderId,
        billsLinked: expectedBillCount > 0 ? billLinkSuccess : true
      });
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

    if (expectedBillCount > 0) {
      if (billLinkSuccess) {
        successMsg += `🧾 <b>Bill đính kèm:</b> ${expectedBillCount} bill đã liên kết thành công (chưa xác minh — đối soát tại OPS).\n`;
      } else {
        successMsg += `\n⚠️ <b>CẢNH BÁO LIÊN KẾT BILL:</b>\n` +
          `Đã tạo đơn thành công nhưng chưa gắn được ${expectedBillCount} bill vào đơn (${billLinkError}).\n` +
          `👉 Gõ <code>/relink</code> để thử gắn lại bill vào mã đơn <code>${opsRes.orderId}</code> mà không tạo lại đơn mới.\n`;
      }
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

/**
 * Handle /relink command: Retry linking bill images to an already-created OPS order
 * without calling createOrder again (100% idempotent, zero duplicate orders).
 */
async function handleRelinkCommand(drafts, arg, env, userId, chatId) {
  let targetDraft = null;
  if (arg) {
    const trimmed = arg.trim();
    targetDraft = Object.values(drafts).find(d =>
      d && (
        String(d.id || '').endsWith(trimmed) ||
        String(d.opsOrderId || '').toUpperCase() === trimmed.toUpperCase() ||
        String(d.opsOrderId || '').toUpperCase().endsWith(trimmed.toUpperCase())
      )
    );
  }

  if (!targetDraft) {
    const active = activeDraft(drafts);
    if (active && active.status === 'submitted' && active.opsOrderId) {
      targetDraft = active;
    } else {
      const submitted = Object.values(drafts)
        .filter(d => d && d.status === 'submitted' && d.opsOrderId)
        .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
      targetDraft = submitted[0] || null;
    }
  }

  if (!targetDraft || !targetDraft.opsOrderId) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, '⚠️ Không tìm thấy đơn đã tạo nào để liên kết bill. Dùng /relink <mã_đơn> nếu cần.');
    return;
  }

  const billCount = targetDraft.draftBillRefs?.length || 0;
  if (billCount === 0) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, `ℹ️ Đơn ${targetDraft.opsOrderId} không có ảnh bill nào được lưu trong bản nháp.`);
    return;
  }

  if (!env.DB) {
    await sendTelegramMessage(env.BOT_TOKEN, chatId, '⚠️ D1 Database chưa được cấu hình.');
    return;
  }

  await sendTelegramMessage(env.BOT_TOKEN, chatId, `⏳ Đang kiểm tra và liên kết lại ${billCount} bill vào đơn ${targetDraft.opsOrderId}...`);

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

    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `✅ <b>LIÊN KẾT BILL THÀNH CÔNG!</b>\n\n` +
      `🆔 Đơn: <code>${targetDraft.opsOrderId}</code>\n` +
      `🧾 Đã liên kết: ${billCount} bill vào đơn OPS Staging.\n` +
      `💳 Thanh toán: Chưa thanh toán (công nợ bảo lưu — vui lòng đối soát tại OPS).`,
      'HTML'
    );
  } else {
    targetDraft.billLinkError = linkResult.error;
    await saveDrafts(env.DB, userId, drafts);
    await sendTelegramMessage(
      env.BOT_TOKEN,
      chatId,
      `❌ Liên kết lại bill thất bại:\n${linkResult.error || 'Lỗi không xác định'}\n\nMã đơn ${targetDraft.opsOrderId} vẫn an toàn trên OPS (không bị tạo trùng).`
    );
  }
}
