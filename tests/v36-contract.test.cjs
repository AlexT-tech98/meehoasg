const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const api = fs.readFileSync('supabase/functions/meehoasg-api-v36/index.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const ui = fs.readFileSync('assets/meehoa-v35.js', 'utf8');
const mark = fs.readFileSync('assets/meehoa-mark.svg', 'utf8');

test('v36 routes browser traffic through the new API proxy', () => {
  assert.match(index, /meehoasg-api-v36/);
  assert.match(index, /meehoa-v35\.js\?v=4\.6/);
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
  assert.match(api, /Ly hồng/);
  assert.match(api, /Hồng Ecuador/);
  assert.match(api, /Chiết xạ/);
  assert.match(api, /needs_review/);
  assert.match(api, /classifierVersion: 'v36-specific'/);
});

test('UI contains material drawers, settlement copy, grid and single-scroll fixes', () => {
  assert.match(ui, /Đã thu đủ tiền hoa/);
  assert.match(ui, /Doanh thu theo nhân viên \/ ngày/);
  assert.match(ui, /Nguyên liệu AI theo đơn/);
  assert.match(ui, /openMaterialDrawer/);
  assert.match(ui, /\.topbar\{position:fixed!important/);
  assert.match(ui, /body\.mee-page-production \.ops-lines\{display:grid!important/);
});

test('Meehoa favicon mark is transparent and enlarged', () => {
  assert.doesNotMatch(mark, /<rect[^>]+fill=/);
  assert.match(mark, /scale\(3\.05\)/);
});