const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/staging-evidence/browser');fs.mkdirSync(out,{recursive:true});
const {accounts}=JSON.parse(fs.readFileSync(path.join(root,'artifacts/staging/credentials.local.json')));
const env=JSON.parse(fs.readFileSync(path.join(root,'artifacts/staging/environment.json')));
const apiEvidence=JSON.parse(fs.readFileSync(path.join(root,'artifacts/staging-evidence/api-results.json')));
const origin='http://127.0.0.1:4173',api='http://127.0.0.1:54321';
async function main(){
 const selected=process.env.MEEHOA_CHROMIUM||'/usr/bin/chromium';
 const browser=await chromium.launch({headless:true,...(selected==='bundled'?{}:{executablePath:selected}),args:['--no-sandbox']});
 const results=[];let activePage,label;
 try{for(const width of [1440,390])for(const username of ['qa_admin','qa_sale','qa_tho']){
  const a=accounts.find(x=>x.username===username),context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',timezoneId:'Asia/Ho_Chi_Minh'}),page=await context.newPage();activePage=page;label=width+'-'+a.role;
  const errors=[],calls=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',req=>{if(req.method()==='POST'&&req.url().includes('/functions/v1/')){try{const body=req.postDataJSON();calls.push(body.name||body.action);}catch{}}});
  await context.route('**/*',route=>[origin,api].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  const shot=module=>page.screenshot({path:path.join(out,label+'-'+module+'.png'),fullPage:true});
  await page.goto(origin);await page.locator('#loginUser').fill(a.username);await page.locator('#loginPass').fill(a.password);await page.locator('#loginBtn').click();
  await page.waitForFunction(()=>S.user&&document.querySelector('#content')?.textContent.length>30);checks.push('authenticated-real-backend');
  if(a.role==='ADMIN'){await page.locator('.mee-dv2-sales').waitFor();assert.equal(await page.locator('.mee-dv2-sales').isVisible(),true);assert.match(await page.locator('.mee-dv2-sales').innerText(),/đơn/);checks.push('dashboard-sale-counts-visible');await shot('dashboard');}
  await page.evaluate(()=>MEEOPS7.go('orders'));await page.waitForFunction(()=>S.page==='orders'&&document.querySelector('#content')?.textContent.includes('QA Khách'));
  const before=calls.filter(x=>x==='getOrders').length;await page.evaluate(()=>MEEOPS7.go('orders'));assert.equal(calls.filter(x=>x==='getOrders').length,before);checks.push('warm-orders-no-extra-call');
  await page.evaluate(()=>MEEOPS7.openOrderForm());await page.locator('#orderForm input[name=date]').waitFor();assert.equal(await page.locator('#orderForm input[name=date]').inputValue(),'');assert.equal(await page.locator('#orderForm input[name=date]').evaluate(x=>x.required),true);
  await page.evaluate(()=>MEEOPS7.closeOverlay());await page.evaluate(()=>MEEOPS7.openOrderForm('QA-SEED-001'));await page.locator('#orderForm input[name=date]').waitFor();assert.equal(await page.locator('#orderForm input[name=date]').inputValue(),env.today);assert.equal(await page.locator('#orderForm input[name=bannerQty]').inputValue(),'3');checks.push('new-date-required-and-edit-retained','banner-quantity-form');await shot('form');
  await page.evaluate(()=>MEEOPS7.closeOverlay());await page.evaluate(()=>MEEOPS7.openDrawer('QA-SEED-001'));await page.locator('#overlay').getByText('Banner ×3',{exact:true}).waitFor();checks.push('banner-quantity-drawer');await shot('drawer');await page.evaluate(()=>MEEOPS7.closeOverlay());
  await page.waitForFunction(()=>!document.body.classList.contains('mee-overlay-open-v364'));await page.waitForFunction(()=>{scrollTo(0,1000);return scrollY>500;});assert.ok(Math.abs((await page.locator('.topbar').boundingBox()).y)<2);checks.push('sticky-after-real-scroll-overlay-unlock');
  await page.evaluate(()=>scrollTo(0,0));
  await page.locator('#globalSearchInput').fill('qa khach tien');await page.waitForFunction(()=>S.data.orders?.searchScope==='ALL_DATES'&&S.data.orders.total===240);await page.locator('#globalSearchInput').press('Escape');
  await page.locator('#searchWithinRange').check();await page.waitForFunction(()=>S.data.orders?.searchScope==='DATE_RANGE'&&S.data.orders.total===40);
  await page.locator('.date-filter-btn').first().click();await page.getByRole('button',{name:'Hôm nay',exact:true}).click();await page.getByRole('button',{name:'Áp dụng',exact:true}).click();await page.waitForFunction(()=>S.data.orders?.searchScope==='DATE_RANGE'&&S.data.orders.total===40);
  await page.locator('#searchWithinRange').uncheck();await page.waitForFunction(()=>S.data.orders?.searchScope==='ALL_DATES'&&S.data.orders.total===240);await page.evaluate(()=>MEEOPS7.loadMoreOrders());await page.waitForFunction(()=>S.data.orders?.items.length===160);
  assert.equal(await page.evaluate(()=>new Set(S.data.orders.items.map(o=>o.id)).size),160);checks.push('global-date-toggle-calendar-and-disjoint-pagination');await shot('search');
  await page.locator('#globalSearchInput').fill(apiEvidence.fixtureSearch);await page.waitForFunction(q=>S.filters.orders.q===q&&S.data.orders.items.length<20&&S.data.orders.items.some(o=>o.customer.startsWith(q)),apiEvidence.fixtureSearch);
  const full=apiEvidence.results.find(r=>r.name.startsWith('Full Paid uploads')),flower=apiEvidence.results.find(r=>r.name==='flower-only payment preserves accessory debt');
  assert.ok(full.orderId&&flower.orderId,'payment fixtures');
  const row=id=>page.locator('.order-card-mobile:visible[onclick*="'+id+'"]');
  assert.match(await row(full.orderId).innerText(),/Đã thanh toán toàn bộ đơn \(Full Paid\)/);assert.match(await row(flower.orderId).innerText(),/Đã thanh toán đủ tiền hoa/);assert.doesNotMatch(await row(flower.orderId).innerText(),/toàn bộ đơn/);for(const id of [full.orderId,flower.orderId]){const clear=await row(id).evaluate(card=>{const r=card.getBoundingClientRect(),footer=card.querySelector('.order-card-mobile-footer');if(!footer)return false;const fb=footer.getBoundingClientRect(),s=getComputedStyle(card,':before');if(fb.bottom>r.bottom+2)return false;if(s.display!=='none'&&s.content!=='none'){const h=parseFloat(s.lineHeight)||parseFloat(s.fontSize)*1.5||0,bottom=parseFloat(s.bottom)||0,topPad=parseFloat(s.paddingTop)||0,bottomPad=parseFloat(s.paddingBottom)||0;if(fb.bottom>r.bottom-bottom-h-topPad-bottomPad+2)return false;}return Array.from(card.querySelectorAll('.order-card-mobile-top .badge')).every(el=>{const b=el.getBoundingClientRect();return !(b.left<fb.right&&b.right>fb.left&&b.top<fb.bottom&&b.bottom>fb.top);});});assert.ok(clear,'accessory badge must not cover payment/debt line');}checks.push('full-paid-flower-only-labels-match-desktop-mobile','accessory-badge-does-not-cover-finance');const ordered=await page.evaluate(()=>S.data.orders.items.map(o=>[o.date,o.time,o.id].join('|')));assert.deepEqual(ordered,ordered.slice().sort(),'delivery ordering must remain earliest first in rendered Orders');checks.push('earliest-delivery-first');assert.equal(await page.locator('#searchDropdown').isVisible(),false,'Orders results must not be covered by stale cached suggestions');await shot('payment-labels');
  if(a.role==='SALE'){
   // Reproduce Pu's mobile drawer -> Edit tap -> Full Paid save on real isolated backend.
   await page.evaluate(id=>MEEOPS7.openDrawer(id,'orders'),full.orderId);
   await page.locator('#overlay [data-mee-order-action="edit"]').click();
   await page.locator('#orderForm[data-detail-ready="1"]').waitFor();
   assert.equal(await page.locator('#overlay [data-mee-order-action="copy"]').count(),0,'Copy action must not replace Edit');
   const changedNote='QA FULL PAID EDIT '+width;
   await page.locator('#orderForm textarea[name="note"]').fill(changedNote);
   await page.locator('#orderSubmit').click();
   await page.waitForFunction(({id,note})=>!document.querySelector('#orderForm')&&S.orders.get(id)?.note===note,{id:full.orderId,note:changedNote});
   await page.evaluate(id=>MEEOPS7.openOrderForm(id),full.orderId);
   await page.locator('#orderForm textarea[name="note"]').waitFor();
   assert.equal(await page.locator('#orderForm textarea[name="note"]').inputValue(),changedNote);
   await page.evaluate(()=>MEEOPS7.closeOverlay());
   checks.push('sale-full-paid-edit-tap-saves-persists-on-real-backend');
  }
  await page.locator('#globalSearchInput').fill('');await page.waitForFunction(()=>S.filters.orders.q===''&&S.data.orders.searchScope==='DATE_RANGE'&&S.data.orders.total===40);
  await page.evaluate(()=>MEEOPS7.go('debt'));await page.waitForFunction(()=>S.page==='debt'&&document.querySelector('#content')?.textContent.length>30);await page.waitForFunction(()=>S.data.debt?.items);const debt=await page.evaluate(()=>({scope:S.data.debt.scope,items:S.data.debt.items.map(o=>({saleUsername:o.saleUsername,canSubmit:o.canSubmitSettlement})),actor:S.user.username}));if(a.role!=='ADMIN'){assert.equal(debt.scope,'SELF');assert.ok(debt.items.every(o=>o.saleUsername===debt.actor),'debt list must contain only this owner');}else assert.ok(debt.items.every(o=>!o.canSubmit||o.saleUsername===debt.actor));await shot('debt');assert.ok(await page.evaluate(()=>S.data.debt.items.some(o=>o.status!=='Đã giao')),'unsettled not-delivered orders must remain visible');checks.push('debt-module-real-api','owner-scoped-debt-list','not-delivered-unsettled-visible');if(a.role==='ADMIN'||a.role==='SALE'){await page.evaluate(async()=>{S.filters.debt.start='2030-01-01';S.filters.debt.end='2030-01-01';await MEEOPS7.refreshPage();});const zero=apiEvidence.results.find(r=>r.name.startsWith('zero-balance unverified'));assert.ok(zero?.orderId);assert.ok(await page.evaluate(id=>S.data.debt.items.some(o=>o.id===id&&o.debt===0&&!o.fullPaid&&!o.settled),zero.orderId));assert.ok((await page.locator('#content').innerText()).includes('Dư nợ 0đ · Vẫn cần tất toán'));assert.ok(await page.evaluate(()=>S.data.debt.items.every(o=>!o.fullPaid&&!o.settled)));checks.push('zero-balance-unsettled-visible-full-paid-excluded');}const foreignId=a.username==='qa_sale'?'QA-SEED-000':'QA-SEED-010';await page.evaluate(id=>MEEOPS7.openDrawer(id,'orders'),foreignId);await page.waitForFunction(()=>!!document.querySelector('#overlay .drawer'));assert.equal(await page.evaluate(id=>S.orders.get(id).canSubmitSettlement,foreignId),false);assert.equal(await page.locator('#overlay').getByRole('button',{name:'Gửi yêu cầu tất toán',exact:true}).count(),0);await page.evaluate(id=>MEEOPS7.settlementForm(id),foreignId);assert.equal(await page.locator('#settlementForm').count(),0);await page.evaluate(()=>MEEOPS7.closeOverlay());checks.push('foreign-settlement-hidden-and-form-blocked');
  if(a.role!=='SALE'){
   await page.evaluate(()=>MEEOPS7.go('flowers'));await page.waitForFunction(()=>S.page==='flowers'&&document.querySelector('#content')?.textContent.includes('Tulip'));
   await page.evaluate(()=>{MEEOPS7.openDatePicker('flowers','range');MEEOPS7.datePickerSelect('2025-01-01');});await page.evaluate(d=>MEEOPS7.datePickerSelect(d),env.today);await page.getByRole('button',{name:'Áp dụng',exact:true}).click();await page.waitForFunction(()=>S.page==='flowers'&&Object.values(S.data.flowers).some(r=>r.totalOrders===240));checks.push('flowers-multiday-real-picker');await shot('flowers');await page.locator('[data-material="Tulip"]').click();await page.waitForFunction(()=>document.querySelectorAll('#overlay .mee-material-order').length===120);await page.evaluate(()=>MEEOPS7.closeOverlay());checks.push('flowers-range-drilldown-distinct-orders');
   await page.evaluate(()=>MEEOPS7.go('production'));await page.waitForFunction(()=>S.page==='production'&&document.querySelector('#content input[type=checkbox]'));
   // Real-backend parity gate: Production searches exactly the same 240 historical orders as Orders,
   // and the date-range toggle narrows to the same 40. Check both Admin and THO, desktop and mobile.
   await page.locator('#productionSearchInput').fill('qa khach tien');
   await page.waitForFunction(()=>S.data.productionSearch?.total===240&&S.data.productionSearch.items.length===80);
   assert.ok(await page.evaluate(()=>S.data.productionSearch.items.some(o=>o.date!==S.filters.production.date)),'Production must find orders outside today');
   await page.locator('#productionSearchWithinRange').check();
   await page.waitForFunction(()=>S.data.productionSearch?.total===40&&S.filters.production.searchWithinRange);
   await page.locator('#productionSearchWithinRange').uncheck();
   await page.waitForFunction(()=>S.data.productionSearch?.total===240&&!S.filters.production.searchWithinRange);
   await page.evaluate(()=>MEEOPS7.loadMoreProductionSearch());
   await page.waitForFunction(()=>S.data.productionSearch?.items.length===160);
   assert.equal(await page.evaluate(()=>new Set(S.data.productionSearch.items.map(o=>o.id)).size),160);
   await page.locator('#productionSearchInput').fill('');
   await page.waitForFunction(()=>S.filters.production.q===''&&S.data.productionSearch===null);
   checks.push('production-orders-global-search-parity','production-date-scope-and-pagination');
   if(width<=760)await page.locator('.mee-production-stat').filter({hasText:'Chờ bó'}).click();
   const prior=calls.length,old=await page.evaluate(()=>S.orders.get('QA-SEED-002').status);await page.locator('#content input[type=checkbox][onchange*="QA-SEED-002"]').check();assert.equal(await page.evaluate(()=>S.selected.size),1);assert.equal(await page.evaluate(()=>S.orders.get('QA-SEED-002').status),old);assert.ok(!calls.slice(prior).some(n=>/update|submit|save|create|review/i.test(n)));
   await page.getByRole('button',{name:'Tiến trạng thái →',exact:true}).click();await page.waitForFunction(()=>S.orders.get('QA-SEED-002').status==='Chờ lấy');
   await page.evaluate(()=>MEEOPS7.changeStatus('QA-SEED-002','Chờ bó'));await page.waitForFunction(()=>S.orders.get('QA-SEED-002').status==='Chờ bó');checks.push('checkbox-selection-only-explicit-status-action');await shot('production');
  }
  // Visual release gate: capture KPI for every role and Admin-only Payment/Admin
  // with the same authenticated, real local API (no production writes).
  await page.evaluate(()=>MEEOPS7.go('kpi'));
  await page.waitForFunction(()=>S.page==='kpi'&&!!S.data.kpi[S.filters.kpi.month]&&document.querySelector('#content')?.textContent.length>30);
  await shot('kpi');checks.push('kpi-role-viewport-real-api-visual');
  if(a.role==='ADMIN'){
   await page.evaluate(()=>MEEOPS7.go('payment'));
   await page.waitForFunction(()=>S.page==='payment'&&!!S.data.payment&&document.querySelector('#content')?.textContent.includes('PAYMENT CHECK'));
   await shot('payment');checks.push('payment-role-viewport-real-api-visual');
   await page.evaluate(()=>MEEOPS7.go('admin'));
   await page.waitForFunction(()=>S.page==='admin'&&!!S.data.admin&&document.querySelector('#content')?.textContent.includes('Người dùng'));
   assert.ok(await page.locator('#content .table-wrap button').count()>0,'ADMIN user actions must render');
   if(width===390){
    const lastButton=await page.locator('#content .table-wrap button').last().evaluate(btn=>{
      const scroller=btn.closest('.table-wrap');
      scroller.scrollLeft=scroller.scrollWidth;
      const button=btn.getBoundingClientRect(),area=scroller.getBoundingClientRect();
      return {right:button.right,areaRight:area.right,scrollLeft:scroller.scrollLeft};
    });
    assert.ok(lastButton.right<=lastButton.areaRight+2,'Admin actions must be reachable by horizontal scrolling on mobile: '+JSON.stringify(lastButton));
   }
   await shot('admin');checks.push('admin-role-viewport-real-api-visual');
  }
  assert.deepEqual(errors,[]);results.push({width,role:a.role,status:'PASS',checks,requestNames:calls});await context.close();activePage=null;console.log('PASS full real-browser acceptance '+label);
 }}finally{if(activePage)await activePage.screenshot({path:path.join(out,label+'-failure.png'),fullPage:true}).catch(()=>{});await browser.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({scope:'real candidate UI/API/local PostgreSQL+Storage; Chromium viewport emulation, not Safari hardware or managed cloud',complete:results.length===6,results},null,2)+'\n');}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
