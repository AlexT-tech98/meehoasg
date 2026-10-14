const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '../supabase/functions/meehoasg-api-core/index.js'), 'utf8');
function between(start, end) {
  const i = code.indexOf(start);
  const j = code.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, 'API handler boundaries must remain present');
  return code.slice(i, j);
}

test('orders filter and paginate before requesting signed image URLs', () => {
  const fn = between('async function fastOrders(', 'async function fastDashboard(');
  assert.ok(fn.indexOf('const filtered=') < fn.indexOf('const pageRows='));
  assert.ok(fn.indexOf('const pageRows=') < fn.indexOf('await displayUrls('));
  assert.match(fn, /total:filtered\.length/);
  assert.match(fn, /hasMore:page\*pageSize<filtered\.length/);
  assert.match(fn, /imageUrls:await displayUrls\(/);
});

test('debt filters rows before requesting signed image URLs', () => {
  const fn = between('async function fastDebt(', 'async function fullPaidReport(');
  assert.ok(fn.indexOf('selected=decorated.filter(') < fn.indexOf('await displayUrls('));
  assert.match(fn, /summary:\{orders:items\.length,debt:items\.reduce/);
});

test('direct order detail retains its image signing path', () => {
  const fn = between('async function fastOrder(', 'async function fastDebt(');
  assert.match(fn, /displayUrls\(row\.image_urls\|\|\[\]\)/);
  assert.match(fn, /displayUrls\(row\.full_paid_bill_urls\|\|\[\]\)/);
});
