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

test('customer notes and card instructions use scoped readable attention sections',()=>{
  assert.match(css,/\.mee-detail-note\{border-left:3px solid/);
  assert.match(css,/\.mee-detail-card\{border-left:3px solid/);
  assert.match(css,/\.mee-detail-text\{/);
  assert.match(css,/overflow-wrap:anywhere/);
  assert.doesNotMatch(css,/\.mee-detail-note\{[^}]*linear-gradient/);
  assert.doesNotMatch(css,/\.mee-detail-card\{[^}]*linear-gradient/);
});

test('highlight release has a fresh production cache token',()=>{
  const m=entry.match(/var RELEASE='([^']+)'/);
  assert.ok(m);
  assert.notEqual(m[1],'20261006-ops7');
  assert.ok(entry.includes('meehoa-core.css?v='+m[1]));
  assert.ok(entry.includes('meehoa-core.js?v='+m[1]));
});
