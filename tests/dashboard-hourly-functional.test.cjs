const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const code=fs.readFileSync('assets/meehoa-v361.js','utf8');
function dashboardFixture(){
  const root={innerHTML:''},content={querySelector:()=>root};
  const state={page:'dashboard',user:{username:'fixture'},filters:{dashboard:{start:'2026-10-18',end:'2026-10-18'}},
    data:{dashboard:{
      summary:{orders:5,revenue:3000000,debt:0,'Chờ bó':0,'Đã bó':0,'Đã giao':5},
      attentionGroups:{nearUnpacked:[],packedOverdue:[]},salesDaily:[],
      hourlyScope:'SELECTED_RANGE',hourlyCounts:[{hour:10,count:1},{hour:15,count:2},{hour:17,count:1},{hour:21,count:1}],hourlyUnknown:0
    }}};
  const window={S:state,__MEE_TEST_MODE__:true}, document={
    readyState:'loading',addEventListener(){},getElementById(id){return id==='content'?content:null}
  };
  const context={window,document,S:state,Intl,Date,JSON,Map,Math,Number,String,
    localStorage:{getItem(){return null},setItem(){}}};
  vm.createContext(context);vm.runInContext(code,context);
  return {window,root};
}

test('dashboard hourly data preserves counts and only groups populated two-hour intervals',()=>{
  const {window}=dashboardFixture();
  const rows=JSON.parse(JSON.stringify(window.__MEE_DASHBOARD_TEST__.hourlyData({
    hourlyCounts:[{hour:9,count:2},{hour:9,count:1},{hour:11,count:1},{hour:16,count:3}]
  })));
  assert.deepEqual(rows,[
    {label:'08–10',count:3},
    {label:'10–12',count:1},
    {label:'16–18',count:3}
  ]);
  assert.equal(rows.some(x=>x.label==='12–14'),false);
});

test('dashboard hourly visualization totals agree with selected date range data',()=>{
  const {window,root}=dashboardFixture();
  window.MEE_DASHBOARD_RENDER();
  assert.match(root.innerHTML,/data-hourly-total="5"/);
  for(const value of ['10–12','14–16','16–18','20–22'])assert.ok(root.innerHTML.includes(value),value);
  assert.ok(!root.innerHTML.includes('12–14'));
});

test('direct dashboard rendering avoids DOM observer feedback loops',()=>{
  assert.doesNotMatch(code,/MutationObserver/);
  const {window,root}=dashboardFixture();
  window.MEE_DASHBOARD_RENDER();
  const first=root.innerHTML;
  window.MEE_DASHBOARD_RENDER();
  assert.equal(root.innerHTML,first,'same data produces identical output');
});
