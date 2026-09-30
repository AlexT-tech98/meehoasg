const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('supabase/functions/meehoasg-ingest/apps-script-production-cutover-v9.gs', 'utf8');
const feed = fs.readFileSync('supabase/functions/meehoasg-writeback-feed/index.js', 'utf8');

test('production cutover makes Supabase the only automatic source', () => {
  assert.match(source, /MEE_SYNC_MODE/);
  assert.match(source, /props\.setProperty\(P9_MODE_KEY, 'PRODUCTION'\)/);
  const prodFn = source.slice(source.indexOf('function syncProductionV9()'), source.indexOf('function rollbackToParallelV9()'));
  assert.doesNotMatch(prodFn, /_doSync\(/);
  assert.doesNotMatch(prodFn, /syncLegacySettlements/);
});

test('cutover installer removes legacy recurring writers', () => {
  assert.match(source, /syncDelta: true/);
  assert.match(source, /syncLegacySettlementsDeltaV8: true/);
  assert.match(source, /syncLegacySettlementsToSupabase: true/);
  assert.match(source, /newTrigger\('syncProductionV9'\)/);
});

test('order identity is column O and not source_row', () => {
  assert.match(source, /getRange\(2, 15, last - 1, 1\)/);
  assert.match(source, /var id = String\(r\[0\] \|\| ''\)\.trim\(\)/);
  const apply = source.slice(source.indexOf('function _p9ApplyOrders'), source.indexOf('function _p9OrderSheets'));
  assert.doesNotMatch(apply, /source_row\s*\|\|/);
  assert.match(apply, /index\.byId\[id\]/);
});

test('month rollover creates a new monthly sheet instead of dropping orders', () => {
  assert.match(source, /ss\.insertSheet\(name\)/);
  assert.match(source, /'Tháng ' \+ key/);
  assert.match(source, /'Order ID'/);
});

test('writeback feed is paginated and bounded by a fixed sync window', () => {
  assert.match(feed, /updated_at', 'gte\.'/);
  assert.match(feed, /updated_at', 'lt\.'/);
  assert.match(feed, /offset/);
  assert.match(feed, /hasMore/);
  assert.match(feed, /updated_at\.asc,id\.asc/);
});
