const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = p => fs.readFileSync(p, 'utf8');
const prodFix = read('assets/meehoa-prod-fix.css');
const v34Css = read('assets/meehoa-v34.css');
const v3Js = read('assets/meehoa-v3.js');
const v34Js = read('assets/meehoa-v34.js');
const v35Js = read('assets/meehoa-v35.js');
const entry = read('index.html');

test('mobile uses hamburger/sidebar and disables legacy bottom navigation', () => {
  assert.match(prodFix, /\.mobile-nav\s*\{display:none!important\}/);
  assert.match(prodFix, /\.sidebar\.mee-open/);
  assert.match(v3Js, /aria-expanded/);
  assert.match(v3Js, /mee-menu-backdrop/);
});

test('production mobile preview images remain bounded thumbnails', () => {
  assert.match(prodFix, /\.kanban \.order \.order-preview/);
  assert.match(prodFix, /width:88px!important/);
  assert.match(prodFix, /height:88px!important/);
  assert.match(prodFix, /object-fit:cover!important/);
});

test('drawer gallery does not use broad class substring selectors', () => {
  assert.doesNotMatch(v34Css, /\[class\*=["']thumb/);
  assert.doesNotMatch(v34Css, /\[class\*=["']gallery/);
  assert.match(v34Css, /\.drawer \.thumbs img/);
  assert.match(v34Css, /height:112px!important/);
});

test('order form enhancement preserves original field nodes and entered address', () => {
  assert.doesNotMatch(v34Js, /replaceInputWithTextarea/);
  assert.doesNotMatch(v34Js, /address\.value\s*=\s*['"]['"]/);
  assert.match(v34Js, /Keep original field nodes intact/);
});

test('V3.5 no longer observes the entire document body', () => {
  assert.doesNotMatch(v35Js, /observe\(document\.body/);
  assert.match(v35Js, /observe\(content/);
  assert.match(v35Js, /observe\(overlay/);
});

test('search visibility is determined by module id, not page title text', () => {
  assert.match(v3Js, /page==='orders'\|\|page==='production'/);
  const visibilityFn = v3Js.slice(v3Js.indexOf('function updateSearchVisibility'), v3Js.indexOf('function cleanKpiCopy'));
  assert.doesNotMatch(visibilityFn, /pageTitle/);
  assert.doesNotMatch(visibilityFn, /Đơn hàng\|Sản xuất/);
});

test('production entrypoint uses the current UI cache generation', () => {
  assert.match(entry, /prod-base=20261003-v365/);
  assert.match(entry, /meehoa-v34\.css\?v=4\.6/);
  assert.match(entry, /meehoa-v364\.css\?v=4\.6\.8/);
  assert.match(entry, /meehoa-v365\.css\?v=4\.6\.5/);
  assert.match(entry, /meehoa-v35\.js\?v=4\.6/);
  assert.match(entry, /meehoa-v365\.js\?v=4\.6\.5/);
  assert.match(entry, /meehoa-mark\.svg\?v=7/);
  assert.match(entry, /meehoasg-api-v365/);
  assert.match(entry, /meehoa-scroll-contract\.css\?v=1\.0\.0/);
});
