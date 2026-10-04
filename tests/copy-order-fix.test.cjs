const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'meehoa-v365.js'), 'utf8');

test('drawer copy resolves orders from canonical remembered order map', () => {
  assert.match(src, /S\.orders&&typeof S\.orders\.get==='function'/);
  assert.match(src, /S\.orders\.get\(id\)/);
  assert.match(src, /MEEOPS7\.copyOrderById=copyOrder/);
  assert.match(src, /function delegatedCopyTap\(e\)/);
});

test('created-order copy button is rebound to the robust copy path', () => {
  assert.match(src, /function patchCreatedCopy\(\)/);
  assert.match(src, /qs\('#copyCreated'\)/);
  assert.match(src, /pre\?pre\.textContent\|\|pre\.innerText/);
  assert.match(src, /copyNow\(text,'thông tin đơn hàng'\)/);
});

test('copy path uses synchronous selection first and still has Clipboard API/manual fallback', () => {
  assert.match(src, /function selectionCopy\(value\)/);
  assert.match(src, /function textareaCopy\(value\)/);
  assert.match(src, /document\.execCommand&&document\.execCommand\('copy'\)/);
  assert.match(src, /navigator\.clipboard&&typeof navigator\.clipboard\.writeText==='function'/);
  assert.match(src, /window\.prompt\('Sao chép thủ công nội dung bên dưới:'/);
});
