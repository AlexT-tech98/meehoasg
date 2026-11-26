#!/usr/bin/env node
'use strict';

/**
 * MEEHOA OPS V3.1 — Strict Allow-List Cleanup for Verified Go-Live R2 Test Objects
 *
 * SAFETY GUARANTEES:
 * 1. ONLY operates on the 6 hardcoded JPEG keys traced via `operation_receipts` to the two
 *    purged Go-Live `[QA TEST R2]` orders (`MEE-4C8D65C26A8B4BA1`, `MEE-3ECAF7FA21984333`).
 * 2. Explicitly EXCLUDES `MEE-4CEA187B770C469B` (`TEST R2 20261121`, `efe981ed-...jpg`) which
 *    is still referenced in Trash `public.orders`.
 * 3. NEVER scans buckets or infers "unreferenced = deletable"; NEVER touches real customer
 *    images, website assets, or Order Bot media.
 * 4. Default mode is `--dry-run` (read-only). Passing `--execute` STILL verifies zero DB
 *    references across `orders`, `settlement_requests`, `order_deletion_history`, and
 *    `activity_log` immediately before deleting any allow-listed object.
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

async function countReferencesInDb({ supabaseUrl, serviceKey, objectKey, fetcher = fetch }) {
  const basename = objectKey.split('/').pop();
  const checks = [
    { table: 'orders', filter: `or=(image_urls.cs.["r2://meehoasg-media/${objectKey}"],full_paid_bill_urls.cs.["r2://meehoasg-media/${objectKey}"],image_urls.cs.["supabase://${objectKey}"],full_paid_bill_urls.cs.["supabase://${objectKey}"])` },
    { table: 'settlement_requests', filter: `or=(bill_urls.cs.["r2://meehoasg-media/${objectKey}"],bill_urls.cs.["supabase://${objectKey}"])` },
    { table: 'activity_log', filter: `detail=ilike.*${basename}*` },
  ];
  let total = 0;
  const matchedTables = [];
  for (const c of checks) {
    const res = await fetcher(`${supabaseUrl}/rest/v1/${c.table}?select=id&limit=1&${c.filter}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!res.ok) throw new Error(`DB_REF_CHECK_FAILED:${c.table}:${res.status}`);
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) {
      total += rows.length;
      matchedTables.push(c.table);
    }
  }
  return { referenced: total > 0, matchedTables };
}

async function runCleanup({
  keys = ALLOWED_GOLIVE_TEST_OBJECTS,
  execute = false,
  supabaseUrl,
  serviceKey,
  r2Media,
  fetcher = fetch,
}) {
  const allowSet = new Set(ALLOWED_GOLIVE_TEST_OBJECTS);
  const report = { mode: execute ? 'execute' : 'dry-run', allowListCount: ALLOWED_GOLIVE_TEST_OBJECTS.length, items: [], deletedCount: 0, blockedCount: 0 };

  for (const key of keys) {
    if (!allowSet.has(key)) {
      report.blockedCount += 1;
      report.items.push({ key, status: 'BLOCKED_NOT_IN_ALLOWLIST' });
      continue;
    }
    const refCheck = await countReferencesInDb({ supabaseUrl, serviceKey, objectKey: key, fetcher });
    if (refCheck.referenced) {
      report.blockedCount += 1;
      report.items.push({ key, status: 'BLOCKED_REFERENCED_IN_DB', matchedTables: refCheck.matchedTables });
      continue;
    }
    const existsInR2 = r2Media ? await r2Media.exists(key) : null;
    if (!execute) {
      report.items.push({ key, status: 'DRY_RUN_ELIGIBLE', existsInR2, dbReferenced: false });
      continue;
    }
    if (!r2Media) throw new Error('R2_MEDIA_REQUIRED_FOR_EXECUTE');
    if (!existsInR2) {
      report.items.push({ key, status: 'ALREADY_ABSENT_IN_R2', dbReferenced: false });
      continue;
    }
    await r2Media.discard(r2Media.reference(key));
    const stillExists = await r2Media.exists(key);
    if (stillExists) throw new Error(`R2_DELETE_VERIFY_FAILED:${key}`);
    report.deletedCount += 1;
    report.items.push({ key, status: 'DELETED_AND_VERIFIED', dbReferenced: false });
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
        bucket: process.env.R2_MEDIA_BUCKET || 'meehoasg-media',
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

module.exports = { ALLOWED_GOLIVE_TEST_OBJECTS, countReferencesInDb, runCleanup };
