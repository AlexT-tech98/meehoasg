const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const ops = fs.readFileSync('assets/meehoa-v366.js', 'utf8');
const dashboard = fs.readFileSync('assets/meehoa-v361.js', 'utf8');
const entry = fs.readFileSync('index.html', 'utf8');

test('canonical ops runtime parses and production shell loads only consolidated core', () => {
  assert.doesNotThrow(() => new vm.Script(ops));
  assert.doesNotThrow(() => new vm.Script(dashboard));
  assert.match(entry, /meehoa-core\.js\?v=[A-Za-z0-9._-]+/);
  assert.match(entry, /meehoa-core\.css\?v=[A-Za-z0-9._-]+/);
  assert.match(entry, /var RELEASE='\d{8}[-\w]*'/);
  assert.match(entry, /var SHELL_KEY='meehoa-shell-core-'\+RELEASE/);
  assert.doesNotMatch(entry, /meehoa-runtime-fix-20261005/);
  assert.doesNotMatch(entry, /meehoa-hotfix-20261005/);
  assert.doesNotMatch(entry, /meehoa-ops-hotfix2/);
});

test('dashboard owns the one-hour tracker and ops runtime does not re-fetch it', () => {
  assert.match(dashboard, /function hourlyModel/);
  assert.match(dashboard, /id='meeHourlySingleV361'/);
  assert.match(dashboard, /window\.gas\('getOrders'/);
  assert.match(dashboard, /hourlyState\.dashboardRef!==r/);
  assert.doesNotMatch(ops, /renderHourly|cleanupHourly|hourlyBusy|hourlyLastAt|meeHourlySingleV365/);
  assert.doesNotMatch(dashboard, /08–10|10–12|12–14|14–16|16–18|18–20/);
});

test('copy contract is canonical, sectioned and newline-safe', () => {
  assert.match(ops, /MẪU HOA/);
  assert.match(ops, /GIAO NHẬN/);
  assert.match(ops, /THANH TOÁN/);
  assert.match(ops, /if\(textareaCopy\(value\)\)return Promise\.resolve\(success\(\)\)/);
  assert.match(ops, /\[onclick\*="copyOrderField"\]/);
  assert.match(ops, /removeAttribute\('onclick'\)/);
});

test('admin delete remains canonical and early creation confirmation is removed', () => {
  assert.doesNotMatch(ops, /meehoasg-create-status|mee_pending_create|MEEOPS7\.saveOrder=/);
  assert.match(ops, /meehoasg-delete-order/);
  assert.match(ops, /S\.user\.role!==['"]ADMIN['"]/);
  assert.match(ops, /className='btn danger full mee-delete-order'/);
  assert.match(ops, /window\.confirm/);
});
