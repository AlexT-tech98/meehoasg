#!/usr/bin/env node
'use strict';

/**
 * MEEHOA OPS V3.1 — Controlled Batch Migration for All 919 Legacy Bills
 * Covers BOTH Owner-approved sources:
 *   1. `public.settlement_requests.bill_urls` (430 distinct bills)
 *   2. `public.orders.full_paid_bill_urls`    (489 distinct bills, 0 overlap -> 919 total)
 *
 * Default mode is DRY-RUN (strictly read-only).
 * Never deletes Supabase Storage originals; cleanup requires a separate Owner approval after verification.
 *
 * Usage:
 *   Dry-run inventory (all 919 bills by default; pass `--scope=settlement_requests` or `--scope=full_paid_orders` if needed):
 *     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-settlement-bills-to-r2.cjs
 *   Controlled copy + SHA-256 & R2 GET verify (does NOT switch DB references yet):
 *     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... R2_COPY_API_KEY=... \
 *       node scripts/migrate-settlement-bills-to-r2.cjs --copy --batch-size=20 --report=artifacts/r2-919-verified.json
 *   Verify-only pass (re-reads every key from R2 and compares SHA-256 against Supabase):
 *     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... R2_COPY_API_KEY=... \
 *       node scripts/migrate-settlement-bills-to-r2.cjs --verify --batch-size=20
 */

const fs = require('node:fs');
const path = require('node:path');

const VALID_KEY = /^[0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp)$/;

function parseArgs(argv) {
  const args = {
    mode: 'dry-run',
    scope: 'all', // 'all' (919) | 'settlement_requests' (430) | 'full_paid_orders' (489)
    batchSize: 20,
    r2Bucket: process.env.R2_MEDIA_BUCKET || 'meehoasg-website-media',
    reportPath: '',
  };
  for (const token of argv) {
    if (token === '--copy') args.mode = 'copy';
    else if (token === '--verify') args.mode = 'verify';
    else if (token === '--dry-run') args.mode = 'dry-run';
    else if (token.startsWith('--scope=')) {
      const sc = token.split('=')[1];
      if (['all', 'settlement_requests', 'full_paid_orders'].includes(sc)) args.scope = sc;
      else throw new Error(`Invalid --scope=${sc}`);
    } else if (token.startsWith('--batch-size=')) args.batchSize = Math.max(1, Math.min(50, Number(token.split('=')[1]) || 20));
    else if (token.startsWith('--bucket=')) args.r2Bucket = token.split('=')[1] || args.r2Bucket;
    else if (token.startsWith('--report=')) args.reportPath = token.split('=')[1] || '';
  }
  return args;
}

async function fetchAllSettlementRequests({ supabaseUrl, serviceKey, fetcher = fetch }) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${supabaseUrl}/rest/v1/settlement_requests`);
    url.searchParams.set('select', 'id,order_id,status,submitted_at,bill_urls');
    url.searchParams.set('order', 'submitted_at.asc');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('offset', String(offset));
    const res = await fetcher(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (!res.ok) throw new Error(`REST settlement_requests ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function fetchOrdersWithFullPaidBills({ supabaseUrl, serviceKey, fetcher = fetch }) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${supabaseUrl}/rest/v1/orders`);
    url.searchParams.set('select', 'id,full_paid,is_deleted,delete_after_sheet_sync,full_paid_bill_urls');
    url.searchParams.set('full_paid_bill_urls', 'neq.[]');
    url.searchParams.set('order', 'id.asc');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('offset', String(offset));
    const res = await fetcher(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (!res.ok) throw new Error(`REST orders(full_paid_bill_urls) ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function extractLegacySettlementBillKeys(settlementRows = [], fullPaidOrderRows = [], scope = 'all') {
  const srKeySet = new Set();
  const fpKeySet = new Set();
  const invalid = [];
  let affectedSettlementRequests = 0;
  let affectedFullPaidOrders = 0;

  if (scope === 'all' || scope === 'settlement_requests') {
    for (const row of settlementRows || []) {
      const urls = Array.isArray(row.bill_urls) ? row.bill_urls : [];
      let rowHasSupabase = false;
      for (const raw of urls) {
        const m = String(raw || '').match(/^supabase:\/\/settlement-bills\/(.+)$/);
        if (!m) continue;
        rowHasSupabase = true;
        if (!VALID_KEY.test(m[1])) invalid.push({ source: 'settlement_requests', id: row.id, raw });
        else srKeySet.add(m[1]);
      }
      if (rowHasSupabase) affectedSettlementRequests += 1;
    }
  }

  if (scope === 'all' || scope === 'full_paid_orders') {
    for (const row of fullPaidOrderRows || []) {
      const urls = Array.isArray(row.full_paid_bill_urls) ? row.full_paid_bill_urls : [];
      let rowHasSupabase = false;
      for (const raw of urls) {
        const m = String(raw || '').match(/^supabase:\/\/settlement-bills\/(.+)$/);
        if (!m) continue;
        rowHasSupabase = true;
        if (!VALID_KEY.test(m[1])) invalid.push({ source: 'orders.full_paid_bill_urls', id: row.id, raw });
        else fpKeySet.add(m[1]);
      }
      if (rowHasSupabase) affectedFullPaidOrders += 1;
    }
  }

  let overlapCount = 0;
  for (const k of srKeySet) {
    if (fpKeySet.has(k)) overlapCount += 1;
  }
  const combined = new Set([...srKeySet, ...fpKeySet]);
  return {
    keys: [...combined].sort(),
    srKeys: [...srKeySet].sort(),
    fpKeys: [...fpKeySet].sort(),
    overlapCount,
    invalid,
    affectedRows: affectedSettlementRequests + affectedFullPaidOrders,
    affectedSettlementRequests,
    affectedFullPaidOrders,
    totalSettlementRequests: (settlementRows || []).length,
    totalFullPaidCandidateOrders: (fullPaidOrderRows || []).length,
  };
}

