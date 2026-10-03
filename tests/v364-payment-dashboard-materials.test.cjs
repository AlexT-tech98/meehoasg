const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const entry=fs.readFileSync('index.html','utf8');
const api=fs.readFileSync('supabase/functions/meehoasg-api-v364/index.js','utf8');
const js=fs.readFileSync('assets/meehoa-v364.js','utf8');
const css=fs.readFileSync('assets/meehoa-v364.css','utf8');

test('production routes through v365 while force-loading v364 compatibility assets',()=>{
  assert.match(entry,/meehoasg-api-v365/);
  assert.match(entry,/meehoa-v364\.css\?v=4\.6\.8/);
  assert.match(entry,/meehoa-v364\.js\?v=4\.6\.7/);
  assert.match(entry,/meehoa-v365\.css\?v=4\.6\.5/);
  assert.match(entry,/meehoa-v365\.js\?v=4\.6\.5/);
});

test('dashboard API is direct and exposes split settlement revenue',()=>{
  assert.match(api,/name==='getDashboardSummary'/);
  assert.match(api,/result=await fastDashboard\(payload\)/);
  assert.match(api,/SPLIT_SETTLEMENT/);
  assert.match(api,/settledRevenue/);
  assert.match(api,/unsettledRevenue/);
});

test('SALE can read all orders while edit permission remains owner-only',()=>{
  assert.match(api,/name==='getOrders'/);
  assert.match(api,/result=await fastOrders\(payload\)/);
  assert.match(api,/SALE_READ_ALL_EDIT_OWN/);
  assert.match(api,/canEdit=!locked&&\(user\.role!=='SALE'\|\|owner\)/);
  assert.doesNotMatch(api,/rows=rows\.filter\(r=>keys\.has\(norm\(r\.sale\)\)\)/);
});

test('edit-order image removal is persisted without losing newly uploaded images',()=>{
  assert.match(api,/storageIdentity/);
  assert.match(api,/updateOrderWithImageRetention/);
  assert.match(api,/requestedIds=new Set\(payload\.order\.imageUrls\.map\(storageIdentity\)\)/);
  assert.match(api,/added=afterUrls\.filter/);
  assert.match(api,/imageRetentionApplied:true/);
});

test('materials has explicit local fallback when Gemini key is absent',()=>{
  assert.match(api,/!GEMINI_KEY/);
  assert.match(api,/FALLBACK_NO_KEY/);
  assert.match(api,/v364-local-fallback/);
  assert.match(api,/Hồng Ecuador/);
  assert.match(api,/Ly xanh nhuộm/);
});

test('payment patch targets actual payment route and bounded grid contract',()=>{
  assert.match(js,/S\.page!=='payment'/);
  assert.doesNotMatch(js,/S\.page!=='settlement'/);
  assert.match(js,/\.settlement-card/);
  assert.match(js,/\.settle-check/);
  assert.match(js,/Chọn tất cả/);
  assert.match(css,/mee-settlement-grid-v364/);
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css,/height:150px!important/);
});

test('payment select-all sets every live checkbox directly without change-event rerender loops',()=>{
  assert.match(js,/function paymentChecks\(grid\)/);
  assert.match(js,/paymentChecks\(grid\)\.forEach\(function\(x\)\{x\.checked=want\}\)/);
  assert.doesNotMatch(js,/x\.dispatchEvent\(new Event\('change'/);
  assert.match(js,/duyệt các mục đã chọn/);
});

test('all overlays have viewport close controls and Escape support',()=>{
  assert.match(js,/mee-overlay-global-close-v364/);
  assert.match(js,/closeActiveOverlay/);
  assert.match(js,/e\.key==='Escape'/);
  assert.match(js,/target\.matches\('\.modal-bg,\.drawer-bg'\)/);
  assert.match(css,/position:fixed!important;top:max\(14px/);
  assert.match(css,/\.modal-head,#overlay \.drawer-head/);
  assert.match(css,/position:sticky!important/);
});

test('create/edit order has removable image previews for old, new and pasted images',()=>{
  assert.match(js,/mee-order-image-manager-v364/);
  assert.match(js,/data-remove-existing/);
  assert.match(js,/data-remove-new/);
  assert.match(js,/data-remove-pasted/);
  assert.match(js,/DataTransfer/);
  assert.match(js,/window\._editExistingUrls/);
  assert.match(js,/window\._pasted/);
  assert.match(css,/mee-order-image-grid-v364/);
});

function executePaymentPatch(page){
  const gridClasses=new Set();
  const bodyClasses=new Set();
  const classList={
    add:x=>bodyClasses.add(x),
    remove:x=>bodyClasses.delete(x),
    toggle:(x,on)=>on?bodyClasses.add(x):bodyClasses.delete(x)
  };
  const grid={
    classList:{add:x=>gridClasses.add(x)},
    querySelector:()=>null,
    querySelectorAll:(selector)=>selector==='.settlement-card'?[{}]:[],
    parentNode:{insertBefore:()=>{}}
  };
  const root={querySelector:(selector)=>selector==='.order-grid'?grid:null,querySelectorAll:()=>[],dataset:{},addEventListener:()=>{}};
  const overlay={firstElementChild:null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener:()=>{},appendChild:()=>{}};
  const document={
    readyState:'complete',body:{classList},
    querySelector:(selector)=>selector==='#content'?root:selector==='#overlay'?overlay:null,
    querySelectorAll:()=>[],createTreeWalker:()=>({nextNode:()=>null}),
    createElement:()=>({className:'',dataset:{},setAttribute:()=>{},addEventListener:()=>{},appendChild:()=>{}}),
    addEventListener:()=>{}
  };
  const context={window:{S:{page}},S:{page},document,NodeFilter:{SHOW_TEXT:4},MutationObserver:class{observe(){}},setTimeout,clearTimeout,Event:class{},URL:{createObjectURL:()=>''},console};
  vm.runInNewContext(js,context);
  return {gridClasses,bodyClasses};
}

test('payment runtime patch activates only on S.page=payment',()=>{
  const live=executePaymentPatch('payment');
  assert.equal(live.gridClasses.has('mee-settlement-grid-v364'),true);
  assert.equal(live.bodyClasses.has('mee-page-settlement-v364'),true);
  const wrong=executePaymentPatch('settlement');
  assert.equal(wrong.gridClasses.has('mee-settlement-grid-v364'),false);
});

test('paid production card copy is Bankful full hoa',()=>{assert.match(js,/Bankful full hoa/)});
