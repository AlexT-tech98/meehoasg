const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
const html=read('html'),ops=read('supabase/functions/meehoasg-api-core/index.js');
const productionCss=read('assets/meehoa-v35.css'),kpiCss=read('assets/meehoa-v365.css'),drawerCss=read('assets/meehoa-v34.css');

test('approved five-stage production UX is owned by canonical source',()=>{
 for(const value of ['Chờ bó','Đã bó','Chờ giao','Chờ lấy','Đã giao'])assert.ok(html.includes(value),value);
 assert.match(html,/function readinessStatus\(o\)/);
 assert.match(html,/shipping==='Ghé lấy'\?'Chờ lấy':'Chờ giao'/);
 assert.match(html,/function nextStatusValue\(o\)/);
 assert.match(html,/function previousStatusValue\(o\)/);
 assert.match(html,/mee-production-v2/);
 assert.match(html,/MEEOPS7\.bulkStatus/);
 assert.match(productionCss,/\.mee-production-v2/);
});
test('production states are represented in API without changing payment/settlement eligibility',()=>{
 assert.match(ops,/Chờ giao/);
 assert.match(ops,/Chờ lấy/);
 assert.match(ops,/canSubmitSettlement:owner&&!locked&&!fullPaid&&row\.status==='Đã giao'/);
});
test('canonical KPI and order drawer remain functional modules',()=>{
 assert.match(html,/mee-kpi-v2/);
 assert.match(html,/kpiScoreForm\(m,r\)/);
 assert.match(html,/saveKpiScore/);
 assert.match(html,/mee-order-drawer-v2/);
 assert.match(html,/data-mee-order-action="edit"/);
 assert.match(kpiCss,/\.sales-kpi-card/);
 assert.match(drawerCss,/\.mee-order-drawer-head/);
});

test('ready-for-delivery and ready-for-pickup orders retain overdue priority',()=>{
 const lateStates=['Đã bó','Chờ giao','Chờ lấy'];
 const front=html.match(/function dashboardAttentionKind\(o\)[\s\S]*?return ''; \}/);
 assert.ok(front,'canonical dashboard priority classifier exists');
 for(const status of lateStates){
   assert.ok(front[0].includes(status),'frontend supports '+status);
   assert.match(ops,new RegExp(status));
 }
 assert.match(ops,/\['Đã bó','Chờ giao','Chờ lấy'\]\.includes\(o\.status\)&&due<now/);
});

test('production forward/back transitions respect pickup versus delivery',()=>{
 const begin=html.indexOf('function readinessStatus(o)');
 const end=html.indexOf('function paymentLabel(o)',begin);
 assert.ok(begin>=0&&end>begin,'canonical transitions found');
 const transitionSource=html.slice(begin,end);
 const transition=new Function(transitionSource+';return {nextStatusValue,previousStatusValue};')();
 const cases=[
  {shipping:'Ghé lấy',ready:'Chờ lấy'},
  {shipping:'Khách tự book',ready:'Chờ giao'},
  {shipping:'Shop book ship',ready:'Chờ giao'}
 ];
 for(const item of cases){
   const make=status=>({status,shipping:item.shipping});
   assert.equal(transition.nextStatusValue(make('Chờ bó')),'Đã bó');
   assert.equal(transition.nextStatusValue(make('Đã bó')),item.ready);
   assert.equal(transition.nextStatusValue(make(item.ready)),'Đã giao');
   assert.equal(transition.previousStatusValue(make('Đã giao')),item.ready);
   assert.equal(transition.previousStatusValue(make(item.ready)),'Đã bó');
   assert.equal(transition.previousStatusValue(make('Đã bó')),'Chờ bó');
   assert.equal(transition.nextStatusValue(make('Đã giao')),'');
 }
});
