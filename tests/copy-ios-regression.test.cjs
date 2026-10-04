const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const src = fs.readFileSync('assets/meehoa-v365.js','utf8');

test('copy path tries synchronous selection copy before async clipboard fallback', () => {
  assert.match(src, /selectionCopy\(value\)/);
  assert.match(src, /if\(selectionCopy\(value\)\)return Promise\.resolve\(success\(\)\)/);
  const selectionPos = src.indexOf('selectionCopy(value)');
  const clipboardPos = src.indexOf('navigator.clipboard');
  assert.ok(selectionPos >= 0 && clipboardPos > selectionPos);
});

test('overlay mutations rebind all copy actions after MEEOPS7 becomes available', () => {
  assert.match(src, /function patchCopyActions\(\)/);
  assert.match(src, /patchCreatedCopy\(\);wrapCopy\(\)/);
  assert.match(src, /new MutationObserver\(function\(\)\{setTimeout\(function\(\)\{patchOrderForm\(\);patchCopyActions\(\)\}/);
});
