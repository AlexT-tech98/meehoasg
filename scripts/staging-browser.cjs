const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/staging-evidence/browser');fs.mkdirSync(out,{recursive:true});
const {accounts}=JSON.parse(fs.readFileSync(path.join(root,'artifacts/staging/credentials.local.json')));
const env=JSON.parse(fs.readFileSync(path.join(root,'artifacts/staging/environment.json')));
const origin='http://127.0.0.1:4173',api='http://127.0.0.1:54321';
async function main(){
 const selected=process.env.MEEHOA_CHROMIUM||'/usr/bin/chromium';
 const browser=await chromium.launch({headless:true,...(selected==='bundled'?{}:{executablePath:selected}),args:['--no-sandbox']});
 const results=[];let activePage,label;
 try{for(const width of [1440,390])for(const username of ['qa_admin','qa_sale','qa_tho']){
  const a=accounts.find(x=>x.username===username),context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'}),page=await context.newPage();activePage=page;label=width+'-'+a.role;
  const errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',req=>{if(req.method()==='POST'&&req.url().includes('/functions/v1/')){try{const body=req.postDataJSON();calls.push(body.name||body.action);}catch{}}});
  await context.route('**/*',route=>[origin,api].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  await page.goto(origin);await page.locator('#loginUser').fill(a.username);await page.locator('#loginPass').fill(a.password);await page.locator('#loginBtn').click();
  await page.waitForFunction(()=>S.user&&document.querySelector('#content')?.textContent.length>30);
  if(a.role==='ADMIN'){await page.locator('.mee-approved-analytics-sales').waitFor();assert.equal(await page.locator('.mee-approved-analytics-sales').isVisible(),true);assert.match(await page.locator('.mee-approved-analytics-sales').innerText(),/đơn/);}
  await page.evaluate(()=>MEEOPS7.go('orders'));await page.waitForFunction(()=>S.page==='orders'&&document.querySelector('#content')?.textContent.includes('QA Khách'));
  const before=calls.filter(x=>x==='getOrders').length;await page.evaluate(()=>MEEOPS7.go('orders'));assert.equal(calls.filter(x=>x==='getOrders').length,before);
  await page.evaluate(()=>MEEOPS7.openOrderForm());await page.locator('#orderForm input[name=date]').waitFor();assert.equal(await page.locator('#orderForm input[name=date]').inputValue(),'');assert.equal(await page.locator('#orderForm input[name=date]').evaluate(x=>x.required),true);
  await page.evaluate(()=>MEEOPS7.closeOverlay());
  await page.evaluate(()=>MEEOPS7.openOrderForm('QA-SEED-001'));await page.locator('#orderForm input[name=date]').waitFor();assert.equal(await page.locator('#orderForm input[name=date]').inputValue(),env.today);assert.equal(await page.locator('#orderForm input[name=bannerQty]').inputValue(),'3');
  await page.evaluate(()=>MEEOPS7.closeOverlay());await page.evaluate(()=>MEEOPS7.openDrawer('QA-SEED-001'));await page.locator('#overlay').getByText('Banner ×3',{exact:true}).waitFor();await page.evaluate(()=>MEEOPS7.closeOverlay());
  await page.waitForFunction(()=>!document.body.classList.contains('mee-overlay-open-v364'));await page.waitForFunction(()=>{scrollTo(0,1000);return scrollY>500;});assert.ok(Math.abs((await page.locator('.topbar').boundingBox()).y)<2);
  if(a.role!=='SALE'){
   await page.evaluate(()=>MEEOPS7.go('production'));await page.waitForFunction(()=>S.page==='production'&&document.querySelector('#content input[type=checkbox]'));
   const prior=calls.length,oldStatuses=await page.evaluate(()=>S.data.production.orders.map(o=>[o.id,o.status]));await page.locator('#content input[type=checkbox]').first().check();assert.equal(await page.evaluate(()=>S.selected.size),1);
   assert.deepEqual(await page.evaluate(()=>S.data.production.orders.map(o=>[o.id,o.status])),oldStatuses);assert.ok(!calls.slice(prior).some(n=>/update|submit|save|create|review/i.test(n)));
  }
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,label+'.png'),fullPage:true});
  results.push({width,role:a.role,status:'PASS',checks:['authenticated-real-backend','new-date-blank-required','edit-date-retained','banner-input-and-drawer-quantity','sticky-scroll','warm-orders-no-extra-call',...(a.role==='ADMIN'?['dashboard-sale-report-visible']:[]),...(a.role!=='SALE'?['checkbox-no-status-write']:[])],requestNames:calls});
  await context.close();activePage=null;console.log('PASS real browser '+label);
 }}finally{if(activePage)await activePage.screenshot({path:path.join(out,label+'-failure.png'),fullPage:true}).catch(()=>{});await browser.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({scope:'real candidate UI/API/local PostgreSQL+Storage; Chromium viewport emulation, not Safari hardware or managed cloud',complete:results.length===6,results},null,2)+'\n');}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
