const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const js = fs.readFileSync('assets/meehoa-ops-hotfix2.js', 'utf8');
const entry = fs.readFileSync('index.html', 'utf8');

test('ops hotfix2 parses as JavaScript and is loaded by production shell', () => {
  assert.doesNotThrow(() => new vm.Script(js));
  assert.match(entry, /meehoa-ops-hotfix2\.js\?v=2/);
});

test('dashboard uses one-hour buckets and only materializes hours that contain orders', () => {
  assert.match(js, /hourLabel\(h\)/);
  assert.match(js, /map\[h\]=\(map\[h\]\|\|0\)\+1/);
  assert.match(js, /Object\.keys\(map\).*sort/);
  assert.doesNotMatch(js, /08–10|10–12|12–14|14–16|16–18|18–20/);
  assert.match(js, /\.mee-chart-grid\{display:none!important\}/);
});

test('admin drawer exposes guarded delete flow through the dedicated endpoint', () => {
  assert.match(js, /meehoasg-delete-order/);
  assert.match(js, /S\.user\.role!==['"]ADMIN['"]/);
  assert.match(js, /className=['"]btn danger full mee-delete-order['"]/);
  assert.match(js, /window\.confirm/);
});
