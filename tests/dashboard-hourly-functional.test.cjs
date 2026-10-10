const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function loadDashboardTestApi(){
  const code=fs.readFileSync('assets/meehoa-v361.js','utf8');
  const window={__MEE_TEST_MODE__:true};
  const document={readyState:'loading',addEventListener(){},querySelector(){return null}};
  const context={window,document,Intl,setTimeout,clearTimeout,console};
  vm.createContext(context);
  vm.runInContext(code,context);
  return window.__MEE_DASHBOARD_V361_TEST__;
}

test('hourly model groups real order times into one-hour buckets and omits empty hours',()=>{
  const api=loadDashboardTestApi();
  assert.ok(api&&typeof api.hourlyModel==='function');
  const rows=JSON.parse(JSON.stringify(api.hourlyModel([
    {time:'09:00'},{time:'09:45'},{time:'11:10'},{time:'16:01'},{time:'16:40'},{time:'16:59'},{time:''},{time:'invalid'}
  ])));
  assert.deepEqual(rows.map(x=>({hour:x.hour,label:x.label,count:x.count})),[
    {hour:9,label:'09:00–09:59',count:2},
    {hour:11,label:'11:00–11:59',count:1},
    {hour:16,label:'16:00–16:59',count:3}
  ]);
  assert.equal(rows.some(x=>x.hour===10),false);
});

test('hourly rendered rows preserve labels, counts and proportional bars',()=>{
  const api=loadDashboardTestApi();
  const rows=api.hourlyModel([{time:'10:00'},{time:'15:00'},{time:'15:30'},{time:'17:00'},{time:'21:00'}]);
  const html=api.hourlyHtml(rows);
  assert.match(html,/10–12/);
  assert.match(html,/14–16/);
  assert.match(html,/16–18/);
  assert.match(html,/20–22/);
  assert.doesNotMatch(html,/12–14/);
  const fifteen=rows.find(x=>x.hour===15);
  const ten=rows.find(x=>x.hour===10);
  assert.equal(fifteen.count,2);
  assert.equal(Math.round(fifteen.percent),100);
  assert.equal(Math.round(ten.percent),50);
});


test('hourly render is idempotent and does not create a MutationObserver feedback loop',()=>{
  const code=fs.readFileSync('assets/meehoa-v361.js','utf8');
  let writes=0;
  const section={dataset:{},_html:'',set innerHTML(v){writes++;this._html=v},get innerHTML(){return this._html}};
  const root={querySelector(sel){return sel==='#meeHourlySingleV361'?section:null}};
  const window={__MEE_TEST_MODE__:true};
  const document={readyState:'loading',addEventListener(){},querySelector(){return null}};
  const context={window,document,Intl,setTimeout,clearTimeout,console};
  vm.createContext(context);
  vm.runInContext(code,context);
  const api=window.__MEE_DASHBOARD_V361_TEST__;
  api.hourlyState.loading=false;
  api.hourlyState.error='';
  api.hourlyState.rows=api.hourlyModel([{time:'10:00'},{time:'15:00'},{time:'15:30'}]);
  api.renderHourly(root);
  api.renderHourly(root);
  assert.equal(writes,1);
  assert.match(section.innerHTML,/10–12/);
  assert.match(section.innerHTML,/14–16/);
});
