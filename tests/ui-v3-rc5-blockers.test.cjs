'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('RC5-01: Breakpoints and Create CTA are synchronized at 900px without legacy sheet-table/grid !important overrides', () => {
  const v3Css = read('assets/meehoa-v3.css');
  const uiV3Css = read('assets/meehoa-ui-v3.css');

  assert.match(v3Css, /\.sheet-table-desktop:not\(\.mee3-table-wrap\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(v3Css, /\.orders-mobile-list:not\(\.mee3-grid\)\s*\{\s*display:\s*block;\s*\}/);
  assert.doesNotMatch(v3Css, /\.sheet-table-desktop\s*\{\s*display:\s*none\s*!important/);

  assert.match(uiV3Css, /@media\s*\(max-width:\s*900px\)[\s\S]*\.mee3-topbar-create\s*\{\s*display:\s*none;\s*\}/);
  assert.match(uiV3Css, /@media\s*\(max-width:\s*900px\)[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(uiV3Css, /@media\s*\(max-width:\s*900px\)[\s\S]*\.mee3-orders\.mee3-view-table\s+\.mee3-table-wrap\s*\{\s*display:\s*block;\s*\}/);
  assert.equal((uiV3Css.match(/!important\b/g) || []).length, 0, 'Zero !important in meehoa-ui-v3.css');
});

test('RC5-02: Desktop Table View removes sheet-table 1180px conflict and only clamps text inside tableSample', () => {
  const html = read('html');
  const v3Css = read('assets/meehoa-v3.css');
  const uiV3Css = read('assets/meehoa-ui-v3.css');

  assert.match(v3Css, /\.sheet-table:not\(\.mee3-table\)\s*\{\s*min-width:\s*1180px;\s*\}/);
  assert.doesNotMatch(html, /class="mee3-table control-table sheet-table"/, 'RC5 orders table must not carry legacy sheet-table min-width class');
  assert.doesNotMatch(html, /class="note-cell"><div class="mee3-clamp-2">\s*'\s*\+\s*tableSample\(o\)/, 'tableSample image wrapper must not be clamped');
  assert.match(html, /class="multiline mee3-clamp-2"[^>]*>\s*'\s*\+\s*multiline\(o\.flower\)/);
  assert.match(html, /class="mee3-col-num mee3-col-pay"/);
  assert.match(uiV3Css, /\.mee3-table\s*\{[\s\S]*min-width:\s*900px;/);
  assert.match(uiV3Css, /\.mee3-table td\.mee3-col-pay\s*\{[\s\S]*white-space:\s*normal;/);
});

test('RC5-03: Error toast styles match actual runtime .toast.err class with #991B1B', () => {
  const html = read('html');
  const uiV3Css = read('assets/meehoa-ui-v3.css');

  assert.match(html, /t\.className\s*=\s*'toast'\s*\+\s*\(bad\s*\?\s*' err'\s*:\s*''\)/);
  assert.match(uiV3Css, /body\s+#toast\.toast\.err[\s\S]*background:\s*#991B1B;/);
});

test('RC5-04: Mobile Search input enforces >=16px across all legacy & V3 CSS rules', () => {
  const v3Css = read('assets/meehoa-v3.css');
  const v365Css = read('assets/meehoa-v365.css');
  const uiV3Css = read('assets/meehoa-ui-v3.css');

  assert.doesNotMatch(v3Css, /\.topbar-search input\s*\{\s*font-size:\s*13px/i);
  assert.doesNotMatch(v365Css, /\.topbar-search input\s*\{\s*font-size:\s*13px/i);
  assert.doesNotMatch(uiV3Css, /#globalSearchInput\s*\{[^}]*font-size:\s*(?:13|14)px/i);
  assert.match(uiV3Css, /@media\s*\(max-width:\s*900px\)[\s\S]*#globalSearchInput\s*\{[^}]*font-size:\s*16px;/);
  assert.match(uiV3Css, /@media\s*\(max-width:\s*760px\)[\s\S]*#globalSearchInput\s*\{[^}]*font-size:\s*16px;/);
});
