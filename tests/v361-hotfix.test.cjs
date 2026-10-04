const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const entry = fs.readFileSync('index.html', 'utf8');
const api = fs.readFileSync('supabase/functions/meehoasg-api-v361/index.js', 'utf8');
const ui = fs.readFileSync('assets/meehoa-v361.js', 'utf8');
const core = fs.readFileSync('assets/meehoa-core.js', 'utf8');

test('v361 UI behavior is preserved inside the consolidated frontend core', () => {
  assert.match(entry, /meehoasg-api-core/);
  assert.match(entry, /meehoa-core\.js\?v=20261004-\d+/);
  assert.match(core, /===== meehoa-v361\.js =====/);
});

test('dashboard splits unsettled and settled revenue while CMS remains settled-only', () => {
  assert.match(api, /unsettledRevenue/);
  assert.match(api, /settledRevenue/);
  assert.match(api, /revenueRule = 'SPLIT_SETTLEMENT'/);
  assert.match(api, /cms: settledRevenue \* 0\.08/);
});

test('materials use direct session authentication instead of production-route delegation', () => {
  assert.match(api, /requireProxyUser/);
  assert.match(api, /app_sessions/);
  assert.match(api, /\['ADMIN', 'THO_OPS'\]/);
  const flowerFn = api.slice(api.indexOf('async function patchFlowers'), api.indexOf('Deno.serve'));
  assert.doesNotMatch(flowerFn, /delegate\('getProductionOrders'/);
});

test('dashboard UI is compact and report table precedes bottom chart', () => {
  assert.match(ui, /mee-dashboard-summary/);
  assert.match(ui, /Chưa tất toán/);
  assert.match(ui, /Đã tất toán/);
  assert.match(ui, /Báo cáo doanh thu theo nhân viên \/ ngày/);
  assert.match(ui, /mee-chart-grid mee-v361-charts/);
  assert.ok(ui.indexOf('mee-v361-table-wrap') < ui.indexOf('mee-chart-grid mee-v361-charts'));
});

test('desktop hotfix cancels the stale 228px topbar offset and constrains KPI cards', () => {
  assert.match(ui, /\.topbar\{left:0!important/);
  assert.match(ui, /repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(ui, /sales-kpi-card\{min-width:0!important/);
});
