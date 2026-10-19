/* Actual packaged frontend fallback + actual isolated SQL RPC.
 * Browser transport and login are synthetic. Never reaches a live API or storage.
 * This proves five-state frontend/SQL compatibility, not production recovery.
 */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),pkg=path.join(root,'artifacts/release/package');
const currentOnly=process.argv.includes('--candidate-only');
const out=path.join(root,'artifacts/five-state-fallback'+(currentOnly?'-candidate':''));
const states=['Chờ bó','Đã bó','Chờ giao','Chờ lấy','Đã giao'],day='2026-10-18',nextDay='2026-10-19';
const users={ADMIN:{username:'admin',display_name:'QA Admin',role:'ADMIN'},SALE:{username:'sale1',display_name:'QA Sale',role:'SALE'},THO_OPS:{username:'tho',display_name:'QA Thợ',role:'THO_OPS'}};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
let db,api,seq=0,activeRoot=root;const servedResources=[];
const manifest=JSON.parse(fs.readFileSync(path.join(pkg,'package-manifest.json')));
for(const file of manifest.compatibleFallback.files)assert.equal(hash(fs.readFileSync(path.join(pkg,'compatible-fallback',file.path))),file.sha256,'packaged fallback hash '+file.path);
assert.equal(hash(fs.readFileSync(path.join(root,manifest.uiV2SchemaDelta.source))),manifest.uiV2SchemaDelta.sha256,'tested SQL matches packaged five-state migration');
if(manifest.packedReadinessSchemaDelta)assert.equal(hash(fs.readFileSync(path.join(root,manifest.packedReadinessSchemaDelta.source))),manifest.packedReadinessSchemaDelta.sha256,'tested packed-action SQL matches packaged correction');
async function rpc(action,input,actor='sale1'){
 const key='fallback-'+(++seq);
 return (await db.query('select mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as r',[actor,key,action,hash(key),JSON.stringify(input)])).rows[0].r;
}
async function row(id){return (await db.query('select to_jsonb(o) as r from orders o where id=$1',[id])).rows[0]?.r;}
async function seed(){
 await db.exec('truncate operation_receipts,settlement_requests,orders,activity_log restart identity cascade');
 for(const [id,status,shipping,full] of [['WAIT','Chờ bó','Ghé lấy'],['PACKED','Đã bó','Shop book ship'],['SHIP','Chờ giao','Shop book ship'],['PICKUP','Chờ lấy','Ghé lấy'],['DELIVERED','Đã giao','Ghé lấy'],['FULL','Chờ lấy','Ghé lấy',true]]){
  const order=api.normalizeOperationOrder({customer:'QA '+id,date:day,time:'10:00',flower:'Tulip',flowerTotal:500000,shipping,payment:'Chưa thanh toán',banner:true,bannerQty:3,bannerText:'QA',shipFeeActive:shipping==='Shop book ship'?'1':'0',shipFee:45000},users.SALE);
  if(full)order.image_urls=['supabase://order-images/qa-sample.jpg'];
  const r=await rpc('createOrder',{newOrderId:id,order,fullPaidRequested:!!full,newBillUrls:full?['supabase://settlement-bills/qa-proof.jpg']:[]});
  assert.equal(r.ok,true,JSON.stringify(r));
  await db.query('update orders set status=$1 where id=$2',[status,id]);
 }
}
async function decorated(r,u){
 const total=Number((await db.query('select mee_ops_total(o) as n from orders o where id=$1',[r.id])).rows[0].n),full=!!r.full_paid,verified=full||r.settled;
 const req=(await db.query('select * from settlement_requests where order_id=$1 limit 1',[r.id])).rows[0];
 const locked=!!r.settled||['PENDING','APPROVED'].includes(req?.status),owner=r.sale===u.username;
 return {id:r.id,updatedAt:r.updated_at,customer:r.customer,phone:r.phone,date:r.order_date,time:r.order_time,flower:r.flower,note:r.note,shipping:r.shipping,address:r.address,flowerTotal:Number(r.flower_total),payment:r.payment,paid:full?Number(r.full_paid_total):0,sale:'QA Sale',saleUsername:r.sale,status:r.status,imageUrls:r.image_urls,driveUrls:r.image_urls,card:r.card,cardQty:r.card_qty,banner:r.banner,bannerQty:r.banner_qty,bannerText:r.banner_text,accessoryTotal:105000,totalDue:total,debt:verified?0:total,vat:Number(r.vat),shipFee:Number(r.ship_fee),shipConfirmed:r.ship_confirmed,fullPaid:full,fullPaidTotal:Number(r.full_paid_total),fullPaidBillUrls:r.full_paid_bill_urls,settled:r.settled,paymentVerified:verified,locked,canEdit:!locked&&(u.role!=='SALE'||owner),canShip:!locked,canOperate:!locked&&u.role!=='SALE',canSubmitSettlement:owner&&!locked&&!full&&r.status==='Đã giao',detailLoaded:true,hasAccessories:true};
}
async function orders(u){return Promise.all((await db.query('select to_jsonb(o) as r from orders o order by id')).rows.map(({r})=>decorated(r,u)));}
async function finance(){return (await db.query("select count(*)::int as orders,sum(mee_ops_total(o))::text as total,sum(case when full_paid then full_paid_total else 0 end)::text as full_paid,sum(case when settled or full_paid then flower_total else 0 end)::text as kpi_revenue from orders o")).rows[0];}
async function respond(name,p,u){
 const all=await orders(u),productionDate=p.date||day,production={ok:true,date:productionDate,orders:all.filter(o=>o.date===productionDate)},listing={ok:true,items:all,total:all.length,page:1,pageSize:80,hasMore:false,range:{start:day,end:day}};
 if(name==='loginAndBootstrap'||name==='getCurrentUserAndBootstrap')return {ok:true,token:'a'.repeat(64),user:{username:u.username,name:u.display_name,role:u.role,active:true},options:{sales:['QA Sale'],shipping:['Ghé lấy','Shop book ship','Khách tự book'],statuses:states},initial:{page:'orders',data:listing,at:Date.now()}};
 if(name==='getOrders')return listing;
 if(name==='getProductionOrders')return production;
 if(name==='getOrder')return {ok:true,order:all.find(o=>o.id===p.orderId)};
 if(name==='getAppOptions')return {ok:true,sales:['QA Sale'],shipping:['Ghé lấy','Shop book ship','Khách tự book'],statuses:states};
 if(name==='recordPerformance')return {ok:true};
 if(name==='getDashboardSummary'){
  const f=await finance();return {ok:true,range:{start:day,end:day},summary:{orders:all.length,grossRevenue:all.reduce((n,o)=>n+o.flowerTotal,0),revenue:all.reduce((n,o)=>n+o.flowerTotal,0),settledRevenue:Number(f.kpi_revenue),unsettledRevenue:2500000,debt:all.reduce((n,o)=>n+o.debt,0),cms:Number(f.kpi_revenue)*.08,...Object.fromEntries(states.map(s=>[s,all.filter(o=>o.status===s).length]))},hourlyCounts:[{hour:10,count:all.length}],hourlyScope:'SELECTED_RANGE',salesDaily:[],attentionGroups:{nearUnpacked:[],packedOverdue:[]},attention:[]};
 }
 if(name==='updateStatus'){
  const r=await rpc(name,{orderId:p.orderId,expectedUpdatedAt:p.expectedUpdatedAt,status:p.status},u.username);return {...r,...(r.ok?{order:await decorated(r.row,u)}:{})};
 }
 if(name==='updateStatusBulk'){
  const results=[];for(const item of p.items){const r=await rpc('updateStatus',{orderId:item.orderId,expectedUpdatedAt:item.expectedUpdatedAt,status:p.status},u.username);results.push({orderId:item.orderId,ok:!!r.ok,status:r.row?.status||r.status||'',code:r.code,updatedAt:r.row?.updated_at});}
  return {ok:results.some(r=>r.ok),results,processed:results.filter(r=>r.ok).length,total:results.length};
 }
 return {ok:false,code:'QA_UNHANDLED',message:'Unhandled isolated route '+name};
}
const server=http.createServer((req,res)=>{try{let file=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(file==='/')file='/index.html';let full=path.resolve(activeRoot,'.'+file);if(!full.startsWith(activeRoot+path.sep))throw Error('unsafe');if(!fs.existsSync(full))full=path.resolve(pkg,'.'+file);const bytes=fs.readFileSync(full);servedResources.push({path:file.slice(1),sha256:hash(bytes),source:full});res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webmanifest')?'application/manifest+json':'text/html','cache-control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end();}});
async function main(){
 fs.mkdirSync(out,{recursive:true});db=new PGlite();api=await import('../supabase/functions/_shared/operations.js');
 await db.exec('create role anon;create role authenticated;create role service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);');
 await db.exec(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
 for(const f of fs.readdirSync(path.join(root,'supabase/migrations')).sort())await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',f),'utf8'));
 for(const u of Object.values(users))await db.query('insert into app_users(username,password_hash,display_name,role) values ($1,$2,$3,$4)',[u.username,'synthetic-only',u.display_name,u.role]);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const selected=process.env.MEEHOA_CHROMIUM;const browser=await chromium.launch({headless:true,...(selected&&selected!=='bundled'?{executablePath:selected}:{}),args:['--no-sandbox']});
 const results=[];
 try{for(const width of [1440,390])for(const role of ['ADMIN','SALE','THO_OPS']){
  await seed();const u=users[role],before=await finance();
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',timezoneId:'Asia/Ho_Chi_Minh'}),page=await context.newPage(),calls=[],errors=[];
  // Fixture dates must not depend on the wall clock when this drill runs later.
  await page.clock.setFixedTime(new Date(day+'T05:00:00Z'));
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin===origin)return route.continue();
   if(url.hostname.endsWith('.supabase.co')&&url.pathname.includes('/functions/v1/')){
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}});
    const {name,payload={}}=req.postDataJSON();calls.push({name,payload});
    const data=await respond(name,payload,u);return route.fulfill({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify({...data,build:'2026.09.28-supabase-v3'})});
   }return route.abort();
  });
  activeRoot=root;await page.goto(origin);await page.locator('#loginUser').fill(u.username);await page.locator('#loginPass').fill('fixture');await page.locator('#loginBtn').click();await page.waitForFunction(()=>window.S?.user&&S.data.orders?.items?.length===6);
  // Preserve authentication, but force the recovery HTML to be fetched rather
  // than executing a same-release shell left in localStorage by the candidate.
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('meehoa-shell-core-'))localStorage.removeItem(key);});
  activeRoot=currentOnly?root:path.join(pkg,'compatible-fallback');servedResources.length=0;
  await page.reload();await page.waitForFunction(()=>window.S?.user&&S.data.orders?.items?.length===6);
  await page.evaluate(()=>fetch('/manifest.webmanifest',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Recovery manifest request failed');return r.text();}));
  const actualFrontendHashes=manifest.compatibleFallback.files.map(file=>{
   const expectedPath=path.join(activeRoot,file.path),expectedHash=currentOnly?hash(fs.readFileSync(expectedPath)):file.sha256;
   assert.ok(servedResources.some(r=>r.path===file.path&&r.source===expectedPath&&r.sha256===expectedHash),'browser actually fetched exact recovery file '+file.path);
   return {path:file.path,sha256:expectedHash};
  });
  for(const state of states)assert.ok((await page.locator('#content').innerText()).includes(state),'fallback renders order status '+state);
  await page.evaluate(()=>MEEOPS7.openDrawer('FULL'));await page.locator('#overlay').getByText('Banner ×3',{exact:true}).waitFor();assert.match(await page.locator('#overlay').innerText(),/Full Paid/i);await page.evaluate(()=>MEEOPS7.closeOverlay());
  const checks=['packaged-fallback-hashes','cached-shell-evicted','actual-served-recovery-resource-hashes','reload-after-frontend-switch','all-five-order-statuses','multi-banner-and-full-paid-retained'];let rangeEvidence=null;
  if(role!=='SALE'){
   await page.evaluate(()=>MEEOPS7.go('production'));await page.locator('.mee-production-lane').first().waitFor();assert.equal(await page.locator('.mee-production-lane').count(),5);
   assert.equal(await page.evaluate(()=>S.filters.production.date),day,'selected production day matches persisted fixture date');
   await page.screenshot({path:path.join(out,width+'-'+role+'-precheck.png'),fullPage:true});
   const overflow=await page.locator('.mee-production-finance>span').evaluateAll(spans=>spans.flatMap(span=>{
    const card=span.closest('.order').getBoundingClientRect(),range=document.createRange();range.selectNodeContents(span);
    return [...range.getClientRects()].some(r=>r.left<card.left+4||r.right>card.right-4)?[span.textContent.trim()]:[];
   }));
   assert.deepEqual(overflow,[],'long financial/payment text must remain readable inside card');
   assert.equal(await page.locator('.order.accessory').evaluateAll(cards=>cards.filter(c=>!['none','normal','""'].includes(getComputedStyle(c,'::before').content)).length),0,'absolute accessory badge cannot cover status buttons');
   const n=calls.length;await page.locator('.lane-pickup input[type=checkbox]').first().check();assert.equal(calls.slice(n).filter(c=>/update|save|submit|review/.test(c.name)).length,0);await page.evaluate(()=>S.selected.clear());
   // Packing a Chờ bó order saves its shipping queue immediately. Requested
   // action and persisted status differ; backward steps still retain Đã bó.
   for(const [id,route] of [['WAIT',[['Đã bó','Chờ lấy'],['Đã giao','Đã giao'],['Chờ lấy','Chờ lấy'],['Đã bó','Đã bó'],['Chờ bó','Chờ bó']]],['PACKED',[['Chờ giao','Chờ giao'],['Đã giao','Đã giao'],['Chờ giao','Chờ giao'],['Đã bó','Đã bó']]]]){
    for(const [requested,saved] of route){await page.evaluate(([id,state])=>MEEOPS7.changeStatus(id,state),[id,requested]);assert.equal((await row(id)).status,saved);assert.equal(await page.evaluate(id=>S.data.production.orders.find(o=>o.id===id).status,id),saved);}
   }
   const n2=calls.filter(c=>c.name==='updateStatusBulk').length;await page.evaluate(()=>{MEEOPS7.togglePick('PACKED',true);MEEOPS7.togglePick('WAIT',true);});await page.evaluate(()=>MEEOPS7.bulkStatus('forward'));assert.equal(calls.filter(c=>c.name==='updateStatusBulk').length,n2,'mixed state bulk guarded without mutation');
   // A local date edit puts one persisted order on day two. The real picker
   // must merge date-filtered replies, and mutations must keep that card in
   // the selected range rather than comparing only filters.production.date.
   await db.query('update orders set order_date=$1,updated_at=clock_timestamp() where id=$2',[nextDay,'WAIT']);
   assert.equal((await respond('getProductionOrders',{date:day},u)).orders.length,5,'first-day response excludes the moved order');
   assert.deepEqual((await respond('getProductionOrders',{date:nextDay},u)).orders.map(o=>o.id),['WAIT'],'second-day response contains only its own order');
   const rangeCallsStart=calls.length;
   await page.evaluate(([start,end])=>{MEEOPS7.openDatePicker('production','range');MEEOPS7.datePickerSelect(start);MEEOPS7.datePickerSelect(end);},[day,nextDay]);
   await page.getByRole('button',{name:'Áp dụng',exact:true}).click();
   await page.waitForFunction(([start,end])=>S.page==='production'&&S.data.production?.rangeStart===start&&S.data.production.rangeEnd===end&&S.data.production.orders?.length===6,[day,nextDay]);
   assert.equal(await page.evaluate(()=>S.filters.production.date),day,'the single-date field remains the range start');
   const requestedDates=[...new Set(calls.slice(rangeCallsStart).filter(c=>c.name==='getProductionOrders').map(c=>c.payload.date))].sort();
   assert.deepEqual(requestedDates,[day,nextDay],'actual picker fetches both selected production days');
   const route=[['Đã bó','Chờ lấy'],['Đã giao','Đã giao'],['Chờ lấy','Chờ lấy'],['Đã bó','Đã bó'],['Chờ bó','Chờ bó']];
   for(const [requested,status] of route){
    await page.evaluate(status=>MEEOPS7.changeStatus('WAIT',status),requested);
    const persisted=await row('WAIT');assert.equal(persisted.status,status);assert.equal(persisted.order_date,nextDay);
    const visible=await page.evaluate(()=>({count:S.data.production.orders.length,matching:S.data.production.orders.filter(o=>o.id==='WAIT')}));
    assert.equal(visible.count,6,'day-two status mutation cannot remove a selected-range order');assert.equal(visible.matching.length,1);assert.equal(visible.matching[0].date,nextDay);assert.equal(visible.matching[0].status,status);
    const card=page.locator('.mee-production-lane .order').filter({has:page.getByRole('heading',{name:'QA WAIT',exact:true})});
    assert.equal(await card.count(),1,'day-two card remains rendered exactly once');assert.equal(await card.locator('.order-top > .badge').innerText(),status);assert.match(await card.locator('.meta').innerText(),/19\/10\/2026/);
   }
   rangeEvidence={start:day,end:nextDay,requestedDates,orders:6,dayTwoOrder:'WAIT',persistedDate:(await row('WAIT')).order_date,requestedStatuses:route.map(([requested])=>requested),statuses:route.map(([,status])=>status)};
   await page.screenshot({path:path.join(out,width+'-'+role+'-two-day-range.png'),fullPage:true});
   checks.push('five-production-lanes','selection-no-mutation','pickup-forward-backward','delivery-forward-backward','mixed-bulk-denied','full-paid-finance-text-wraps','no-accessory-badge-obstruction');
   checks.push('production-responses-filter-by-requested-day','actual-two-day-production-picker','day-two-status-retained-in-sql-client-dom');
  }else{
   assert.equal(await page.locator('.status-next').count(),0);const o=await row('WAIT'),denied=await rpc('updateStatus',{orderId:o.id,expectedUpdatedAt:o.updated_at,status:'Đã bó'},u.username);assert.equal(denied.code,'NOT_OWNER');assert.deepEqual(await row('WAIT'),o);checks.push('sale-production-controls-hidden','sql-sale-status-mutation-denied');
  }
  const ownerOrder=await row('DELIVERED');for(const actor of ['admin','tho']){const denied=await rpc('submitSettlement',{orderId:ownerOrder.id,expectedUpdatedAt:ownerOrder.updated_at,newSettlementId:'DENIED-'+(++seq),newBillUrls:['supabase://settlement-bills/qa-denied.jpg']},actor);assert.equal(denied.code,'NOT_OWNER');}
  assert.deepEqual(await finance(),before,'rollback/status changes preserve total, Full Paid and settled KPI revenue');checks.push('cross-owner-settlement-denied','sql-money-full-paid-kpi-invariant');
  const full=await row('FULL');assert.deepEqual(full.image_urls,['supabase://order-images/qa-sample.jpg']);assert.deepEqual(full.full_paid_bill_urls,['supabase://settlement-bills/qa-proof.jpg']);checks.push('stored-proof-identities-preserved');
  await page.screenshot({path:path.join(out,width+'-'+role+'.png'),fullPage:true});assert.deepEqual(errors,[]);results.push({width,role,checks,rangeEvidence,actualFrontendHashes,calls:calls.map(c=>c.name),finance:before});await context.close();
 }
 }finally{await browser.close();server.close();await db.close();const testedRoot=currentOnly?root:path.join(pkg,'compatible-fallback');fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({scope:currentOnly?'candidate frontend and canonical isolated SQL RPC; synthetic authentication/transport; NOT production restore':'actual packaged frontend and canonical isolated SQL RPC; synthetic authentication/transport; NOT production restore',mode:currentOnly?'candidate-only':'packaged-fallback',candidate:manifest.commit,fallback:manifest.compatibleFallback.commit,testedFrontendHashes:manifest.compatibleFallback.files.map(f=>({path:f.path,sha256:hash(fs.readFileSync(path.join(testedRoot,f.path)))})),testedSqlSha256:manifest.uiV2SchemaDelta.sha256,packedReadinessSqlSha256:manifest.packedReadinessSchemaDelta?.sha256||null,complete:results.length===6,results},null,2)+'\n');}
 console.log('PASS five-state '+(currentOnly?'corrected candidate frontend':'packaged frontend fallback')+' '+results.length+'/6 role/viewport matrices');
}
main().catch(e=>{console.error(e);server.close();if(db)db.close().catch(()=>{});process.exitCode=1;});
