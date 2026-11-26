#!/usr/bin/env node
'use strict';

/**
 * MEEHOA OPS V3.1 — Controlled Batch Migration for Legacy Settlement Bills (~430 bills)
 * Default mode is DRY-RUN (strictly read-only).
 * Never deletes Supabase Storage originals; cleanup requires a separate Owner approval after verification.
 *
 * Usage:
 *   Dry-run inventory:
 *     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-settlement-bills-to-r2.cjs
 *   Controlled copy + SHA-256 & R2 GET verify (does NOT switch DB references yet):
 *     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... R2_COPY_API_KEY=... \
 *       node scripts/migrate-settlement-bills-to-r2.cjs --copy --batch-size=20
 *   Verify-only pass (re-reads every key from R2 and compares SHA-256 against Supabase):
 *     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... R2_COPY_API_KEY=... \
 *       node scripts/migrate-settlement-bills-to-r2.cjs --verify --batch-size=20
 */

const fs = require('node:fs');
const path = require('node:path');

const VALID_KEY = /^[0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp)$/;

function parseArgs(argv) {
  const args = { mode: 'dry-run', batchSize: 20, r2Bucket: process.env.R2_MEDIA_BUCKET || 'meehoasg-website-media', reportPath: '' };
  for (const token of argv) {
    if (token === '--copy') args.mode = 'copy';
    else if (token === '--verify') args.mode = 'verify';
    else if (token === '--dry-run') args.mode = 'dry-run';
    else if (token.startsWith('--batch-size=')) args.batchSize = Math.max(1, Math.min(50, Number(token.split('=')[1]) || 20));
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

function extractLegacySettlementBillKeys(rows) {
  const keySet = new Set();
  const invalid = [];
  let affectedRows = 0;
  for (const row of rows || []) {
    const urls = Array.isArray(row.bill_urls) ? row.bill_urls : [];
    let rowHasSupabase = false;
    for (const raw of urls) {
      const m = String(raw || '').match(/^supabase:\/\/settlement-bills\/(.+)$/);
      if (!m) continue;
      rowHasSupabase = true;
      if (!VALID_KEY.test(m[1])) invalid.push({ settlementId: row.id, raw });
      else keySet.add(m[1]);
    }
    if (rowHasSupabase) affectedRows += 1;
  }
  return { keys: [...keySet].sort(), invalid, affectedRows, totalRows: (rows || []).length };
}

async function runMigration({ supabaseUrl, serviceKey, copyApiKey, mode, batchSize, r2Bucket, fetcher = fetch }) {
  const rows = await fetchAllSettlementRequests({ supabaseUrl, serviceKey, fetcher });
  const plan = extractLegacySettlementBillKeys(rows);
  if (plan.invalid.length) {
    throw new Error(`Found ${plan.invalid.length} unexpected settlement bill key(s): ${JSON.stringify(plan.invalid.slice(0, 5))}`);
  }
  const summary = {
    mode,
    r2Bucket,
    totalSettlementRequests: plan.totalRows,
    affectedSettlementRequests: plan.affectedRows,
    distinctLegacyBills: plan.keys.length,
    batchSize,
    batchesRun: 0,
    verifiedKeys: [],
    copiedCount: 0,
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
    summary.verifiedKeys.push(...(data.verifiedKeys || slice));
    summary.copiedCount += Number(data.copied || 0);
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
