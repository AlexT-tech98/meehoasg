const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const sources=['meehoa-v3.css','meehoa-v34.css','meehoa-v35.css','meehoa-v361.css','meehoa-v362.css','meehoa-v364.css','meehoa-v365.css'];
const read=file=>fs.readFileSync(path.join(root,'assets',file),'utf8');
const limits={
  'meehoa-v3.css':239,'meehoa-v34.css':169,'meehoa-v35.css':80,
  'meehoa-v361.css':0,'meehoa-v362.css':3,'meehoa-v364.css':139,'meehoa-v365.css':505
};

test('UI V2 override debt must only decrease, never grow',()=>{
  const actual={};
  for(const file of sources){
    const contents=read(file);
    const count=(contents.match(/!important\b/g)||[]).length;
    actual[file]=count;
    assert.ok(count<=limits[file],file+': '+count+' overrides; previous ceiling '+limits[file]);
  }
  assert.equal(actual['meehoa-v361.css'],0,'new Dashboard V2 stylesheet must be free of !important');
});
test('production CSS bundle is deterministic and does not load retired Dashboard components',()=>{
 const compiled=read('meehoa-core.css');
 for(const selector of ['mee-approved-summary','mee-approved-kpi','mee-atelier-dashboard-header','mee-chart-grid']){
  assert.ok(!compiled.includes(selector),'retired selector still compiled: '+selector);
 }
 assert.match(compiled,/\.mee-dv2-metrics/);
 assert.match(compiled,/\.mee-production-v2/);
});
