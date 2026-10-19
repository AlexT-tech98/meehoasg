const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const html=fs.readFileSync('html','utf8');
const core=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');
const dateOwner=fs.readFileSync('assets/meehoa-v35.js','utf8');
const release=fs.readFileSync('index.html','utf8');

function harness(responder){
  const start=html.indexOf('    function productionSearchText(v)');
  const end=html.indexOf('    function setDebtFilter(k, v)',start);
  assert.ok(start>=0&&end>start,'canonical Production search functions exist');
  const source=html.slice(start,end);
  const requests=[];
  const S={
    page:'production',selected:new Set(),filters:{
      production:{date:'2026-10-19',start:'2026-10-19',end:'2026-10-20',q:'MEE-ABC',searchWithinRange:false,statusTab:'Chờ bó'},
      orders:{pageSize:80}
    },
    data:{production:{date:'2026-10-19',orders:[{id:'CURRENT-DAY',status:'Chờ bó'}]},productionSearch:null}
  };
  const gas=async(name,args)=>{requests.push({name,args});return responder(name,args)};
  const window={matchMedia:()=>({matches:false}),MEEOPS7:{}};
  const document={getElementById:()=>null};
  const factory=new Function('S','gas','validateBuild','rememberOrders','renderProduction','norm','window','document','PRODUCTION_STATUSES','visibleOrderStatus','loadProduction','setTimeout','clearTimeout',
    'var MEEOPS7=window.MEEOPS7;var productionSearchTimer=null,productionSearchComposing=false,productionSearchChanged=false,productionSearchGeneration=0;\n'+source+
    ';return {loadProductionSearch,setProductionSearchDateScope,loadMoreProductionSearch,clearProductionSearch,productionOrderVisible,productionSearchArgs,productionSearchItems};');
  const functions=factory(S,gas,x=>x,()=>{},()=>{},v=>String(v||'').toLowerCase(),window,document,
    ['Chờ bó','Chờ giao','Chờ lấy','Đã giao'],o=>o.status,()=>{},setTimeout,clearTimeout);
  return {S,requests,...functions};
}

test('Production and Orders both use server-owned global search and same page size',async()=>{
  const found={id:'HISTORIC-123',status:'Chờ giao',date:'2026-09-01',customer:'Historical'};
  const h=harness(async()=>({ok:true,total:1,items:[found],page:1,hasMore:false}));
  await h.loadProductionSearch(true);
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].name,'getOrders');
  assert.deepEqual(h.requests[0].args,{
    start:'2026-10-19',end:'2026-10-20',q:'MEE-ABC',globalSearch:true,page:1,pageSize:80
  });
  assert.deepEqual(h.productionSearchItems().map(x=>x.id),['HISTORIC-123']);
  assert.equal(h.productionOrderVisible(found),true,'off-date results are operable in Production');
  assert.deepEqual(h.S.data.production.orders.map(x=>x.id),['CURRENT-DAY'],'date view is not overwritten by global results');
  assert.match(core,/rpc\/mee_search_orders_page/,'both modules use the canonical SQL RPC');
});

test('date-scope toggle uses exactly the Orders date-range semantics',async()=>{
  const h=harness(async()=>({ok:true,total:0,items:[],page:1,hasMore:false}));
  await h.setProductionSearchDateScope(true);
  assert.equal(h.requests[0].args.globalSearch,false);
  assert.equal(h.requests[0].args.start,'2026-10-19');
  assert.equal(h.requests[0].args.end,'2026-10-20');
  assert.equal(h.S.filters.production.searchWithinRange,true);
  assert.match(html,/id="productionSearchWithinRange"/);
  assert.match(dateOwner,/S\.filters\.production\.searchWithinRange=true/);
});

test('Production search paginates rather than silently losing results beyond the first 80',async()=>{
  const h=harness(async(name,args)=>({ok:true,total:81,page:args.page,hasMore:args.page===1,
    items:args.page===1?[{id:'A',status:'Chờ bó'}]:[{id:'B',status:'Đã giao'}]}));
  await h.loadProductionSearch(true);
  assert.equal(h.S.data.productionSearch.hasMore,true);
  await h.loadMoreProductionSearch();
  assert.deepEqual(h.requests.map(x=>x.args.page),[1,2]);
  assert.deepEqual(h.productionSearchItems().map(x=>x.id),['A','B']);
  assert.equal(h.S.data.productionSearch.total,81);
  assert.equal(h.S.data.productionSearch.hasMore,false);
});

test('single-character search does not call a backend that requires 2-200 characters',async()=>{
  const h=harness(async()=>{throw Error('should not call API')});
  h.S.filters.production.q='a';
  await h.loadProductionSearch(true);
  assert.equal(h.requests.length,0);
  assert.match(h.S.data.productionSearch.error,/2 đến 200/);
});

test('clearing a query invalidates a pending server reply',async()=>{
  let finish;
  const h=harness(()=>new Promise(resolve=>{finish=resolve}));
  const pending=h.loadProductionSearch(true);
  h.clearProductionSearch();
  finish({ok:true,total:1,page:1,hasMore:false,items:[{id:'SHOULD-NOT-RETURN'}]});
  await pending;
  assert.equal(h.S.data.productionSearch,null);
  assert.deepEqual(h.productionSearchItems().map(x=>x.id),['CURRENT-DAY']);
});

test('Production has no second local-matching search engine or fake date-bound empty state',()=>{
  assert.doesNotMatch(html,/function productionMatchesSearch\(/);
  assert.doesNotMatch(html,/function productionSearchOrders\(/);
  assert.match(html,/await gas\('getOrders',productionSearchArgs\(page\)\)/);
  assert.match(html,/loadMoreProductionSearch: loadMoreProductionSearch/);
  assert.match(html,/setProductionSearchDateScope: setProductionSearchDateScope/);
  assert.match(dateOwner,/MEEOPS7\.loadProductionRange=loadProductionRange/);
  assert.match(release,/20261019-production-unified-global-search-2/);
});
