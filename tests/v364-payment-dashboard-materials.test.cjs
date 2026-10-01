const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const entry=fs.readFileSync('index.html','utf8');
const api=fs.readFileSync('supabase/functions/meehoasg-api-v364/index.js','utf8');
const js=fs.readFileSync('assets/meehoa-v364.js','utf8');
const css=fs.readFileSync('assets/meehoa-v364.css','utf8');

test('production routes through v364 and force-loads corrected v364 assets',()=>{
  assert.match(entry,/meehoasg-api-v364/);
  assert.match(entry,/meehoa-v364\.css\?v=4\.6\.5/);
  assert.match(entry,/meehoa-v364\.js\?v=4\.6\.5/);
});

test('dashboard API is handled directly instead of the multi-proxy chain',()=>{
  assert.match(api,/name==='getDashboardSummary'/);
  assert.match(api,/result=await fastDashboard\(payload\)/);
  assert.match(api,/SPLIT_SETTLEMENT/);
});

test('admin auth bootstrap is upgraded to the same fresh dashboard contract',()=>{
  assert.match(api,/async function patchBootstrapDashboard/);
  assert.match(api,/name==='loginAndBootstrap'\|\|name==='getCurrentUserAndBootstrap'/);
  assert.match(api,/result=await patchBootstrapDashboard\(name,payload,u\.data\)/);
  assert.match(api,/initial:\{\.\.\.result\.initial,data:fresh,at:Date\.now\(\)\}/);
  assert.match(api,/settledRevenue/);
  assert.match(api,/unsettledRevenue/);
});

test('materials has an explicit local fallback when Gemini key is absent',()=>{
  assert.match(api,/!GEMINI_KEY/);
  assert.match(api,/FALLBACK_NO_KEY/);
  assert.match(api,/v364-local-fallback/);
  assert.match(api,/Hồng Ecuador/);
  assert.match(api,/Ly xanh nhuộm/);
});

test('payment patch runs on the actual payment page, not a nonexistent settlement page',()=>{
  assert.match(js,/S\.page!=='payment'/);
  assert.doesNotMatch(js,/S\.page!=='settlement'/);
  assert.match(js,/\.settlement-card/);
  assert.match(js,/\.settle-check/);
  assert.match(js,/Chọn tất cả/);
  assert.match(css,/mee-settlement-grid-v364/);
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css,/height:150px!important/);
});

test('paid production card copy is Bankful full hoa',()=>{assert.match(js,/Bankful full hoa/)});
