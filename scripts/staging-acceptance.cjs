// Authenticated candidate APIs against disposable, real local PostgreSQL/Storage.
// No production endpoint or synthetic API responses are accepted.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'artifacts/staging'),out=path.join(root,'artifacts/staging-evidence');
const cfg=JSON.parse(fs.readFileSync(path.join(dir,'supabase.local.json'))),env=JSON.parse(fs.readFileSync(path.join(dir,'environment.json'))),{accounts}=JSON.parse(fs.readFileSync(path.join(dir,'credentials.local.json')));
if(cfg.API_URL!=='http://127.0.0.1:54321')throw Error('Local QA boundary required');
const endpoint='http://127.0.0.1:4173/functions/v1/meehoasg-api-core',sessions={},results=[];
const run='QA-E2E-'+crypto.randomUUID(),date='2030-01-01';
const png={name:'qa-pixel.png',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1kAAAAASUVORK5CYII='};
const base=()=>({customer:run,phone:'0000000000',date,time:'10:00',flower:'Tulip',note:'DỮ LIỆU GIẢ QA',flowerTotal:500000,shipping:'Ghé lấy',payment:'Chưa thanh toán',card:true,cardQty:2,cardText:'QA',banner:true,bannerQty:3,bannerText:'QA',shipFeeActive:'0'});
async function call(name,payload={},actor='qa_admin'){
 const res=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,payload:{...payload,...(sessions[actor]?{token:sessions[actor]}:{})}})});
 assert.equal(res.status,200,`HTTP ${res.status} from ${name}`);return res.json();
}
async function check(name,fn){try{const details=await fn();results.push({name,status:'PASS',...details});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',reason:e.message});console.error('FAIL '+name+': '+e.message);}}
async function main(){
 const db=new Client({host:'127.0.0.1',port:54322,user:'postgres',password:cfg.DB_PASSWORD,database:'postgres'});await db.connect();
 try{
  assert.equal((await db.query('select name from meehoa_qa.environment')).rows[0]?.name,'meehoa-pr39-local-synthetic');
  await check('active roles login; disabled login denied',async()=>{for(const a of accounts){const r=await call('loginAndBootstrap',{username:a.username,password:a.password},'');assert.equal(r.ok,a.active,a.username);if(a.active){assert.equal(r.user.role,a.role);sessions[a.username]=r.token;}}});
  await check('anonymous session and direct table access rejected; SALE cannot administer users',async()=>{const anon=await call('getOrders',{},'');assert.equal(anon.code,'AUTH_REQUIRED');const direct=await fetch(cfg.API_URL+'/rest/v1/orders?select=id&limit=1',{headers:{apikey:cfg.ANON_KEY,authorization:'Bearer '+cfg.ANON_KEY}});assert.ok([401,403].includes(direct.status),'anon must not read orders directly');const denied=await call('listUsers',{},'qa_sale');assert.equal(denied.ok,false);});
  await check('core protected readers enforce Dashboard ADMIN and Production operations roles',async()=>{
   for(const actor of ['qa_sale','qa_tho']){
    const r=await call('getDashboardSummary',{start:env.today,end:env.today},actor);
    assert.equal(r.ok,false,actor+' must not access the Admin Dashboard API');assert.equal(r.code,'AUTH_REQUIRED');
    for(const key of ['summary','salesDaily','attention','attentionGroups','hourlyCounts'])assert.equal(r[key],undefined,'denied Dashboard response must omit '+key);
   }
   const sale=await call('getProductionOrders',{date:env.today},'qa_sale');assert.equal(sale.ok,false);assert.equal(sale.code,'AUTH_REQUIRED');assert.equal(sale.orders,undefined);
   for(const actor of ['qa_admin','qa_tho']){const r=await call('getProductionOrders',{date:env.today},actor);assert.equal(r.ok,true,actor+' retains Production access');assert.ok(Array.isArray(r.orders));}
   const orders=await call('getOrders',{start:env.today,end:env.today},'qa_sale');assert.equal(orders.ok,true,'SALE retains Orders read-all access');
   return{dashboardDeniedRoles:['SALE','THO_OPS'],productionDeniedRoles:['SALE'],productionAllowedRoles:['ADMIN','THO_OPS'],saleOrdersRead:true};
  });
  await check('global search all dates, accent normalization, bounded disjoint pages',async()=>{
   const all=new Set();let total;
   for(let page=1;page<=12;page++){const r=await call('getOrders',{q:'qa khach tien',globalSearch:true,page,pageSize:20,start:env.today,end:env.today},'qa_sale');assert.equal(r.ok,true);assert.equal(r.searchScope,'ALL_DATES');assert.ok(r.items.length<=20);total=r.total;for(const o of r.items){assert.ok(!all.has(o.id),'duplicate page row');all.add(o.id);}if(!r.hasMore)break;}
   assert.equal(total,240);assert.equal(all.size,240);
   const scoped=await call('getOrders',{q:'qa khach tien',globalSearch:false,start:env.today,end:env.today,page:1,pageSize:200});assert.equal(scoped.total,40);
   return{total,dated:scoped.total};
  });
  await check('multi-day flowers distinct order and variety counts reconcile SQL',async()=>{
   const r=await call('getFlowerInventory',{start:'2025-01-01',end:env.today});assert.equal(r.ok,true);assert.equal(r.totalOrders,240);
   const expected={'Tulip':120,'Ly hồng':120,'Hồng Ecuador':120};for(const [name,n] of Object.entries(expected)){const item=r.items.find(x=>x.name===name);assert.equal(item?.orders,n,name);assert.equal(new Set(item.orderList.map(o=>o.id)).size,n,name);}
   const denied=await call('getFlowerInventory',{start:env.today,end:env.today},'qa_sale');assert.equal(denied.ok,false);return{orders:r.totalOrders,varieties:r.items.length};
  });
  await check('dashboard Sale order and revenue counts reconcile SQL',async()=>{
   const r=await call('getDashboardSummary',{start:env.today,end:env.today});assert.equal(r.ok,true);
   const rows=(await db.query('select sale,count(*)::int as n,sum(flower_total)::float8 as revenue from orders where order_date=$1 group by sale',[env.today])).rows;
   assert.equal(r.summary.orders,rows.reduce((n,x)=>n+x.n,0));assert.equal(r.salesDaily.reduce((n,x)=>n+x.orders,0),r.summary.orders);
   assert.equal(r.summary.grossRevenue,rows.reduce((n,x)=>n+x.revenue,0));assert.equal(r.hourlyScope,'SELECTED_RANGE');assert.equal(r.hourlyCounts.reduce((n,x)=>n+x.count,0)+r.hourlyUnknown,r.summary.orders);
   const multi=await call('getDashboardSummary',{start:'2025-01-01',end:env.today});assert.equal(multi.summary.orders,240);assert.equal(multi.hourlyCounts.reduce((n,x)=>n+x.count,0)+multi.hourlyUnknown,240);return{orders:r.summary.orders,grossRevenue:r.summary.grossRevenue};
  });
  await check('new date blank rejected without row write',async()=>{const before=(await db.query('select count(*) from orders')).rows[0].count;const r=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),date:''}},'qa_sale');assert.equal(r.ok,false);assert.equal(r.code,'ORDER_INPUT_INVALID');assert.equal((await db.query('select count(*) from orders')).rows[0].count,before);});
  let order,thoOrder,zeroOrder;
  await check('create 3-banner order through real API; idempotent retry one SQL receipt',async()=>{
   const p={requestId:crypto.randomUUID(),order:{...base(),imageFiles:[png]}};const r=await call('createOrder',p,'qa_sale');assert.equal(r.ok,true,JSON.stringify({code:r.code,message:r.message}));order=r.order;
   assert.equal(order.bannerQty,3);assert.equal(order.totalDue,625000);assert.equal(order.debt,625000);
   assert.match(order.imageUrls[0],/^http:\/\/127\.0\.0\.1:54321\/storage\/v1/);const image=await fetch(order.imageUrls[0]);assert.equal(image.status,200,'signed sample loads');
   const retry=await call('createOrder',p,'qa_sale');assert.equal(retry.orderId,r.orderId);assert.equal(retry.idempotent,true);
   assert.equal(Number((await db.query('select count(*) from operation_receipts where actor=$1 and request_id=$2',['qa_sale',p.requestId])).rows[0].count),1);return{total:order.totalDue};
  });
  await check('flower-only payment preserves accessory debt',async()=>{const r=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),payment:'Đã thanh toán đủ tiền hoa (Full)'}},'qa_sale');assert.equal(r.ok,true,r.message);assert.equal(r.order.paid,500000);assert.equal(r.order.debt,125000);assert.equal(r.order.fullPaid,false);return {orderId:r.orderId,customer:r.order.customer};});
  await check('cross-Sale edit denied; explicit production status action only',async()=>{
   assert.ok(order,'create prerequisite');const denied=await call('updateOrder',{requestId:crypto.randomUUID(),orderId:order.id,expectedUpdatedAt:order.updatedAt,order:{...base(),flower:'Changed'}},'qa_sale_other');assert.equal(denied.code,'NOT_OWNER');
   for(const [status,expected] of [['Đã bó','Chờ lấy'],['Đã giao','Đã giao']]){const r=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:order.id,expectedUpdatedAt:order.updatedAt,status},'qa_tho');assert.equal(r.ok,true,r.message);assert.equal(r.order.status,expected);order=r.order;}
  });
  await check('production V2 routing: pickup vs delivery, strict order and no skip',async()=>{
   const created=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),shipping:'Shop book ship',customer:run+' Delivery'}},'qa_sale');
   assert.equal(created.ok,true,created.message);let o=created.order;
   const premature=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,status:'Đã giao'},'qa_tho');
   assert.equal(premature.code,'STATUS_INVALID');
   for(const [stage,expected] of [['Đã bó','Chờ giao'],['Đã giao','Đã giao']]){
    const changed=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,status:stage},'qa_tho');
    assert.equal(changed.ok,true,changed.message);assert.equal(changed.order.status,expected);o=changed.order;
   }
   for(const [stage,expected] of [['Chờ giao','Chờ giao'],['Đã bó','Chờ bó']]){
    const changed=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,status:stage},'qa_tho');
    assert.equal(changed.ok,true,changed.message);assert.equal(changed.order.status,expected);o=changed.order;
   }
   assert.equal(o.status,'Chờ bó');
   const ready=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,status:'Đã bó'},'qa_tho');assert.equal(ready.ok,true);assert.equal(ready.order.status,'Chờ giao');
   const invalid=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:ready.order.updatedAt,status:'Chờ lấy'},'qa_tho');
   assert.equal(invalid.code,'STATUS_INVALID');
   return{shipping:'Shop book ship',requested:['Đã bó','Đã giao'],saved:['Chờ giao','Đã giao'],legacyRollback:[['Chờ giao','Chờ giao'],['Đã bó','Chờ bó']]};
  });
  await check('ready-for-pickup shipping edit requires explicit status rollback',async()=>{
   const created=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),customer:run+' Shipping Guard'}},'qa_sale');
   assert.equal(created.ok,true,created.message);let o=created.order;
   const packed=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,status:'Đã bó'},'qa_tho');
   assert.equal(packed.ok,true,packed.message);assert.equal(packed.order.status,'Chờ lấy');o=packed.order;
   const denied=await call('updateOrder',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,order:{...base(),customer:o.customer,shipping:'Shop book ship'}},'qa_sale');
   assert.equal(denied.code,'SHIPPING_STATUS_CONFLICT','must never silently turn pickup-ready into delivery-ready');
   const stored=(await db.query('select status,shipping from orders where id=$1',[o.id])).rows[0];
   assert.equal(stored.status,'Chờ lấy');assert.equal(stored.shipping,'Ghé lấy');
   const rollback=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,status:'Đã bó'},'qa_tho');
   assert.equal(rollback.ok,true,rollback.message);assert.equal(rollback.order.status,'Chờ bó');o=rollback.order;
   const edited=await call('updateOrder',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,order:{...base(),customer:o.customer,shipping:'Shop book ship'}},'qa_sale');
   assert.equal(edited.ok,true,edited.message);o=edited.order;
   const forwarded=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,status:'Đã bó'},'qa_tho');
   assert.equal(forwarded.ok,true,forwarded.message);assert.equal(forwarded.order.status,'Chờ giao');
   return{orderId:o.id,guard:'SHIPPING_STATUS_CONFLICT',finalStatus:forwarded.order.status};
  });
  await check('production V2 bulk update uses authenticated atomic per-order transactions',async()=>{
   const ids=[];
   for(let i=0;i<2;i++){const r=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),shipping:i===0?'Ghé lấy':'Khách tự book',customer:run+' Bulk '+i}},'qa_sale');assert.equal(r.ok,true);ids.push(r.order);}
   const r=await call('updateStatusBulk',{mutationRequestId:crypto.randomUUID(),status:'Đã bó',items:ids.map(o=>({orderId:o.id,expectedUpdatedAt:o.updatedAt}))},'qa_tho');
   assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.processed,2);
   const expected=new Map(ids.map(o=>[o.id,o.shipping==='Ghé lấy'?'Chờ lấy':'Chờ giao']));assert.equal(r.results.length,2);for(const saved of r.results){assert.equal(saved.ok,true);assert.equal(saved.status,expected.get(saved.orderId));}
   const rows=(await db.query('select id,status from orders where id=any($1)',[ids.map(o=>o.id)])).rows;
   assert.equal(rows.length,2);assert.ok(rows.every(o=>o.status===expected.get(o.id)));
   return {updated:r.processed};
  });
  await check('zero-balance unverified order remains in debt until settlement, Full Paid excluded',async()=>{
   const r=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),customer:run+' Zero Balance',payment:'Đã thanh toán 625000 đ'}},'qa_sale');assert.equal(r.ok,true,r.message);zeroOrder=r.order;for(const [status,expected] of [['Đã bó','Chờ lấy'],['Đã giao','Đã giao']]){const changed=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:zeroOrder.id,expectedUpdatedAt:zeroOrder.updatedAt,status},'qa_tho');assert.equal(changed.ok,true,changed.message);assert.equal(changed.order.status,expected);zeroOrder=changed.order;}
   assert.equal(zeroOrder.debt,0);assert.equal(zeroOrder.fullPaid,false);assert.equal(zeroOrder.settled,false);const d=await call('getDebtReview',{start:date,end:date},'qa_sale');const seen=d.items.find(o=>o.id===zeroOrder.id);assert.ok(seen,'zero-debt order must not disappear');assert.equal(seen.canSubmitSettlement,true);assert.ok(d.items.some(o=>o.status!=='Đã giao'),'not-delivered unsettled orders also visible');return{orderId:zeroOrder.id};
  });
  await check('owner debt scopes reconcile exact IDs; foreign Sale filter cannot widen scope',async()=>{
   async function ownDelivered(actor,sale){const created=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),...(sale?{sale}:{})}},actor);assert.equal(created.ok,true,created.message);let o=created.order;for(const [status,expected] of [['Đã bó','Chờ lấy'],['Đã giao','Đã giao']]){const r=await call('updateStatus',{requestId:crypto.randomUUID(),orderId:o.id,expectedUpdatedAt:o.updatedAt,status},'qa_tho');assert.equal(r.ok,true,r.message);assert.equal(r.order.status,expected);o=r.order;}return o;}
   thoOrder=await ownDelivered('qa_admin','QA Tiên');await ownDelivered('qa_sale_other');
   const counts={};for(const actor of ['qa_admin','qa_sale','qa_tho','qa_sale_other']){
    const expected=(await db.query("select o.id from orders o join app_users u on u.username=$2 where o.order_date=$1 and not o.settled and not o.full_paid and (u.role='ADMIN' or mee_ops_owner(o.sale,u))",[date,actor])).rows;
    const r=await call('getDebtReview',{start:date,end:date,...(actor==='qa_admin'?{}:{sale:'qa_admin'})},actor);assert.equal(r.ok,true);assert.equal(r.scope,actor==='qa_admin'?'ADMIN':'SELF');assert.deepEqual(r.items.map(o=>o.id).sort(),expected.map(o=>o.id).sort());for(const o of r.items)if(actor!=='qa_admin')assert.equal(o.saleUsername,actor);counts[actor]=r.items.length;
   }return{counts};
  });
  await check('only owner submits bill; cross-owner denied; ADMIN approves atomically',async()=>{
   assert.ok(thoOrder,'owner fixture prerequisite');const before=(await db.query('select count(*) from storage.objects')).rows[0].count;
   for(const actor of ['qa_tho','qa_sale_other','qa_admin']){const denied=await call('submitSettlement',{requestId:crypto.randomUUID(),orderId:order.id,expectedUpdatedAt:order.updatedAt,billFiles:[png]},actor);assert.equal(denied.code,'NOT_OWNER');}
   assert.equal((await db.query('select count(*) from storage.objects')).rows[0].count,before,'foreign requests must not upload proofs');
   const submitted=await call('submitSettlement',{requestId:crypto.randomUUID(),orderId:thoOrder.id,expectedUpdatedAt:thoOrder.updatedAt,billFiles:[png]},'qa_tho');assert.equal(submitted.ok,true,submitted.message);
   const denied=await call('reviewSettlement',{settlementId:submitted.requestId,mutationRequestId:crypto.randomUUID(),decision:'APPROVED'},'qa_tho');assert.equal(denied.code,'NOT_OWNER');
   const approved=await call('reviewSettlement',{settlementId:submitted.requestId,mutationRequestId:crypto.randomUUID(),decision:'APPROVED'},'qa_admin');assert.equal(approved.ok,true,approved.message);assert.equal(approved.order.settled,true);assert.equal(approved.order.debt,0);
   const row=(await db.query('select o.settled,s.status,s.bill_urls from orders o join settlement_requests s on s.order_id=o.id where o.id=$1',[thoOrder.id])).rows[0];assert.equal(row.status,'APPROVED');assert.equal(row.settled,true);assert.ok(row.bill_urls.length);
  });
  await check('Full Paid uploads proof, excludes debt, financial increase invalidates',async()=>{
   const r=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),fullPaidRequested:true,imageFiles:[png],fullPaidBillFiles:[png],payment:'Đã thanh toán toàn bộ đơn'}},'qa_sale');assert.equal(r.ok,true,r.message);assert.equal(r.order.fullPaid,true);assert.equal(r.order.debt,0);assert.equal(r.order.fullPaidTotal,625000);
   const d=await call('getDebtReview',{start:date,end:date});assert.ok(!d.items.some(o=>o.id===r.orderId));
   const edited=await call('updateOrder',{requestId:crypto.randomUUID(),orderId:r.orderId,expectedUpdatedAt:r.order.updatedAt,order:{...base(),bannerQty:4,payment:r.order.payment,fullPaidRequested:true,imageUrls:r.order.imageUrls}},'qa_sale');assert.equal(edited.ok,true,edited.message);assert.equal(edited.order.fullPaid,false);assert.equal(edited.order.paid,625000);assert.equal(edited.order.debt,35000);
   const preview=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),customer:run+' Full Preview',fullPaidRequested:true,imageFiles:[png],fullPaidBillFiles:[png],payment:'Đã thanh toán toàn bộ đơn'}},'qa_sale');assert.equal(preview.ok,true,preview.message);return {orderId:preview.orderId,customer:preview.order.customer};
  });
  await check('earliest delivery first in dated/global search with stable pagination',async()=>{
   const label=run+' Sort';for(const [time,d] of [['19:00',date],['07:30',date],['07:30',date],['06:00','2030-01-02']]){const r=await call('createOrder',{requestId:crypto.randomUUID(),order:{...base(),customer:label,time,date:d}},'qa_sale');assert.equal(r.ok,true,r.message);}
   const key=o=>[o.date,o.time,o.id].join('|');
   const global=await call('getOrders',{q:label,globalSearch:true,page:1,pageSize:20});assert.equal(global.total,4);assert.deepEqual(global.items.map(key),global.items.map(key).slice().sort());assert.equal(global.items[0].time,'07:30');assert.equal(global.items[3].date,'2030-01-02');
   const dated=await call('getOrders',{q:label,globalSearch:false,start:date,end:date,page:1,pageSize:20});assert.equal(dated.total,3);assert.deepEqual(dated.items.map(o=>o.time),['07:30','07:30','19:00']);
   const plain=await call('getOrders',{q:'',start:date,end:date,page:1,pageSize:200});assert.deepEqual(plain.items.map(key),plain.items.map(key).slice().sort());return{orders:4,first:'07:30',lastSameDay:'19:00'};
  });
 }finally{
  await db.end();fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'api-results.json'),JSON.stringify({scope:'real local PostgreSQL17/PostgREST/Supabase Storage/Deno candidate APIs; not managed cloud or production Egress',fixtureSearch:run,results},null,2)+'\n');
 }
 if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
