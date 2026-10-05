const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const api = fs.readFileSync('supabase/functions/meehoasg-api-v36/index.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const ui = fs.readFileSync('assets/meehoa-v35.js', 'utf8');
const css = fs.readFileSync('assets/meehoa-v35.css', 'utf8');
const mark = fs.readFileSync('assets/meehoa-mark.svg', 'utf8');

test('refactor routes browser traffic through consolidated API and frontend cores', () => {
  assert.match(index, /meehoasg-api-core/);
  assert.match(index, /meehoa-core\.js\?v=[A-Za-z0-9._-]+/);
  assert.match(index, /window\.S=S;window\.gas=gas/);
});

test('dashboard and KPI revenue are settlement-gated', () => {
  assert.match(api, /rows\.filter\(r => r\.settled === true\)/);
  assert.match(api, /revenueRule = 'SETTLED_ONLY'/);
  assert.match(api, /Chỉ tính doanh thu từ đơn đã tất toán/);
  assert.match(api, /salesDaily/);
});

test('material classifier preserves specific lily variants and review flow', () => {
  assert.match(api, /Ly xanh nhuộm/);
  assert.match(api, /Ly sơn xanh/);
  assert.match(api, /Ly tím pastel/);
  assert.match(api, /Ly xanh mint/);
  assert.match(api, /Hồng Ecuador/);
  assert.match(api, /Chiết xạ/);
  assert.match(api, /Không được gom các tên này thành Ly/);
  assert.match(api, /needs_review/);
  assert.match(api, /classifierVersion: 'v36-specific-2'/);
});

test('materials authorization fails closed before direct database analysis', () => {
  assert.match(api, /if \(!permission\.data\?\.ok\) result = permission\.data/);
});

test('production/materials owner keeps runtime behavior and static styling separated', () => {
  assert.match(ui, /Đã thu đủ tiền hoa/);
  assert.match(ui, /Nguyên liệu AI theo đơn/);
  assert.match(ui, /openMaterialDrawer/);
  assert.doesNotMatch(ui, /Doanh thu theo nhân viên \/ ngày/);
  assert.doesNotMatch(ui, /injectV36Styles/);
  assert.match(css, /body\.mee-page-production \.ops-lines\{display:grid!important/);
  assert.match(css, /\.mee-materials-grid/);
});

test('Meehoa favicon mark is transparent and enlarged', () => {
  assert.doesNotMatch(mark, /<rect[^>]+fill=/);
  assert.match(mark, /scale\(3\.05\)/);
});
