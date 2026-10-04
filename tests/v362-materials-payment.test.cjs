const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = p => fs.readFileSync(p, 'utf8');
const entry = read('index.html');
const api = read('supabase/functions/meehoasg-api-v362/index.js');
const compat = read('supabase/functions/meehoasg-api-v363/index.js');
const js = read('assets/meehoa-v362.js');
const js363 = read('assets/meehoa-v363.js');
const css = read('assets/meehoa-v362.css');
const coreJs = read('assets/meehoa-core.js');
const coreCss = read('assets/meehoa-core.css');

test('refactor routes through API core while preserving v362/v363 behavior inside consolidated assets', () => {
  assert.match(entry, /meehoasg-api-core/);
  assert.match(entry, /meehoa-core\.css\?v=20261004-\d+/);
  assert.match(entry, /meehoa-core\.js\?v=20261004-\d+/);
  assert.match(coreCss, /===== meehoa-v362\.css =====/);
  assert.match(coreJs, /===== meehoa-v362\.js =====/);
  assert.match(coreJs, /===== meehoa-v363\.js =====/);
});

test('v363 preserves the browser build contract instead of blocking login', () => {
  assert.match(compat, /UI_BUILD = '2026\.09\.28-supabase-v3'/);
  assert.match(compat, /build: UI_BUILD/);
  assert.match(compat, /proxyBuild: PROXY_BUILD/);
});

test('materials tries current Gemini models and exposes AI diagnostics', () => {
  assert.match(api, /gemini-3\.8-flash/);
  assert.match(api, /gemini-3\.5-flash-lite/);
  assert.match(api, /aiStatus/);
  assert.match(api, /aiModelsTried/);
  assert.match(api, /status:'ai_unavailable'/);
  assert.match(api, /v362-ai-fix/);
});

test('materials no longer turns an AI outage into every order needing review', () => {
  const unavailable = api.slice(api.indexOf("if(aiFailure)"), api.indexOf('const fingerprintByKey'));
  assert.match(unavailable, /reviewCount:0/);
  assert.match(unavailable, /reviewOrders:\[\]/);
});

test('legacy payment patch remains present in consolidated UI during transition', () => {
  assert.match(js, /mee-settlement-grid/);
  assert.match(js363, /mee-settlement-select-all/);
  assert.match(js363, /Chọn tất cả/);
  assert.match(css, /grid-template-columns:repeat\(auto-fit,minmax\(310px,1fr\)\)/);
  assert.match(css, /height:168px!important/);
});

test('order-card paid status compatibility copy remains available', () => {
  assert.match(js363, /Bankful full hoa/);
  assert.match(js363, /Đã tất toán/);
});
