const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8').replace(/^import .*\n/gm,'');
function fixture(){const c={console,TextEncoder,URL,Date,Intl,createOperationService:()=>({}),createOperationStorage:()=>({}),Deno:{env:{get:()=>''},serve(){}}};vm.createContext(c);vm.runInContext(source,c);vm.runInContext("requireUser=async()=>({username:'qa',role:'ADMIN'});saleDirectory=async()=>({});settlementMap=async()=>({});all=async()=>fixtures;decorate=row=>row",c);return c;}
test('dashboard hours cover the same complete range as summary, including unclassified hours',async()=>{
 const c=fixture();c.fixtures=Array.from({length:265},(_,i)=>({id:'QA-'+i,date:i<200?'2025-01-01':'2025-01-02',time:i===0?'':i===1?'invalid':i===2?'24:00':i===3?'09:99':i%2?'23:45':'00:30',flowerTotal:100,paymentVerified:false,debt:100,sale:'QA',saleUsername:'qa',status:'Chờ bó'}));
 const r=await vm.runInContext("fastDashboard({start:'2025-01-01',end:'2025-01-02'})",c);
 assert.equal(r.summary.orders,265);assert.equal(r.hourlyScope,'SELECTED_RANGE');assert.equal(r.hourlyUnknown,4);
 assert.equal(r.hourlyCounts.reduce((n,x)=>n+x.count,0)+r.hourlyUnknown,r.summary.orders);
 assert.deepEqual(Array.from(r.hourlyCounts,x=>x.hour),[0,23]);assert.equal(r.hourlyCounts.reduce((n,x)=>n+x.count,0),261);
});
test('after an order time/date edit the authoritative Dashboard retains correct hourly unknown bucket',async()=>{
 const c=fixture();
 c.fixtures=[
  {id:'QA-A',date:'2025-01-01',time:'09:15',flowerTotal:100,paymentVerified:false,debt:100,sale:'QA',saleUsername:'qa',status:'Chờ bó'},
  {id:'QA-B',date:'2025-01-02',time:'invalid',flowerTotal:100,paymentVerified:false,debt:100,sale:'QA',saleUsername:'qa',status:'Chờ bó'}
 ];
 const initial=await vm.runInContext("fastDashboard({start:'2025-01-01',end:'2025-01-02'})",c);
 assert.equal(initial.summary.orders,2);assert.equal(initial.hourlyUnknown,1);
 assert.deepEqual(Array.from(initial.hourlyCounts,x=>x.hour),[9]);

 // An edit must invalidate the complete server-owned Dashboard, not change
 // only a local time bucket while retaining stale financial/Sale aggregates.
 const html=fs.readFileSync('html','utf8');
 assert.match(html,/S\\.dirty\\.add\\('getDashboardSummary'\\)/);
 assert.doesNotMatch(html,/function patchDashboardOrder\\(/);

 c.fixtures[0]={...c.fixtures[0],date:'2025-01-02',time:'23:30'};
 const moved=await vm.runInContext("fastDashboard({start:'2025-01-01',end:'2025-01-02'})",c);
 assert.equal(moved.summary.orders,2);assert.equal(moved.hourlyUnknown,1);
 assert.deepEqual(Array.from(moved.hourlyCounts,x=>x.hour),[23]);
 c.fixtures[1]={...c.fixtures[1],date:'2025-01-03',time:''};
 const outside=await vm.runInContext("fastDashboard({start:'2025-01-01',end:'2025-01-02'})",c);
 assert.equal(outside.summary.orders,1);assert.equal(outside.hourlyUnknown,0);
 assert.deepEqual(Array.from(outside.hourlyCounts,x=>x.hour),[23]);
});
