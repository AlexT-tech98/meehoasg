const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const entry = fs.readFileSync('index.html', 'utf8');
const api = fs.readFileSync('supabase/functions/meehoasg-api-v361/index.js', 'utf8');
const ui = fs.readFileSync('assets/meehoa-v361.js', 'utf8');
const css = fs.readFileSync('assets/meehoa-v361.css', 'utf8');
const core = fs.readFileSync('assets/meehoa-core.js', 'utf8');

test('dashboard owner is preserved inside the consolidated frontend core', () => {
  assert.match(entry, /meehoasg-api-core/);
  assert.match(entry, /meehoa-core\.js\?v=[A-Za-z0-9._-]+/);
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

test('dashboard UI has one compact summary and one report table, without legacy chart injection', () => {
  assert.match(ui, /mee-dashboard-summary/);
  assert.match(ui, /Chưa tất toán/);
  assert.match(ui, /Đã tất toán/);
  assert.match(ui, /Báo cáo doanh thu theo nhân viên \/ ngày/);
  assert.doesNotMatch(ui, /mee-v361-charts/);
  assert.doesNotMatch(ui, /injectStyles/);
  assert.doesNotMatch(ui, /patchFit/);
  assert.match(css, /\.mee-dashboard-summary/);
  assert.match(css, /\.mee-v361-table-wrap/);
});
