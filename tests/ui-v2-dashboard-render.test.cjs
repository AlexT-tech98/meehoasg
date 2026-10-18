const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootPath = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(rootPath, 'assets/meehoa-v361.js'), 'utf8');
const css = fs.readFileSync(path.join(rootPath, 'assets/meehoa-v361.css'), 'utf8');

function fixture() {
  const root = {innerHTML: ''};
  const events = {};
  const content = {querySelector: id => id === '#meeDashboardV2' ? root : null};
  const summary = {orders: 4, revenue: 4800000, debt: 500000, cms: 400000,
    'Chờ bó': 1, 'Đã bó': 1, 'Đã giao': 2};
  const s = {
    page: 'dashboard',
    user: {username: 'pu'},
    filters: {dashboard: {start: '2026-10-18', end: '2026-10-18'}},
    data: {dashboard: {summary,
      attentionGroups: {nearUnpacked: [{id: 'ORD1', customer: 'Mai', time: '09:30', date: '2026-10-18', flower: 'Hoa hồng'}], packedOverdue: []},
      salesDaily: [{sale: 'Pu', saleUsername: 'pu', orders: 4, settledOrders: 3, unsettledOrders: 1,
        grossRevenue: 4800000, settledRevenue: 3000000, unsettledRevenue: 1800000}],
      hourlyCounts: [{hour: 9, count: 2}, {hour: 11, count: 2}], hourlyUnknown: 0}}};
  const store = new Map();
  const win = {S:s, __MEE_TEST_MODE__:true};
  const sandbox = {S:s, window:win, document: {
    getElementById: id=>id==='content'?content:null,
    addEventListener: (type,cb)=>events[type]=cb
  }, localStorage:{
    getItem:key=>store.get(key)||null,
    setItem:(key,val)=>store.set(key,val)
  },Intl,Date,Map,Number,String,Math,Array,JSON};
  vm.runInNewContext(js,sandbox);
  return {win,s,root,events,store};
}

test('dashboard V2 uses a direct renderer with no observer-based UI rewrites', ()=>{
  assert.ok(!js.includes('MutationObserver'));
  assert.ok(css.includes('.mee-dv2-metrics'));
  assert.ok(!css.includes('!important'));
  const f=fixture();
  f.win.MEE_DASHBOARD_RENDER();
  assert.match(f.root.innerHTML,/Tổng quan|TÌNH HÌNH VẬN HÀNH/);
  assert.match(f.root.innerHTML,/Cần xử lý/);
  assert.match(f.root.innerHTML,/Tiến độ trong ngày/);
  assert.match(f.root.innerHTML,/Đơn theo khung giờ/);
  assert.match(f.root.innerHTML,/Doanh thu theo Sale/);
  assert.match(f.root.innerHTML,/ORD1/);
  assert.match(f.root.innerHTML,/4\.800\.000đ/);
  assert.match(f.root.innerHTML,/3\.000\.000đ/);
});

test('dashboard monetary masking stays per user and does not change financial data', ()=>{
  const f=fixture();
  f.win.MEE_DASHBOARD_RENDER();
  const el={dataset:{moneyKey:'revenue'},closest(){return this;}};
  f.events.click({target:el});
  assert.ok(f.root.innerHTML.includes('••••••'));
  assert.equal(f.s.data.dashboard.summary.revenue,4800000);
  assert.match(f.store.get('mee-dashboard-money:pu'),/"revenue":true/);
});

test('dashboard shows no invented orders when priority feed is empty', ()=>{
  const f=fixture();
  f.s.data.dashboard.attentionGroups={nearUnpacked:[],packedOverdue:[]};
  f.win.MEE_DASHBOARD_RENDER();
  assert.match(f.root.innerHTML,/Không có đơn cần xử lý gấp/);
  assert.doesNotMatch(f.root.innerHTML,/data-dashboard-order="ORD1"/);
});
