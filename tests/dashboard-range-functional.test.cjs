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
test('incremental dashboard edit moves a bucket without losing unknown-hour orders',()=>{
 const html=fs.readFileSync('html','utf8'),start=html.indexOf('function patchDashboardOrder('),end=html.indexOf('function patchOrdersOrder(',start);
 const c={S:{data:{dashboard:{summary:{orders:2},hourlyScope:'SELECTED_RANGE',hourlyCounts:[{hour:9,count:1}],hourlyUnknown:1}},filters:{dashboard:{start:'2025-01-01',end:'2025-01-02'}}},isoInRange:(d,a,b)=>d>=a&&d<=b,dashboardApplyStats:(s,o,n)=>s.orders+=n};vm.createContext(c);vm.runInContext(html.slice(start,end),c);
 vm.runInContext("patchDashboardOrder({date:'2025-01-02',time:'23:30'},{date:'2025-01-01',time:'09:15'})",c);
 let r=c.S.data.dashboard;assert.deepEqual(Array.from(r.hourlyCounts,x=>({hour:x.hour,count:x.count})),[{hour:23,count:1}]);assert.equal(r.hourlyUnknown,1);assert.equal(r.summary.orders,2);
 vm.runInContext("patchDashboardOrder({date:'2025-01-03',time:''},{date:'2025-01-01',time:''})",c);assert.equal(r.hourlyUnknown,0);assert.equal(r.summary.orders,1);
});
