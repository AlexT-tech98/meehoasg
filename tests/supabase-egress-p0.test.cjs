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
  assert.match(fn, /const urls=await displayUrls\(/);
  assert.match(fn, /imageUrls:urls,driveUrls:urls/);
});

test('debt list does not sign images; detailed order endpoint still does', () => {
  const fn = between('async function fastDebt(', 'async function fullPaidReport(');
  assert.match(fn, /selected=decorated\.filter/);
  assert.match(fn, /const items=selected/);
  assert.doesNotMatch(fn, /displayUrls\(/);
  assert.match(fn, /summary:\{orders:items\.length,debt:items\.reduce/);
});

test('direct order detail retains its image signing path', () => {
  const fn = between('async function fastOrder(', 'async function fastDebt(');
  assert.match(fn, /displayUrls\(row\.image_urls\|\|\[\]\)/);
  assert.match(fn, /displayUrls\(row\.full_paid_bill_urls\|\|\[\]\)/);
});

test('signed URL cache is bounded, reuses in-flight requests and expires before token', () => {
  const fn = between('const signedImageCache=new Map();', 'const operationStorage=');
  assert.match(fn, /SIGNED_IMAGE_TTL_MS=45\*60\*1000/);
  assert.match(fn, /cached&&cached\.expiresAt>now/);
  assert.match(fn, /return cached\.promise/);
  assert.match(fn, /signedImageCache\.size>512/);
  assert.match(fn, /if\(!url\)signedImageCache\.delete\(key\)/);
  assert.match(fn, /catch\(e\)\{signedImageCache\.delete\(key\)/);
});

test('canonical HTML lazy loads order previews and mobile cards', () => {
  const html = fs.readFileSync(path.join(__dirname, '../html'), 'utf8');
  assert.match(html, /class="order-preview"[^>]*loading="lazy"/);
  assert.match(html, /class="search-item-thumb"[^>]*loading="lazy"/);
  assert.match(html, /class="order-card-mobile-thumb"[^>]*loading="lazy"/);
  assert.doesNotMatch(html, /class="order-preview"[^>]*loading="eager"/);
});

test('drawer defers picture display until detail load completes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../html'), 'utf8');
  assert.match(html, /var imgs = \(loadingDetail \? \[\] : \(o\.imageUrls \|\| \[\]\)\)/);
  assert.match(html, /ensureOrderDetail\(id\)\.then/);
});
