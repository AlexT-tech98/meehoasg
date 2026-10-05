const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = p => fs.readFileSync(p, 'utf8');
const entry = read('index.html');
const api = read('supabase/functions/meehoasg-api-v362/index.js');
const materials = read('assets/meehoa-v362.js');
const payment = read('assets/meehoa-v364.js');
const paymentCss = read('assets/meehoa-v364.css');
const coreJs = read('assets/meehoa-core.js');
const coreCss = read('assets/meehoa-core.css');

test('API core and canonical materials/payment owners are consolidated without v363 compatibility runtime', () => {
  assert.match(entry, /meehoasg-api-core/);
  assert.match(entry, /meehoa-core\.css\?v=[A-Za-z0-9._-]+/);
  assert.match(entry, /meehoa-core\.js\?v=[A-Za-z0-9._-]+/);
  assert.match(coreCss, /===== meehoa-v362\.css =====/);
  assert.match(coreJs, /===== meehoa-v362\.js =====/);
  assert.match(coreJs, /===== meehoa-v364\.js =====/);
  assert.doesNotMatch(coreJs, /===== meehoa-v363\.js =====/);
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

test('v362 owns materials diagnostics only and no longer patches payment', () => {
  assert.match(materials, /patchMaterialsStatus/);
  assert.doesNotMatch(materials, /patchSettlement/);
  assert.doesNotMatch(materials, /S\.page!=='settlement'/);
});

test('v364 is the only payment UI owner and uses the real payment route', () => {
  assert.match(payment, /S\.page!=='payment'/);
  assert.match(payment, /mee-settlement-grid-v364/);
  assert.match(payment, /mee-settlement-select-all-v364/);
  assert.match(payment, /Bankful full hoa/);
  assert.match(paymentCss, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(paymentCss, /height:150px!important/);
});
