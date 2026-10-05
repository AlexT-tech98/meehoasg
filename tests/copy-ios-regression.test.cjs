const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const src = fs.readFileSync('assets/meehoa-v365.js','utf8');

test('copy path uses textarea first so plain-text newlines survive clipboard copy', () => {
  assert.match(src, /if\(textareaCopy\(value\)\)return Promise\.resolve\(success\(\)\)/);
  const textareaPos = src.indexOf('textareaCopy(value)');
  const clipboardPos = src.indexOf('navigator.clipboard');
  assert.ok(textareaPos >= 0 && clipboardPos > textareaPos);
  assert.doesNotMatch(src, /selectionCopy\(value\)\|\|textareaCopy\(value\)/);
});

test('full-order copy text is sectioned and joined with literal line breaks', () => {
  for (const label of ['THÔNG TIN ĐƠN HÀNG','MẪU HOA','GIAO NHẬN','THANH TOÁN']) assert.match(src, new RegExp(label));
  assert.match(src, /join\('\\n'\)\.trim\(\)/);
});

test('drawer copy targets are rebound directly after overlay render', () => {
  assert.match(src, /function bindCopyTargets\(\)/);
  assert.match(src, /\[onclick\*="copyOrderById"\]/);
  assert.match(src, /\[onclick\*="copyOrderField"\]/);
  assert.match(src, /removeAttribute\('onclick'\)/);
  assert.match(src, /addEventListener\('click',run\)/);
});
