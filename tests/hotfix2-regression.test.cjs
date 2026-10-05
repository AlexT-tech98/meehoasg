const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

// This contract runs after the consolidated core has been generated from canonical v365 sources.
const js = fs.readFileSync('assets/meehoa-v365.js', 'utf8');
const entry = fs.readFileSync('index.html', 'utf8');

test('canonical v365 parses and production shell loads only consolidated core', () => {
  assert.doesNotThrow(() => new vm.Script(js));
  assert.match(entry, /meehoa-core\.js\?v=20261005-canonical2/);
  assert.match(entry, /meehoa-core\.css\?v=20261005-canonical2/);
  assert.doesNotMatch(entry, /meehoa-runtime-fix-20261005/);
  assert.doesNotMatch(entry, /meehoa-hotfix-20261005/);
  assert.doesNotMatch(entry, /meehoa-ops-hotfix2/);
});

test('dashboard has one guarded one-hour tracker in canonical source', () => {
  assert.match(js, /hourlyBusy/);
  assert.match(js, /id='meeHourlySingleV365'/);
  assert.match(js, /cleanupHourly\(content\)/);
  assert.match(js, /hourLabel\(h\)/);
  assert.match(js, /map\[h\]=\(map\[h\]\|\|0\)\+1/);
  assert.doesNotMatch(js, /08–10|10–12|12–14|14–16|16–18|18–20/);
});

test('copy contract is canonical, sectioned and newline-safe', () => {
  assert.match(js, /MẪU HOA/);
  assert.match(js, /GIAO NHẬN/);
  assert.match(js, /THANH TOÁN/);
  assert.match(js, /if\(textareaCopy\(value\)\)return Promise\.resolve\(success\(\)\)/);
  assert.match(js, /\[onclick\*="copyOrderField"\]/);
  assert.match(js, /removeAttribute\('onclick'\)/);
});

test('create-confirmation and admin delete flows live in canonical source', () => {
  assert.match(js, /meehoasg-create-status/);
  assert.match(js, /mee_pending_create/);
  assert.match(js, /meehoasg-delete-order/);
  assert.match(js, /S\.user\.role!==['"]ADMIN['"]/);
  assert.match(js, /className='btn danger full mee-delete-order'/);
  assert.match(js, /window\.confirm/);
});
