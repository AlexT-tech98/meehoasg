const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('html','utf8');
function source(name,next){const start=html.indexOf('function '+name+'('),end=html.indexOf('function '+next+'(',start);assert.ok(start>=0&&end>start,name+' canonical owner exists');return html.slice(start,end);}
const helpers=source('isoInRange','clientOrderSort')+source('clientOrderSort','matchesSearch')+source('listUpsert','dashboardAttentionKind')+source('patchProductionOrder','debtMatches');
const apply=html.slice(html.indexOf('function applyCanonicalOrder('),html.indexOf('async function refreshOrderEntity('));
function harness(production,date='2033-01-01'){
 const S={data:{production},filters:{production:{date,start:date,end:'2033-01-02'}},orders:new Map((production?.orders||[]).map(o=>[o.id,o])),dirty:new Set(),viewAt:{}};
 const c={S,Date,rememberOrders:items=>items.forEach(o=>S.orders.set(o.id,o)),orderById:id=>S.orders.get(id),patchOrdersOrder(){},patchDebtOrder(){},renderPatchedPage(){}};
 const update=vm.runInNewContext(helpers+apply+';applyCanonicalOrder',c);return {S,update};
}
const row=(id,date,status='Chờ bó')=>({id,date,time:'10:00',status,shipping:'Ghé lấy',flowerTotal:500000,debt:500000});
test('status changes on day two retain the card and all selected-day orders',()=>{
 const x=harness({rangeStart:'2033-01-01',rangeEnd:'2033-01-02',orders:[row('DAY-1','2033-01-01'),row('DAY-2','2033-01-02')]});
 for(const status of ['Đã bó','Chờ lấy','Đã giao','Chờ lấy','Đã bó','Chờ bó']){
  x.update(row('DAY-2','2033-01-02',status));
  assert.deepEqual(Array.from(x.S.data.production.orders,o=>o.id),['DAY-1','DAY-2']);
  assert.equal(x.S.data.production.orders[1].status,status);
 }
 assert.equal(x.S.dirty.has('getDashboardSummary'),true);
});
test('date edits move an order within the range, out of it, and back without duplicates',()=>{
 const x=harness({rangeStart:'2033-01-01',rangeEnd:'2033-01-02',orders:[row('MOVING','2033-01-01'),row('KEEP','2033-01-02')]});
 x.update(row('MOVING','2033-01-02','Đã bó'));assert.equal(x.S.data.production.orders.length,2);
 assert.equal(x.S.data.production.orders.find(o=>o.id==='MOVING').date,'2033-01-02');
 x.update(row('MOVING','2033-01-03','Đã bó'));assert.deepEqual(Array.from(x.S.data.production.orders,o=>o.id),['KEEP']);
 x.update(row('MOVING','2032-12-31','Đã bó'));assert.deepEqual(Array.from(x.S.data.production.orders,o=>o.id),['KEEP']);
 x.update(row('MOVING','2033-01-01','Đã bó'));x.update(row('MOVING','2033-01-01','Chờ lấy'));
 assert.deepEqual(Array.from(x.S.data.production.orders,o=>o.id),['MOVING','KEEP']);
 assert.equal(x.S.data.production.orders[0].status,'Chờ lấy');
});
test('single-day snapshots keep the selected date and exclude stale multi-day filter bounds',()=>{
 const x=harness({date:'2033-01-01',orders:[row('TODAY','2033-01-01')]});
 x.update(row('TODAY','2033-01-01','Đã bó'));assert.equal(x.S.data.production.orders[0].status,'Đã bó');
 x.update(row('OTHER','2033-01-02'));assert.equal(x.S.data.production.orders.length,1);
 x.update(row('TODAY','2033-01-02','Đã bó'));assert.equal(x.S.data.production.orders.length,0);
 x.update(row('TODAY','2033-01-01','Đã bó'));assert.equal(x.S.data.production.orders.length,1);
});
test('a partial range falls back to its first day and absent production data is unchanged',()=>{
 const x=harness({rangeStart:'2033-01-02',orders:[]});
 x.update(row('DAY-1','2033-01-01'));x.update(row('DAY-2','2033-01-02'));assert.deepEqual(Array.from(x.S.data.production.orders,o=>o.id),['DAY-2']);
 const missing=harness(undefined);missing.update(row('NO-VIEW','2033-01-01'));assert.equal(missing.S.data.production,undefined);
});
