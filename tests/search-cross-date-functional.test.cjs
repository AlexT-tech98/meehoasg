const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function makeFastOrders(){
 const file=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');
 const start=file.indexOf('async function fastOrders('),end=file.indexOf('async function fastDashboard(',start);
 assert.ok(start>=0&&end>start);
 const history=[
  {id:'A',order_date:'2026-10-10',phone:'0901112222',customer:'Khách cũ',flower:'Hoa hồng',sale:'Sale 1',image_urls:[]},
  {id:'B',order_date:'2026-10-11',phone:'0987654321',customer:'Khách 11/10',flower:'Tulip',sale:'Sale 2',image_urls:[]}
 ];
 const activity={filters:[],signed:[],settled:[]};
 const ctx={
  requireUser:async()=>({role:'ADMIN'}),
  saleDirectory:async()=>({}),
  clean:v=>String(v||'').trim(),
  dateToday:()=> '2026-10-10',
  norm:v=>String(v||'').toLowerCase().trim(),
  num:v=>Number(v||0),
  all:async(_table,filter)=>{
   activity.filters.push(filter);
   return filter.and?history.filter(o=>o.order_date==='2026-10-10'):history;
  },
  settlementMap:async ids=>{activity.settled.push(...ids);return {}},
  displayUrls:async arr=>{activity.signed.push(...arr);return arr},
  decorate:async o=>o
 };
 vm.createContext(ctx);
 vm.runInContext(file.slice(start,end)+'\nthis.getOrders=fastOrders;',ctx);
 return {query:ctx.getOrders,activity};
}
test('phone search finds a later-date order without changing the date filter',async()=>{
 const {query,activity}=makeFastOrders();
 const found=await query({start:'2026-10-10',end:'2026-10-10',q:'0987 654 321',page:1,pageSize:20});
 assert.equal(found.total,1);
 assert.equal(found.items[0].id,'B');
 assert.equal(found.searchScope,'ALL_DATES');
 assert.equal(activity.filters[0].and,undefined);
 assert.deepEqual(activity.settled,['B']);
});
test('clearing search restores the selected date and excludes other dates',async()=>{
 const {query,activity}=makeFastOrders();
 const result=await query({start:'2026-10-10',end:'2026-10-10',q:'',page:1,pageSize:20});
 assert.equal(result.searchScope,'SELECTED_DATE');
 assert.equal(result.total,1);
 assert.equal(result.items[0].id,'A');
 assert.ok(activity.filters[0].and.includes('order_date.gte.2026-10-10'));
});
