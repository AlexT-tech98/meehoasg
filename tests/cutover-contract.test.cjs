const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const safe = fs.readFileSync('supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.1.gs', 'utf8');
const fast = fs.readFileSync('supabase/functions/meehoasg-ingest/apps-script-production-sync-v9.2-fast.gs', 'utf8');
const feed = fs.readFileSync('supabase/functions/meehoasg-writeback-feed/index.js', 'utf8');

test('production v9.1 and v9.2 Apps Scripts parse as JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(safe));
  assert.doesNotThrow(() => new vm.Script(fast));
});

test('v9.1 cutover makes Supabase the only automatic production source', () => {
  assert.match(safe, /MEE_SYNC_MODE/);
  assert.match(safe, /props\.setProperty\(P91_MODE_KEY, 'PRODUCTION'\)/);
  assert.match(safe, /function preflightProductionV91\(\)/);
  assert.match(safe, /duplicateOrderIds/);
  assert.match(safe, /duplicateMetaIds/);

  const prodFn = safe.slice(
    safe.indexOf('function syncProductionV91()'),
    safe.indexOf('function rollbackToParallelV91()')
  );
  assert.doesNotMatch(prodFn, /_doSync\(/);
  assert.doesNotMatch(prodFn, /syncLegacySettlements/);
});

test('v9.1 installer removes legacy recurring writers and supports controlled rollback', () => {
  assert.match(safe, /syncDelta: true/);
  assert.match(safe, /syncLegacySettlementsDeltaV8: true/);
  assert.match(safe, /syncLegacySettlementsToSupabase: true/);
  assert.match(safe, /newTrigger\('syncProductionV91'\)/);
  assert.match(safe, /function rollbackToParallelV91\(\)/);
});

test('v9.1 row identity is Order ID and source_row is cache only', () => {
  assert.match(safe, /getRange\(2, 15, last - 1, 1\)/);
  assert.doesNotMatch(safe, /targetRow\s*=\s*Number\(o\.source_row/);
  assert.doesNotMatch(safe, /source_row\s*\|\|\s*o\.source_row/);
});

test('v9.2 installs one-minute delta sync and separate 15-minute health audit', () => {
  assert.match(fast, /newTrigger\('syncProductionV92'\)/);
  assert.match(fast, /everyMinutes\(1\)/);
  assert.match(fast, /newTrigger\('auditProductionV92Health'\)/);
  assert.match(fast, /everyMinutes\(15\)/);
  assert.match(fast, /syncDelta: true/);
  assert.match(fast, /syncLegacySettlementsDeltaV8: true/);
});

test('v9.2 uses the delta-first fast path and does not full-audit every minute', () => {
  const start = fast.indexOf('function syncProductionV92()');
  const end = fast.indexOf('function auditProductionV92Health()');
  const prodFn = fast.slice(start, end);

  assert.ok(prodFn.indexOf('_p91FetchFeed') >= 0);
  assert.ok(prodFn.indexOf('_p92ApplyChangedOrders') > prodFn.indexOf('_p91FetchFeed'));
  assert.doesNotMatch(prodFn, /_p91AuditProductionReadiness\(/);
  assert.match(prodFn, /if \(!allOrders\.length\)/);
  assert.match(prodFn, /v9\.2: 0 thay đổi từ Supabase/);
});

test('v9.2 validates only changed Order IDs and fails closed on duplicates', () => {
  assert.match(fast, /_p92FindOrderOccurrences/);
  assert.match(fast, /_p92FindMetaOccurrences/);
  assert.match(fast, /Order ID trùng trong legacy/);
  assert.match(fast, /Meta trùng|Tab\/meta không rõ/);
  assert.match(fast, /matchEntireCell\(true\)/);
});

test('month rollover still creates a monthly sheet through the v9.1 safe helper', () => {
  assert.match(fast, /_p91FindOrCreateMonthSheet/);
  assert.match(fast, /'Tháng ' \+ key/);
});

test('writeback feed is paginated and bounded by a fixed sync window', () => {
  assert.match(feed, /updated_at', 'gte\.'/);
  assert.match(feed, /updated_at', 'lt\.'/);
  assert.match(feed, /offset/);
  assert.match(feed, /hasMore/);
  assert.match(feed, /updated_at\.asc,id\.asc/);
});
