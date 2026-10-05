const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const api=fs.readFileSync('supabase/functions/meehoasg-api-v365/index.js','utf8');
const ui=fs.readFileSync('assets/meehoa-v366.js','utf8');

test('SALE bootstrap is repaired through full getOrders before initial render',()=>{
  assert.match(api,/repairBootstrapOrders/);
  assert.match(api,/initial\?\.page!=='orders'/);
  assert.match(api,/name:'getOrders'/);
  assert.match(api,/pageSize:80/);
});

test('canonical sale identity derives from app_users username and display name',()=>{
  assert.match(api,/function saleKey\(v\)/);
  assert.match(api,/replace\(\/\[\^a-z0-9\]\/g,''\)/);
  assert.match(api,/app_users/);
  assert.match(api,/map\.set\(saleKey\(u\.username\),u\)/);
  assert.match(api,/map\.set\(saleKey\(u\.display_name\),u\)/);
  assert.match(api,/saleIdentityRule='APP_USERS_CANONICAL'/);
});

test('dashboard and KPI are canonicalized by the same identity rule',()=>{
  assert.match(api,/canonicalizeDashboard/);
  assert.match(api,/canonicalizeKpi/);
  assert.match(api,/name==='getKpi'/);
});

test('order copy excludes order id and uses synchronous clipboard fallback',()=>{
  assert.match(ui,/function buildCopyText\(o\)/);
  assert.doesNotMatch(ui,/Mã đơn:/);
  assert.match(ui,/document\.execCommand&&document\.execCommand\('copy'\)/);
  assert.match(ui,/MEEOPS7\.copyOrderById=copyOrder/);
  assert.match(ui,/document\.addEventListener\('click',delegatedCopyTap,true\)/);
});

test('shortcut has in-app reload control without signing out',()=>{
  assert.match(ui,/meeReloadApp/);
  assert.match(ui,/Tải lại ứng dụng/);
  assert.match(ui,/location\.reload\(\)/);
  assert.match(ui,/meehoa-shell-/);
  assert.doesNotMatch(ui,/mee_token.*removeItem/);
});
