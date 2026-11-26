#!/usr/bin/env node
'use strict';

/**
 * MEEHOA OPS V3.1 — Strict Allow-List Cleanup for Verified Go-Live R2 Test Objects
 *
 * SAFETY GUARANTEES:
 * 1. ONLY operates on the 6 hardcoded JPEG keys traced via `operation_receipts` to the two
 *    purged Go-Live `[QA TEST R2]` orders (`MEE-4C8D65C26A8B4BA1`, `MEE-3ECAF7FA21984333`).
 * 2. Explicitly EXCLUDES `MEE-4CEA187B770C469B` (`TEST R2 20261121`, `efe981ed-...jpg`) which
 *    is still referenced in Trash `public.orders`, `order_deletion_history`, and `activity_log`.
 * 3. NEVER scans buckets or infers "unreferenced = deletable"; NEVER touches real customer
 *    images, website assets, or Order Bot media.
 * 4. Default mode is `--dry-run` (strictly read-only). Both `--dry-run` and `--execute` verify:
 *      - `public.orders` (`image_urls`, `full_paid_bill_urls`)
 *      - `public.settlement_requests` (`bill_urls`)
 *      - `public.order_deletion_history` (`order_snapshot`)
 *      - `public.activity_log` (`before_data`, `after_data`)
 *      - `public.operation_receipts` (`result`) — distinguishing historical receipts of the two
 *        already-purged Go-Live QA test orders (verified absent in `public.orders`) from active
 *        or unknown order references.
 *    For `.preview.jpg` keys, both the `.preview.jpg` key and its parent original `.jpg` key are checked.
 */

const ALLOWED_GOLIVE_TEST_OBJECTS = Object.freeze([
  // Purged Go-Live QA order MEE-4C8D65C26A8B4BA1 (2026-11-26T07:50:20Z)
  'order-images/c0dbba8c-8556-4c8e-a876-1a8d2d0123b5.jpg',
  'order-images/c0dbba8c-8556-4c8e-a876-1a8d2d0123b5.preview.jpg',
  'settlement-bills/ebb0c8f9-6cb0-4a91-b451-857338a12a82.jpg',
  // Purged Go-Live QA order MEE-3ECAF7FA21984333 (2026-11-26T07:51:05Z)
  'order-images/81f792e0-274c-44d9-b2b8-638dcb637f58.jpg',
  'order-images/81f792e0-274c-44d9-b2b8-638dcb637f58.preview.jpg',
  'settlement-bills/0f56829a-cfb8-4351-96b3-a9c59ea24d8c.jpg',
]);

const VERIFIED_PURGED_TEST_ORDER_IDS = Object.freeze([
  'MEE-4C8D65C26A8B4BA1',
  'MEE-3ECAF7FA21984333',
]);

function candidateRefsForKey(objectKey, r2Bucket) {
  const baseKey = String(objectKey || '').replace(/\.preview\.(jpg|png|webp)$/i, '.$1');
  const keys = [...new Set([String(objectKey || ''), baseKey].filter(Boolean))];
  const refs = [];
  for (const k of keys) {
    refs.push(`r2://${r2Bucket}/${k}`);
    refs.push(`supabase://${k}`);
  }
  return refs;
}

function encJson(val) {
  return encodeURIComponent(JSON.stringify(val));
}

function restBaseUrl(supabaseUrl) {
  const trimmed = String(supabaseUrl || '').replace(/\/+$/, '');
  return trimmed.endsWith('/rest/v1') ? trimmed : `${trimmed}/rest/v1`;
}

