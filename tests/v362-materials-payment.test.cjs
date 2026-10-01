const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = p => fs.readFileSync(p, 'utf8');
const entry = read('index.html');
const api = read('supabase/functions/meehoasg-api-v362/index.js');
const js = read('assets/meehoa-v362.js');
const css = read('assets/meehoa-v362.css');

test('production routes to v362 and loads v362 assets', () => {
  assert.match(entry, /meehoasg-api-v362/);
  assert.match(entry, /meehoa-v362\.css\?v=4\.6\.2/);
  assert.match(entry, /meehoa-v362\.js\?v=4\.6\.2/);
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

test('payment check becomes a card grid with select all and bounded proofs', () => {
  assert.match(js, /mee-settlement-grid/);
  assert.match(js, /mee-settlement-select-all/);
  assert.match(js, /Chọn tất cả/);
  assert.match(css, /grid-template-columns:repeat\(auto-fit,minmax\(310px,1fr\)\)/);
  assert.match(css, /height:168px!important/);
});
