const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'assets', 'meehoa-v365.css'), 'utf8');
const coreCss = fs.readFileSync(path.join(root, 'assets', 'meehoa-core.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const base = fs.readFileSync(path.join(root, 'html'), 'utf8');

test('scroll contract is owned by the final canonical stylesheet', () => {
  assert.match(index, /meehoa-core\.css\?v=[A-Za-z0-9._-]+/);
  assert.match(coreCss, /===== meehoa-v365\.css =====/);
  assert.doesNotMatch(coreCss, /meehoa-scroll-contract\.css/);
});

test('normal pages have one vertical scroll owner', () => {
  assert.match(css, /html\{[\s\S]*overflow-y:auto!important/);
  assert.match(css, /body:not\(\.mee-overlay-open-v364\):not\(\.mee-menu-open\)[\s\S]*overflow-y:visible!important/);
  assert.match(css, /body:not\(\.mee-overlay-open-v364\) \.app,[\s\S]*body:not\(\.mee-overlay-open-v364\) \.main,[\s\S]*body:not\(\.mee-overlay-open-v364\) #content[\s\S]*overflow-y:visible!important/);
});

test('tables do not create a second vertical scrollbar', () => {
  assert.match(base, /\.table-wrap\s*\{[\s\S]*overflow:\s*auto;/, 'base table wrapper should be the legacy nested-scroll source');
  assert.match(css, /\.table-wrap,\.mee-v361-table-wrap\{[\s\S]*overflow-x:auto!important;[\s\S]*overflow-y:visible!important/);
});

test('intentional local surfaces keep local scrolling and page locks still work', () => {
  assert.match(css, /\.sidebar \.nav,\.search-dropdown,#overlay \.modal,#overlay \.drawer,\.calendar-modal\{overscroll-behavior:contain!important\}/);
  assert.match(css, /body\.mee-overlay-open-v364,body\.mee-menu-open\{overflow:hidden!important/);
});

test('high-cost scrolling blur is disabled on topbar and production cards', () => {
  assert.match(css, /\.topbar\{backdrop-filter:none!important/);
  assert.match(css, /body\.mee-page-production \.lane,body\.mee-page-production \.order,body\.mee-page-production \.ops-tile\{backdrop-filter:none!important/);
});
