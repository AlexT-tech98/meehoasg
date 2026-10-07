const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const html=fs.readFileSync('html','utf8');
const css=fs.readFileSync('assets/meehoa-v34.css','utf8');
const entry=fs.readFileSync('index.html','utf8');

test('customer note and card text remain semantic, conditional attention blocks',()=>{
  assert.match(html,/mee-detail-section mee-detail-note/);
  assert.match(html,/GHI CHÚ KHÁCH/);
  assert.match(html,/mee-detail-section mee-detail-card/);
  assert.match(html,/NỘI DUNG THIỆP/);
  assert.match(html,/String\(o\.note\|\|''\)\.trim\(\)\?/);
  assert.match(html,/String\(o\.cardText\|\|''\)\.trim\(\)/);
});

test('important order instructions have strong visual hierarchy without changing other detail cards',()=>{
  assert.match(css,/\.mee-detail-note,\.mee-detail-card\{/);
  assert.match(css,/box-shadow:inset 4px 0 0 #d89b2b/);
  assert.match(css,/box-shadow:inset 4px 0 0 #d45472/);
  assert.match(css,/\.mee-detail-note \.mee-detail-text,\s*\.mee-detail-card \.mee-detail-text\{/);
  assert.match(css,/font-size:15px!important/);
  assert.match(css,/font-weight:760!important/);
  assert.match(css,/content:"!"!important/);
  assert.match(css,/content:"✉"!important/);
});

test('highlight release has a fresh production cache token',()=>{
  assert.match(entry,/var RELEASE='20261007-ops8'/);
  assert.match(entry,/meehoa-core\.css\?v=20261007-ops8/);
  assert.match(entry,/meehoa-core\.js\?v=20261007-ops8/);
});
