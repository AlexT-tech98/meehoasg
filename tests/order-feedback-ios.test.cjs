const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const css=fs.readFileSync('assets/meehoa-core.css','utf8');
const latest=fs.readFileSync('assets/meehoa-v366.js','utf8');
const core=fs.readFileSync('assets/meehoa-core.js','utf8');
const index=fs.readFileSync('index.html','utf8');

test('toast and loading remain visible above mobile order modal',()=>{
  assert.match(css,/#overlay \.modal-bg,#overlay \.drawer-bg\{z-index:1000!important\}/);
  assert.match(css,/#toast\.toast\{z-index:2147483006!important/);
  assert.match(css,/#loading\.loading\{z-index:2147483005!important/);
});

test('invalid required order input produces actionable mobile feedback without API call',()=>{
  assert.match(latest,/document\.addEventListener\('invalid',explainInvalidOrderField,true\)/);
  assert.match(latest,/form\.id!=='orderForm'/);
  assert.match(latest,/window\.toast\('Vui lòng kiểm tra '/);
  assert.match(latest,/field\.scrollIntoView/);
  assert.match(core,/document\.addEventListener\('invalid',explainInvalidOrderField,true\)/);
});

test('a bumped release key invalidates the cached production shell',()=>{
  assert.match(index,/20261008-order-feedback1/);
  assert.doesNotMatch(index,/20261007-ops9/);
});
