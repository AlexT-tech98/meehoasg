const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const js = fs.readFileSync('assets/meehoa-runtime-fix-20261005.js', 'utf8');
const entry = fs.readFileSync('index.html', 'utf8');

test('single production runtime patch parses and replaces stacked hotfix loaders', () => {
  assert.doesNotThrow(() => new vm.Script(js));
  assert.match(entry, /meehoa-runtime-fix-20261005\.js\?v=3/);
  assert.doesNotMatch(entry, /meehoa-hotfix-20261005\.js\?v=1/);
  assert.doesNotMatch(entry, /meehoa-ops-hotfix2\.js\?v=2/);
});

test('dashboard has exactly one guarded one-hour tracker contract', () => {
  assert.match(js, /hourlyBusy/);
  assert.match(js, /id='meeHourlySingleV3'/);
  assert.match(js, /cleanupHourly\(content\)/);
  assert.match(js, /hourLabel\(h\)/);
  assert.match(js, /map\[h\]=\(map\[h\]\|\|0\)\+1/);
  assert.doesNotMatch(js, /08–10|10–12|12–14|14–16|16–18|18–20/);
});

test('copy contract uses readable sections and binds drawer copy targets directly', () => {
  assert.match(js, /MẪU HOA/);
  assert.match(js, /GIAO NHẬN/);
  assert.match(js, /THANH TOÁN/);
  assert.match(js, /selectionCopy\(value\)\|\|textareaCopy\(value\)/);
  assert.match(js, /\[onclick\*="copyOrderField"\]/);
  assert.match(js, /removeAttribute\('onclick'\)/);
});

test('admin drawer keeps guarded delete flow', () => {
  assert.match(js, /meehoasg-delete-order/);
  assert.match(js, /S\.user\.role!==['"]ADMIN['"]/);
  assert.match(js, /className='btn danger full mee-delete-order'/);
  assert.match(js, /window\.confirm/);
});
