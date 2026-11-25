/**
 * MEEHOA Order Bot V1 — Cloudflare D1 Draft Storage Adapter
 *
 * Implements persistent draft state, update deduplication, and concurrency locking
 * on Cloudflare D1 (SQLite) replacing local JSON filesystem storage.
 */

/**
 * Load drafts for a given Telegram user ID from D1.
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number|string} userId - Telegram user ID
 * @returns {Promise<object>} Draft dictionary (keyed by draftId, with __active property)
 */
export async function loadDrafts(db, userId) {
  const uid = Number(userId);
  try {
    const row = await db.prepare(
      'SELECT active_draft_id, drafts_json FROM bot_drafts WHERE user_id = ?'
    ).bind(uid).first();

    if (!row || !row.drafts_json) {
      return {};
    }

    const drafts = JSON.parse(row.drafts_json);
    if (!drafts || typeof drafts !== 'object') return {};
    
    // Ensure active pointer is set
    if (row.active_draft_id && drafts[row.active_draft_id]) {
      drafts.__active = row.active_draft_id;
    }
    return drafts;
  } catch (err) {
    console.error(`[d1-store] loadDrafts failed for user ${uid}`);
    throw err;
  }
}

/**
 * Persist drafts for a given Telegram user ID to D1.
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number|string} userId - Telegram user ID
 * @param {object} drafts - Draft dictionary
 */
export async function saveDrafts(db, userId, drafts) {
  const uid = Number(userId);
  const activeDraftId = drafts.__active || null;
  const json = JSON.stringify(drafts);

  await db.prepare(`
    INSERT INTO bot_drafts (user_id, active_draft_id, drafts_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      active_draft_id = excluded.active_draft_id,
      drafts_json = excluded.drafts_json,
      updated_at = excluded.updated_at
  `).bind(uid, activeDraftId, json).run();
}

/**
 * Acquire concurrency lock for a user to serialize updates.
 * If another request holds the lock (< 30s old), returns false.
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number|string} userId - Telegram user ID
 * @param {number} timeoutSeconds - Max lock hold duration before automatic expiry
 * @returns {Promise<boolean>} True if lock acquired, false if busy
 */
export async function acquireLock(db, userId, timeoutSeconds = 30) {
  const uid = Number(userId);
  
  // First ensure row exists
  await db.prepare(`
    INSERT INTO bot_drafts (user_id, active_draft_id, drafts_json, updated_at)
    VALUES (?, NULL, '{}', datetime('now'))
    ON CONFLICT(user_id) DO NOTHING
  `).bind(uid).run();

  // Try to acquire lock atomically
  const result = await db.prepare(`
    UPDATE bot_drafts
    SET lock_acquired_at = datetime('now')
    WHERE user_id = ?
      AND (
        lock_acquired_at IS NULL
        OR (strftime('%s', 'now') - strftime('%s', lock_acquired_at)) > ?
      )
  `).bind(uid, timeoutSeconds).run();

  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Release concurrency lock for a user.
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number|string} userId - Telegram user ID
 */
export async function releaseLock(db, userId) {
  const uid = Number(userId);
  try {
    await db.prepare(
      'UPDATE bot_drafts SET lock_acquired_at = NULL WHERE user_id = ?'
    ).bind(uid).run();
  } catch (err) {
    console.warn(`[d1-store] releaseLock failed for user ${uid}:`, err);
  }
}

/**
 * Execute a function within a per-user concurrency lock.
 * Uses a retry backoff loop (up to maxWaitMs) so concurrent webhook messages
 * (e.g. albums, rapid forwarded messages) are queued and executed sequentially
 * instead of being dropped.
 *
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number|string} userId - Telegram user ID
 * @param {Function} fn - Async callback to execute while holding lock
 * @param {number} [maxWaitMs=3500] - Maximum milliseconds to wait for lock
 * @param {number} [pollIntervalMs=150] - Poll interval in milliseconds
 * @returns {Promise<{ok: boolean, result?: any, busy?: boolean}>}
 */
