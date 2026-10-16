const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{Client}=require('pg'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'artifacts/staging'),out=path.join(root,'artifacts/staging-evidence');
const cfg=JSON.parse(fs.readFileSync(path.join(dir,'supabase.local.json'))),env=JSON.parse(fs.readFileSync(path.join(dir,'environment.json'))),{accounts}=JSON.parse(fs.readFileSync(path.join(dir,'credentials.local.json')));
if(cfg.API_URL!=='http://127.0.0.1:54321')throw Error('Local QA only');
const endpoint='http://127.0.0.1:4173/functions/v1/meehoasg-api-core';
function stats(values){const v=[...values].sort((a,b)=>a-b),p=x=>Math.round(v[Math.max(0,Math.ceil(v.length*x)-1)]*100)/100;return {samples:v.length,p50Ms:p(.5),p95Ms:p(.95),maxMs:p(1)};}
async function call(name,payload){const started=performance.now(),r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,payload})}),body=await r.text(),data=JSON.parse(body);assert.equal(data.ok,true,name+': '+data.message);return {data,ms:performance.now()-started,bytes:Buffer.byteLength(body)};}
async function main(){
 const db=new Client({host:'127.0.0.1',port:54322,user:'postgres',password:cfg.DB_PASSWORD,database:'postgres'});await db.connect();
 const api=[],client=[],budgets={smallApiP95Ms:1000,scaleSearchP95Ms:3000,coldClientP95Ms:5000,warmModuleP95Ms:500};let browser,complete=false;
 try{
  assert.equal((await db.query('select name from meehoa_qa.environment')).rows[0].name,'meehoa-pr39-local-synthetic');
  await db.query("insert into orders(id,customer,order_date,order_time,flower,flower_total,shipping,sale) select 'QA-BENCH-'||n,'Synthetic scale record '||n,'2024-01-01','10:00','Tulip',500000,'Ghé lấy','qa_sale' from generate_series(1,20000) n on conflict(id) do nothing");
  await db.query('analyze orders');
  const admin=accounts.find(a=>a.username==='qa_admin'),login=(await call('loginAndBootstrap',{username:admin.username,password:admin.password})).data,token=login.token;
  for(const [name,payload,scale] of [['getOrders',{q:'QA-BENCH-',globalSearch:true,page:1,pageSize:80},true],['getOrders',{start:env.today,end:env.today,page:1,pageSize:80},false],['getDashboardSummary',{start:env.today,end:env.today},false],['getDebtReview',{start:env.today,end:env.today},false],['getFlowerInventory',{start:env.today,end:env.today},false]]){
   const times=[],bytes=[];for(let i=0;i<30;i++){const r=await call(name,{...payload,token});times.push(r.ms);bytes.push(r.bytes);if(scale){assert.equal(r.data.items.length,80);assert.equal(r.data.total,20000);}}
   const s=stats(times),budget=scale?budgets.scaleSearchP95Ms:budgets.smallApiP95Ms;api.push({name,scaleRows:scale?20000:40,...s,responseBytes:{min:Math.min(...bytes),max:Math.max(...bytes)},budgetP95Ms:budget,pass:s.p95Ms<=budget});
  }
  const selected=process.env.MEEHOA_CHROMIUM||'/usr/bin/chromium';browser=await chromium.launch({headless:true,...(selected==='bundled'?{}:{executablePath:selected}),args:['--no-sandbox']});
  const iterations=Number(process.env.MEEHOA_BENCH_REPETITIONS||10);assert.ok(iterations>=5&&iterations<=20);
  for(const width of [1440,390])for(const username of ['qa_admin','qa_sale','qa_tho']){
   const a=accounts.find(x=>x.username===username),cold=[],warm=[],counts=[];
   for(let i=0;i<iterations;i++){
    const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'}),page=await context.newPage(),calls=[];
    await context.route('**/*',route=>['http://127.0.0.1:4173','http://127.0.0.1:54321'].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
    page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/functions/v1/'))try{calls.push(r.postDataJSON().name);}catch{}});
    const t=performance.now();await page.goto('http://127.0.0.1:4173');await page.locator('#loginUser').fill(a.username);await page.locator('#loginPass').fill(a.password);await page.locator('#loginBtn').click();await page.waitForFunction(()=>S.user&&document.querySelector('#content')?.textContent.length>30);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));cold.push(performance.now()-t);
    if(a.role==='ADMIN')assert.equal(calls.filter(x=>x==='getOrders').length,0,'dashboard must not refetch orders for hourly counts');
    assert.equal(calls.filter(x=>x==='loginAndBootstrap').length,1);await page.evaluate(()=>MEEOPS7.go('orders'));await page.waitForFunction(()=>S.page==='orders'&&S.data.orders?.items.length===40);
    const before=calls.length,wt=performance.now();await page.evaluate(async()=>{await MEEOPS7.go('orders');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});warm.push(performance.now()-wt);assert.equal(calls.length,before,'warm Orders revisit issues no request');counts.push({bootstrap:1,hourlyExtraOrders:a.role==='ADMIN'?0:null,warmRevisit:calls.length-before});await context.close();
   }
   const c=stats(cold),w=stats(warm);client.push({width,role:a.role,coldClient:c,warmOrders:w,requestCounts:counts,budget:{coldP95Ms:budgets.coldClientP95Ms,warmP95Ms:budgets.warmModuleP95Ms},pass:c.p95Ms<=budgets.coldClientP95Ms&&w.p95Ms<=budgets.warmModuleP95Ms});console.log('Benchmarked '+width+' '+a.role);
  }
  const plan=(await db.query("explain (analyze,format json) select * from orders where order_date=$1 order by order_date asc,order_time asc,id asc limit 80",[env.today])).rows[0]['QUERY PLAN'];fs.writeFileSync(path.join(out,'query-plan.json'),JSON.stringify(plan,null,2)+'\n');
  assert.ok(api.every(r=>r.pass)&&client.every(r=>r.pass),'local engineering latency budgets exceeded');complete=true;
 }finally{
  if(browser)await browser.close();await db.query("delete from orders where id like 'QA-BENCH-%'");await db.end();
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'benchmark.json'),JSON.stringify({scope:'real local services; cold CLIENT means fresh browser/session/cache, not cold database/Deno process; warm APIs share database cache; not public network/PITR/Egress telemetry',budgets,complete,api,client},null,2)+'\n');
 }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
