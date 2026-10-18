/* Isolated browser acceptance: real shell/runtime, synthetic API responses.
 * This is UI integration evidence, not authenticated staging/production E2E. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/browser');
fs.mkdirSync(out,{recursive:true});
const day='2026-10-15',build='2026.09.28-supabase-v3';
const orders=Array.from({length:36},(_,i)=>({id:'FIXTURE-'+i,customer:'Khách giả '+i,phone:'0900000000',date:day,time:'10:00',flower:'Tulip',flowerTotal:500000,payment:'Chưa thanh toán',paid:0,debt:605000,totalDue:605000,sale:'Sale Fixture',saleUsername:'sale',status:'Chờ bó',shipping:'Ghé lấy',address:'',note:'Dữ liệu kiểm thử cô lập',imageUrls:[],driveUrls:[],card:false,banner:true,bannerQty:3,bannerText:'Fixture',accessoryTotal:105000,vat:0,shipFee:0,shipConfirmed:false,canEdit:true,canOperate:true,canShip:true,canSubmitSettlement:false,detailLoaded:true,updatedAt:'2026-10-15T00:00:00Z'}));
const production={ok:true,date:day,orders};
const listing={ok:true,items:orders,total:orders.length,page:1,pageSize:80,hasMore:false,range:{start:day,end:day}};
const dashboard={ok:true,range:{start:day,end:day},hourlyScope:'SELECTED_RANGE',hourlyCounts:[{hour:10,count:36}],hourlyUnknown:0,summary:{orders:36,revenue:18000000,grossRevenue:18000000,settledRevenue:0,unsettledRevenue:18000000,debt:21780000,'Chờ bó':36,'Đã bó':0,'Đã giao':0},attention:[],attentionGroups:{nearUnpacked:[],packedOverdue:[]},salesDaily:[{date:day,sale:'Sale Fixture',saleUsername:'sale',orders:36,settledOrders:0,unsettledOrders:36,grossRevenue:18000000,settledRevenue:0,unsettledRevenue:18000000}]};
const server=http.createServer((req,res)=>{try{let file=decodeURIComponent(new URL(req.url,'http://localhost').pathname);file=file==='/'?'/index.html':file;const full=path.resolve(root,'.'+file);if(!full.startsWith(root+path.sep))throw Error('path');const type=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':'text/html';res.writeHead(200,{'Content-Type':type});res.end(fs.readFileSync(full));}catch{res.writeHead(404);res.end();}});
async function main(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,...(process.env.MEEHOA_CHROMIUM?{executablePath:process.env.MEEHOA_CHROMIUM}:{}),args:['--no-sandbox']});
 const results=[];let activeContext,activePage,activeLabel;
 try{for(const width of [1440,390])for(const role of ['ADMIN','SALE','THO_OPS']){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  activeContext=context;activeLabel=`${width}-${role}`;
  await context.tracing.start({screenshots:true,snapshots:true});
  const page=await context.newPage(),calls=[],errors=[];
  activePage=page;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin===origin)return route.continue();
   // Every external request is intercepted; no customer data or real API can be reached.
   if(url.hostname.endsWith('.supabase.co')&&url.pathname.includes('/functions/v1/')){
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}});
    const {name,payload={}}=req.postDataJSON();calls.push({name,payload});
    let data;
    if(name==='loginAndBootstrap'||name==='getCurrentUserAndBootstrap'){const p=role==='ADMIN'?'dashboard':role==='THO_OPS'?'production':'orders';data={ok:true,token:'a'.repeat(64),user:{username:'fixture',name:'Fixture '+role,role,active:true},options:{sales:['Sale Fixture'],shipping:['Ghé lấy'],statuses:['Chờ bó','Đã bó','Đã giao']},initial:{page:p,data:p==='dashboard'?dashboard:p==='production'?production:listing,at:Date.now()}};}
    else if(name==='getOrders')data=listing;
    else if(name==='getProductionOrders')data=production;
    else if(name==='getDashboardSummary')data=dashboard;
    else if(name==='getOrder')data={ok:true,order:orders.find(o=>o.id===payload.orderId)};
    else if(name==='getAppOptions')data={ok:true,sales:['Sale Fixture'],shipping:['Ghé lấy'],statuses:['Chờ bó','Đã bó','Đã giao']};
    else if(name==='recordPerformance')data={ok:true};
    else data={ok:false,code:'FIXTURE_UNHANDLED',message:'Unhandled fixture route: '+name};
    return route.fulfill({status:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify({...data,build})});
   }
   return route.abort();
  });
  const started=performance.now();await page.goto(origin);
  await page.locator('#loginUser').fill('fixture');await page.locator('#loginPass').fill('fixture-only');await page.locator('#loginBtn').click();
  await page.waitForFunction(()=>window.S?.user&&document.querySelector('#content')?.textContent.length>30);
  const coldMs=Math.round(performance.now()-started);
  if(role==='ADMIN'){
   await page.locator('.mee-dv2-sales').waitFor();
   assert.equal(await page.locator('.mee-dv2-sales').isVisible(),true,'authorized Sale report visible');
   assert.match(await page.locator('.mee-dv2-sales').innerText(),/36 đơn/);
   assert.equal(await page.locator('[data-money-key]').count(),4);
   assert.equal(await page.locator('.dashboard-grid').count(),0);
   assert.equal(await page.locator('[data-hourly-total]').getAttribute('data-hourly-total'),'36');
   for(const key of ['revenue','average','debt','staff'])await page.locator('[data-dashboard-money="'+key+'"]').click();
   assert.equal(await page.locator('.mee-dv2-metric:nth-child(2) .mee-dv2-metric-value').innerText(),'••••••');
   assert.doesNotMatch(await page.locator('#content').innerText(),/\d[\d.]*\s*đ(?:\s|$)/);
   await page.reload();await page.locator('[data-dashboard-money="revenue"]').waitFor();
   assert.equal(await page.locator('.mee-dv2-metric:nth-child(2) .mee-dv2-metric-value').innerText(),'••••••','privacy survives cached-shell reload');
   for(const key of ['revenue','average','debt','staff'])await page.locator('[data-dashboard-money="'+key+'"]').click();
   assert.match(await page.locator('.mee-dv2-metric:nth-child(2)').innerText(),/18.000.000/);

  }
  await page.evaluate(()=>MEEOPS7.go('orders'));await page.waitForFunction(()=>S.page==='orders'&&document.querySelector('#content').textContent.includes('Khách giả'));
  const beforeWarm=calls.filter(c=>c.name==='getOrders').length,warmStart=performance.now();
  await page.evaluate(()=>MEEOPS7.go('orders'));
  await page.waitForFunction(()=>S.page==='orders'&&document.querySelector('#content').textContent.includes('Khách giả'));
  const warmMs=Math.round(performance.now()-warmStart);
  assert.equal(calls.filter(c=>c.name==='getOrders').length,beforeWarm,'fresh revisit reuses Orders data');
  await page.evaluate(()=>MEEOPS7.openOrderForm());await page.locator('#orderForm input[name=date]').waitFor();
  assert.equal(await page.locator('#orderForm input[name=date]').inputValue(),'','new date must be blank');
  assert.equal(await page.locator('#orderForm input[name=date]').getAttribute('required'),'');
  await page.evaluate(()=>MEEOPS7.closeOverlay());
  await page.evaluate(()=>MEEOPS7.openOrderForm('FIXTURE-0'));await page.locator('#orderForm input[name=date]').waitFor();
  assert.equal(await page.locator('#orderForm input[name=date]').inputValue(),day,'edit keeps date');
  await page.evaluate(()=>MEEOPS7.closeOverlay());
  await page.evaluate(()=>MEEOPS7.openDrawer('FIXTURE-0'));await page.locator('#overlay').getByText('Banner ×3',{exact:true}).waitFor();
  await page.evaluate(()=>MEEOPS7.closeOverlay());
  await page.waitForFunction(()=>!document.body.classList.contains('mee-overlay-open-v364')&&!document.body.classList.contains('mee-menu-open'));
  await page.waitForFunction(()=>{window.scrollTo(0,1000);return window.scrollY>500;});
  const top=await page.locator('.topbar').boundingBox();assert.ok(Math.abs(top.y)<2,'topbar stays at viewport top: '+top.y);
  if(role!=='SALE'){
   await page.evaluate(()=>MEEOPS7.go('production'));await page.waitForFunction(()=>S.page==='production'&&document.querySelector('#content input[type=checkbox]'));
   const before=calls.length;await page.locator('#content input[type=checkbox]').first().check();
   assert.equal(await page.evaluate(()=>S.selected.size),1,'checkbox selects one');
   assert.equal(await page.evaluate(()=>S.data.production.orders[0].status),'Chờ bó');
   assert.ok(!calls.slice(before).some(c=>/update|submit|save|create|review/i.test(c.name)),'selection never sends mutation');
  }
  await page.screenshot({path:path.join(out,`${width}-${role}.png`),fullPage:true});
  assert.deepEqual(errors,[],'no browser exceptions');
  results.push({width,role,coldMs,warmMs,checks:['new-date-blank-required','edit-date-retained','drawer-banner-quantity','sticky-topbar','warm-orders-no-duplicate-call',...(role==='ADMIN'?['sale-report-visible-with-order-count']:[]),...(role!=='SALE'?['selection-no-mutation']:[])],calls:calls.map(c=>c.name)});
  await context.tracing.stop({path:path.join(out,`${width}-${role}.zip`)});await context.close();activeContext=null;activePage=null;
 }}finally{if(activeContext){await activePage.screenshot({path:path.join(out,activeLabel+'-failure.png'),fullPage:true}).catch(()=>{});await activeContext.tracing.stop({path:path.join(out,activeLabel+'-failure.zip')}).catch(()=>{});}await browser.close();server.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({scope:'isolated UI integration; synthetic API; NOT staging E2E',complete:results.length===6,results},null,2)+'\n');}
 console.log(JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
