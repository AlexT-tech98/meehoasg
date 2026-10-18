const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const read = p => fs.readFileSync(p, 'utf8');
const canonicalCss = read('assets/meehoa-v365.css');
const v34Css = read('assets/meehoa-v34.css');
const v3Js = read('assets/meehoa-v3.js');
const v34Js = read('assets/meehoa-v34.js');
const v35Js = read('assets/meehoa-v35.js');
const entry = read('index.html');

test('mobile keeps one native bottom navigation and accessible sidebar menu', () => {
  assert.match(canonicalCss,/\.mobile-nav\{display:grid\}/);
  assert.match(read('assets/meehoa-v3.css'),/\.mobile-nav \.mee-mobile-create/);
  assert.doesNotMatch(v3Js,/retireLegacyMobileNav/);
  assert.match(v3Js,/mee-menu-backdrop/);
  assert.match(read('html'),/mee-mobile-create/);
});

test('production mobile preview images remain bounded thumbnails', () => {
  assert.match(canonicalCss, /\.kanban \.order \.order-preview/);
  assert.match(canonicalCss, /width:88px!important/);
  assert.match(canonicalCss, /height:88px!important/);
  assert.match(canonicalCss, /object-fit:cover!important/);
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

test('production/materials module renders directly without DOM observers or dashboard patches', () => {
  assert.doesNotMatch(v35Js, /observe\(document\.body/);
  assert.doesNotMatch(v35Js, /MutationObserver|observe\(content|observe\(overlay/);
  assert.match(v35Js, /MEE_MATERIALS_RENDER=renderMaterials/);
  assert.match(read('html'), /MEE_MATERIALS_RENDER\(\)/);
  assert.doesNotMatch(v35Js, /function patchDashboard/);
  assert.doesNotMatch(v35Js, /injectV36Styles/);
});

test('global search is shown only on Orders until production search has a real implementation', () => {
  assert.match(v3Js, /var show=page==='orders'/);
  assert.doesNotMatch(v3Js, /page==='orders'\|\|page==='production'/);
  const visibilityFn = v3Js.slice(v3Js.indexOf('function updateSearchVisibility'), v3Js.indexOf('function shippingIcon'));
  assert.doesNotMatch(visibilityFn, /pageTitle/);
});

test('production entrypoint loads consolidated core only', () => {
  assert.match(entry, /var RELEASE='\d{8}[-\w]*'/);
  assert.ok(entry.includes("var SHELL_URL='/html?prod-base='+RELEASE;"));
  assert.match(entry, /meehoa-core\.css\?v=[A-Za-z0-9._-]+/);
  assert.match(entry, /meehoa-core\.js\?v=[A-Za-z0-9._-]+/);
  assert.match(entry, /meehoa-mark\.svg\?v=7/);
  assert.match(entry, /meehoasg-api-core/);
  assert.match(entry, /var SHELL_KEY='meehoa-shell-core-'\+RELEASE/);
  assert.doesNotMatch(entry, /meehoa-(?:v\d+|.*hotfix|.*fix)\.(?:css|js)\?v=/);
});
