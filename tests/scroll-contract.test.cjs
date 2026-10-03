const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'assets', 'meehoa-scroll-contract.css'), 'utf8');
const coreCss = fs.readFileSync(path.join(root, 'assets', 'meehoa-core.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const base = fs.readFileSync(path.join(root, 'html'), 'utf8');

test('production bundles the scroll contract after v364 compatibility CSS', () => {
  assert.match(index, /meehoa-core\.css\?v=20261004-1/);
  const oldPos = coreCss.indexOf('===== meehoa-v364.css =====');
  const scrollPos = coreCss.indexOf('===== meehoa-scroll-contract.css =====');
  assert.ok(oldPos >= 0, 'v364 CSS block missing from core');
  assert.ok(scrollPos > oldPos, 'scroll contract block must remain after v364 in core');
});

test('normal pages have one vertical scroll owner', () => {
  assert.match(css, /html\{[\s\S]*overflow-y:auto!important/);
  assert.match(css, /body:not\(\.mee-overlay-open-v364\):not\(\.mee-menu-open\)[\s\S]*overflow-y:visible!important/);
  assert.match(css, /\.app,[\s\S]*\.main,[\s\S]*#content[\s\S]*overflow-y:visible!important/);
});

test('tables do not create a second vertical scrollbar', () => {
  assert.match(base, /\.table-wrap\s*\{[\s\S]*overflow:\s*auto;/, 'base table wrapper should be the legacy nested-scroll source');
  assert.match(css, /\.table-wrap\{[\s\S]*overflow-x:auto!important;[\s\S]*overflow-y:visible!important/);
});

test('intentional local surfaces keep local scrolling and page locks still work', () => {
  assert.match(css, /\.sidebar \.nav,[\s\S]*\.search-dropdown,[\s\S]*#overlay \.modal,[\s\S]*#overlay \.drawer,[\s\S]*\.calendar-modal[\s\S]*overscroll-behavior:contain!important/);
  assert.match(css, /body\.mee-overlay-open-v364,[\s\S]*body\.mee-menu-open[\s\S]*overflow:hidden!important/);
});

test('high-cost scrolling blur is disabled on sticky topbar and production cards', () => {
  assert.match(css, /\.topbar\{[\s\S]*backdrop-filter:none!important/);
  assert.match(css, /body\.mee-page-production \.lane,[\s\S]*body\.mee-page-production \.order,[\s\S]*body\.mee-page-production \.ops-tile[\s\S]*backdrop-filter:none!important/);
});