async function queryPostgrest(base, pathAndQuery, serviceKey, fetcher) {
  const res = await fetcher(`${base}/${pathAndQuery}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) {
    const errBody = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    throw new Error(`DB_REF_CHECK_FAILED:${pathAndQuery.split('?')[0]}:${res.status}:${errBody.slice(0, 160)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function countReferencesInDb({
  supabaseUrl,
  serviceKey,
  objectKey,
  r2Bucket = 'meehoasg-website-media',
  fetcher = fetch,
}) {
  const base = restBaseUrl(supabaseUrl);
  const refs = candidateRefsForKey(objectKey, r2Bucket);

  const ordersOr = refs.flatMap((u) => [
    `image_urls.cs.${encJson([u])}`,
    `full_paid_bill_urls.cs.${encJson([u])}`,
  ]).join(',');

  const srOr = refs.map((u) => `bill_urls.cs.${encJson([u])}`).join(',');

  const delHistOr = refs.flatMap((u) => [
    `order_snapshot.cs.${encJson({ image_urls: [u] })}`,
    `order_snapshot.cs.${encJson({ full_paid_bill_urls: [u] })}`,
  ]).join(',');

  const actLogOr = refs.flatMap((u) => [
    `before_data.cs.${encJson({ image_urls: [u] })}`,
    `after_data.cs.${encJson({ image_urls: [u] })}`,
    `before_data.cs.${encJson({ full_paid_bill_urls: [u] })}`,
    `after_data.cs.${encJson({ full_paid_bill_urls: [u] })}`,
    `before_data.cs.${encJson({ bill_urls: [u] })}`,
    `after_data.cs.${encJson({ bill_urls: [u] })}`,
  ]).join(',');

  const receiptsOr = refs.flatMap((u) => [
    `result.cs.${encJson({ row: { image_urls: [u] } })}`,
    `result.cs.${encJson({ row: { full_paid_bill_urls: [u] } })}`,
    `result.cs.${encJson({ row: { bill_urls: [u] } })}`,
    `result.cs.${encJson({ billUrls: [u] })}`,
  ]).join(',');

  const directChecks = [
    { table: 'orders', query: `orders?select=id&limit=1&or=(${ordersOr})` },
    { table: 'settlement_requests', query: `settlement_requests?select=id&limit=1&or=(${srOr})` },
    { table: 'order_deletion_history', query: `order_deletion_history?select=id,order_id&limit=1&or=(${delHistOr})` },
    { table: 'activity_log', query: `activity_log?select=id,order_id&limit=1&or=(${actLogOr})` },
  ];

  const matchedTables = [];
  for (const c of directChecks) {
    const rows = await queryPostgrest(base, c.query, serviceKey, fetcher);
    if (rows.length > 0) matchedTables.push(c.table);
  }

  // Distinguish historical receipts of verified purged Go-Live QA test orders from active/unknown order references
  const purgedSet = new Set(VERIFIED_PURGED_TEST_ORDER_IDS);
  const receiptRows = await queryPostgrest(base, `operation_receipts?select=actor,request_id,action,result&limit=20&or=(${receiptsOr})`, serviceKey, fetcher);
  const historicalTestReceiptOrderIds = [];
  const activeReceiptOrderIds = [];

  for (const r of receiptRows) {
    const orderId = String(r?.result?.orderId || r?.result?.row?.id || '').trim();
    if (!orderId || !purgedSet.has(orderId)) {
      activeReceiptOrderIds.push(orderId || 'UNKNOWN_ORDER_ID');
      continue;
    }
    const existingOrders = await queryPostgrest(base, `orders?select=id,is_deleted&limit=1&id=eq.${encodeURIComponent(orderId)}`, serviceKey, fetcher);
    if (existingOrders.length > 0) {
      activeReceiptOrderIds.push(orderId);
    } else if (!historicalTestReceiptOrderIds.includes(orderId)) {
      historicalTestReceiptOrderIds.push(orderId);
    }
  }

  if (activeReceiptOrderIds.length > 0) {
    matchedTables.push('operation_receipts');
  }

  return {
    referenced: matchedTables.length > 0,
    matchedTables,
    historicalTestReceipts: receiptRows.length - activeReceiptOrderIds.length,
    historicalTestReceiptOrderIds,
    activeReceiptOrderIds,
  };
}

async function runCleanup({
  keys = ALLOWED_GOLIVE_TEST_OBJECTS,
  execute = false,
  supabaseUrl,
  serviceKey,
  r2Bucket = process.env.R2_MEDIA_BUCKET || 'meehoasg-website-media',
  r2Media,
  fetcher = fetch,
}) {
  const allowSet = new Set(ALLOWED_GOLIVE_TEST_OBJECTS);
  const report = {
    mode: execute ? 'execute' : 'dry-run',
    r2Bucket,
    allowListCount: ALLOWED_GOLIVE_TEST_OBJECTS.length,
    items: [],
    deletedCount: 0,
    blockedCount: 0,
  };

  for (const key of keys) {
    if (!allowSet.has(key)) {
      report.blockedCount += 1;
      report.items.push({ key, status: 'BLOCKED_NOT_IN_ALLOWLIST' });
      continue;
    }
    const refCheck = await countReferencesInDb({ supabaseUrl, serviceKey, objectKey: key, r2Bucket, fetcher });
    if (refCheck.referenced) {
      report.blockedCount += 1;
      report.items.push({
        key,
        status: 'BLOCKED_REFERENCED_IN_DB',
        matchedTables: refCheck.matchedTables,
        activeReceiptOrderIds: refCheck.activeReceiptOrderIds,
      });
      continue;
    }
    const existsInR2 = r2Media ? await r2Media.exists(key) : null;
    if (!execute) {
      report.items.push({
        key,
        status: existsInR2 === false ? 'ALREADY_ABSENT_IN_R2' : 'DRY_RUN_ELIGIBLE',
        existsInR2,
        dbReferenced: false,
        historicalTestReceipts: refCheck.historicalTestReceipts,
        historicalTestReceiptOrderIds: refCheck.historicalTestReceiptOrderIds,
      });
      continue;
    }
    if (!r2Media) throw new Error('R2_MEDIA_REQUIRED_FOR_EXECUTE');
    if (!existsInR2) {
      report.items.push({
        key,
        status: 'ALREADY_ABSENT_IN_R2',
        existsInR2: false,
        dbReferenced: false,
        historicalTestReceipts: refCheck.historicalTestReceipts,
        historicalTestReceiptOrderIds: refCheck.historicalTestReceiptOrderIds,
      });
      continue;
    }
    await r2Media.discard(r2Media.reference(key));
    const stillExists = await r2Media.exists(key);
    if (stillExists) throw new Error(`R2_DELETE_VERIFY_FAILED:${key}`);
    report.deletedCount += 1;
    report.items.push({
      key,
      status: 'DELETED_AND_VERIFIED',
      dbReferenced: false,
      historicalTestReceipts: refCheck.historicalTestReceipts,
      historicalTestReceiptOrderIds: refCheck.historicalTestReceiptOrderIds,
    });
  }
  report.ok = report.blockedCount === 0;
  return report;
}

if (require.main === module) {
  (async () => {
    const execute = process.argv.includes('--execute');
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      process.exit(1);
    }
    let r2Media = null;
    if (process.env.R2_ACCESS_KEY_ID) {
      const { createR2Media } = await import('../supabase/functions/_shared/r2-media.js');
      r2Media = createR2Media({
        accountId: process.env.R2_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        bucket: process.env.R2_MEDIA_BUCKET || 'meehoasg-website-media',
        endpointUrl: process.env.R2_ENDPOINT_URL || '',
      });
    }
    const result = await runCleanup({ execute, supabaseUrl, serviceKey, r2Media });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(2);
  })().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  ALLOWED_GOLIVE_TEST_OBJECTS,
  VERIFIED_PURGED_TEST_ORDER_IDS,
  candidateRefsForKey,
  countReferencesInDb,
  runCleanup,
};