async function runMigration({
  supabaseUrl,
  serviceKey,
  copyApiKey,
  mode = 'dry-run',
  scope = 'all',
  batchSize = 20,
  r2Bucket = 'meehoasg-website-media',
  fetcher = fetch,
}) {
  const [srRows, fpRows] = await Promise.all([
    scope === 'full_paid_orders' ? Promise.resolve([]) : fetchAllSettlementRequests({ supabaseUrl, serviceKey, fetcher }),
    scope === 'settlement_requests' ? Promise.resolve([]) : fetchOrdersWithFullPaidBills({ supabaseUrl, serviceKey, fetcher }),
  ]);
  const plan = extractLegacySettlementBillKeys(srRows, fpRows, scope);
  if (plan.invalid.length) {
    throw new Error(`Found ${plan.invalid.length} unexpected bill key(s): ${JSON.stringify(plan.invalid.slice(0, 5))}`);
  }
  const summary = {
    mode,
    scope,
    r2Bucket,
    totalSettlementRequests: plan.totalSettlementRequests,
    affectedSettlementRequests: plan.affectedSettlementRequests,
    distinctSettlementRequestBills: plan.srKeys.length,
    affectedFullPaidOrders: plan.affectedFullPaidOrders,
    distinctFullPaidOrderBills: plan.fpKeys.length,
    overlapCount: plan.overlapCount,
    distinctLegacyBills: plan.keys.length,
    batchSize,
    batchesRun: 0,
    verifiedKeys: [],
    copiedCount: 0,
    alreadyOnR2VerifiedCount: 0,
    verifiedBytes: 0,
    failed: [],
    supabaseOriginalsDeleted: false,
  };
  if (mode === 'dry-run') return summary;
  if (!copyApiKey) throw new Error('R2_COPY_API_KEY is required for --copy or --verify');
  const copyUrl = `${supabaseUrl}/functions/v1/meehoasg-r2-copy`;
  for (let i = 0; i < plan.keys.length; i += batchSize) {
    const slice = plan.keys.slice(i, i + batchSize);
    const res = await fetcher(copyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: copyApiKey },
      body: JSON.stringify({ bucket: 'settlement-bills', mode, keys: slice }),
    });
    const data = await res.json();
    summary.batchesRun += 1;
    if (!res.ok || !data.ok) {
      summary.failed.push(...(Array.isArray(data.failed) ? data.failed : [{ batchStart: i, error: data.error || `HTTP ${res.status}` }]));
      break;
    }
    const batchVerified = data.verifiedKeys || slice;
    const batchCopied = Number(data.copied || 0);
    summary.verifiedKeys.push(...batchVerified);
    summary.copiedCount += batchCopied;
    summary.alreadyOnR2VerifiedCount += Math.max(0, batchVerified.length - batchCopied);
    summary.verifiedBytes += Number(data.bytes || 0);
  }
  summary.ok = summary.failed.length === 0 && summary.verifiedKeys.length === plan.keys.length;
  return summary;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const copyApiKey = process.env.R2_COPY_API_KEY || '';
  if (!supabaseUrl || !serviceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  runMigration({ supabaseUrl, serviceKey, copyApiKey, ...args })
    .then((result) => {
      if (args.reportPath) {
        fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
        fs.writeFileSync(args.reportPath, JSON.stringify(result, null, 2));
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.failed && result.failed.length) process.exit(2);
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = { parseArgs, extractLegacySettlementBillKeys, runMigration };