export async function withLock(db, userId, fn, maxWaitMs = 3500, pollIntervalMs = 150) {
  const start = Date.now();
  let locked = false;

  while (!locked && (Date.now() - start < maxWaitMs)) {
    locked = await acquireLock(db, userId, 30);
    if (locked) break;
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  if (!locked) {
    return { ok: false, busy: true };
  }

  try {
    const res = await fn();
    return { ok: true, result: res };
  } finally {
    await releaseLock(db, userId);
  }
}

/**
 * Check if a Telegram update ID was already processed.
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number} updateId - Telegram update ID
 * @returns {Promise<boolean>}
 */
export async function isUpdateProcessed(db, updateId) {
  const row = await db.prepare(
    'SELECT update_id FROM bot_processed_updates WHERE update_id = ?'
  ).bind(updateId).first();
  return !!row;
}

/**
 * Mark a Telegram update ID as processed.
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number} updateId - Telegram update ID
 * @param {number|string} userId - Telegram user ID
 */
export async function markUpdateProcessed(db, updateId, userId) {
  const uid = Number(userId) || null;
  await db.prepare(`
    INSERT INTO bot_processed_updates (update_id, user_id, processed_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(update_id) DO NOTHING
  `).bind(updateId, uid).run();
}

/**
 * Find drafts stuck in 'confirming' status (e.g. if Worker timed out mid-flight).
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number} staleMinutes - Threshold in minutes to consider stale
 * @returns {Promise<Array<{userId: number, draftId: string, draft: object}>>}
 */
export async function findStaleConfirming(db, staleMinutes = 15) {
  const stale = [];
  try {
    const { results } = await db.prepare(
      'SELECT user_id, drafts_json FROM bot_drafts'
    ).all();

    const cutoff = Date.now() - staleMinutes * 60 * 1000;

    for (const row of results || []) {
      if (!row.drafts_json) continue;
      try {
        const drafts = JSON.parse(row.drafts_json);
        for (const [draftId, draft] of Object.entries(drafts)) {
          if (draftId.startsWith('__')) continue;
          if (draft.status === 'confirming') {
            const updatedAtMs = draft.updatedAt ? new Date(draft.updatedAt).getTime() : 0;
            if (updatedAtMs < cutoff) {
              stale.push({ userId: row.user_id, draftId, draft });
            }
          }
        }
      } catch { /* skip corrupt rows */ }
    }
  } catch (err) {
    console.error('[d1-store] findStaleConfirming failed:', err);
  }
  return stale;
}

/**
 * Reset a stale confirming draft back to confirmed state for manual retry.
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number|string} userId - Telegram user ID
 * @param {string} draftId - Draft ID
 * @returns {Promise<boolean>}
 */
export async function resetStaleConfirming(db, userId, draftId) {
  const uid = Number(userId);
  const drafts = await loadDrafts(db, uid);
  const draft = drafts[draftId];
  if (!draft || draft.status !== 'confirming') return false;

  draft.status = 'confirmed';
  draft.updatedAt = new Date().toISOString();
  draft.staleResetAt = new Date().toISOString();
  await saveDrafts(db, uid, drafts);
  return true;
}

/**
 * Record an audit entry in D1.
 * @param {object} db - Cloudflare D1 Database binding
 * @param {number|string} userId - Telegram user ID
 * @param {string} action - Action name (e.g. 'confirm', 'cancel', 'createOrder')
 * @param {string} draftId - Optional draft ID
 * @param {string} requestId - Optional requestId
 * @param {object} payload - Optional payload data
 */
export async function logAudit(db, userId, action, draftId = null, requestId = null, payload = null) {
  try {
    await db.prepare(`
      INSERT INTO bot_audit_logs (user_id, action, draft_id, request_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      Number(userId) || null,
      action,
      draftId,
      requestId,
      payload ? JSON.stringify(payload) : null
    ).run();
  } catch (err) {
    console.warn('[d1-store] logAudit failed:', err);
  }
}

/**
 * Permanently links unverified bill images directly into the official OPS order in D1.
 * Uses Optimistic Concurrency Control (OCC) to prevent race conditions or blind overwrites
 * if the order is modified concurrently by another process.
 * Verifies R2 image existence and validates post-update D1 state.
 *
 * Strictly preserves all financial invariants:
 *   - payment is NEVER modified
 *   - full_paid is NEVER modified
 *   - sale, customer, status, shipping fees are NEVER touched
 *
 * @param {object} db - Cloudflare D1 Database binding
 * @param {string} orderId - OPS Order ID (e.g. MEE-...)
 * @param {Array<object>} billRefs - Array of draft bill references
 * @param {object} [mediaR2=null] - Optional Cloudflare R2 bucket binding for object verification
 * @param {number} [maxRetries=3] - Maximum retry attempts on OCC conflict
 * @returns {Promise<{ok: boolean, linked: number, verifiedCount?: number, uris?: string[], error?: string}>}
 */
export async function linkUnverifiedBillsToD1Order(db, orderId, billRefs = [], mediaR2 = null, maxRetries = 3) {
  if (!db || !orderId || !billRefs.length) {
    return { ok: false, linked: 0, error: 'Thiếu thông tin database, mã đơn hoặc danh sách bill.' };
  }

  // 1. Cross-check against R2 if bucket binding is provided
  if (mediaR2) {
    for (const ref of billRefs) {
      if (ref.r2_key) {
        try {
          const obj = await mediaR2.get(ref.r2_key);
          if (!obj) {
            return {
              ok: false,
              linked: 0,
              error: `Ảnh bill với key "${ref.r2_key}" không tồn tại trong R2 bucket.`
            };
          }
        } catch {
          console.error('[d1-store] R2 get verification failed');
          return {
            ok: false,
            linked: 0,
            error: 'Không thể xác minh ảnh bill trong kho lưu trữ R2.'
          };
        }
      }
    }
  }

  const billUris = billRefs
    .map(b => b.uri || (b.r2_key ? `supabase://${b.r2_key}` : (b.url || null)))
    .filter(Boolean);

  if (!billUris.length) {
    return { ok: false, linked: 0, error: 'Không tìm thấy URI hợp lệ của ảnh bill.' };
  }

  // 2. OCC Retry Loop
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const row = await db.prepare('SELECT data FROM orders WHERE row_key = ?').bind(orderId).first();
      if (!row || !row.data) {
        return { ok: false, linked: 0, error: `Không tìm thấy đơn hàng "${orderId}" trong bảng orders.` };
      }

      const data = JSON.parse(row.data);
      const existing = Array.isArray(data.unverified_bill_urls) ? data.unverified_bill_urls : [];
      const combined = [...new Set([...existing, ...billUris])];
      const currentUpdatedAt = data.updated_at || null;
      const now = new Date().toISOString();

      // Atomic update of unverified_bill_urls using json_set with version guard
      // Only updates $.unverified_bill_urls and $.updated_at, preserving all other fields
      let result;
      if (currentUpdatedAt) {
        result = await db.prepare(`
          UPDATE orders
          SET data = json_set(data, '$.unverified_bill_urls', json(?), '$.updated_at', ?)
          WHERE row_key = ?
            AND json_extract(data, '$.updated_at') = ?
        `).bind(JSON.stringify(combined), now, orderId, currentUpdatedAt).run();
      } else {
        result = await db.prepare(`
          UPDATE orders
          SET data = json_set(data, '$.unverified_bill_urls', json(?), '$.updated_at', ?)
          WHERE row_key = ?
            AND (json_extract(data, '$.updated_at') IS NULL OR json_extract(data, '$.updated_at') = '')
        `).bind(JSON.stringify(combined), now, orderId).run();
      }

      const changes = result?.meta?.changes ?? 0;
      if (changes === 0) {
        // Concurrency conflict: another process updated the order between SELECT and UPDATE.
        if (attempt < maxRetries) {
          console.warn(`[d1-store] OCC conflict updating order ${orderId} (attempt ${attempt}/${maxRetries}), retrying...`);
          await new Promise(r => setTimeout(r, 100 * attempt));
          continue;
        }
        return {
          ok: false,
          linked: 0,
          error: `Xung đột cập nhật đồng thời trên đơn "${orderId}". Đơn vừa được cập nhật bởi tiến trình khác.`
        };
      }

      // 3. Post-update verification: read back from D1 to guarantee integrity
      const verifyRow = await db.prepare('SELECT data FROM orders WHERE row_key = ?').bind(orderId).first();
      if (verifyRow && verifyRow.data) {
        const verifyData = JSON.parse(verifyRow.data);
        const actualBills = Array.isArray(verifyData.unverified_bill_urls) ? verifyData.unverified_bill_urls : [];
        const hasAllUris = billUris.every(u => actualBills.includes(u));

        if (!hasAllUris || actualBills.length < billUris.length) {
          return {
            ok: false,
            linked: actualBills.length,
            verifiedCount: actualBills.length,
            error: `Số bill lưu trong đơn OPS (${actualBills.length}) không khớp với số bill dự kiến (${billUris.length}).`
          };
        }

        return {
          ok: true,
          linked: billUris.length,
          verifiedCount: actualBills.length,
          uris: actualBills
        };
      }

      return { ok: true, linked: billUris.length, verifiedCount: combined.length, uris: combined };
    } catch {
      if (attempt === maxRetries) {
        console.error(`[d1-store] linkUnverifiedBillsToD1Order failed for ${orderId}`);
        return { ok: false, linked: 0, error: 'Lỗi hệ thống khi liên kết bill vào đơn OPS.' };
      }
      await new Promise(r => setTimeout(r, 100 * attempt));
    }
  }

  return { ok: false, linked: 0, error: 'Đã thử lại nhiều lần nhưng không thể cập nhật đơn.' };
}

