const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const sources=['meehoa-v3.css','meehoa-v34.css','meehoa-v35.css','meehoa-v361.css','meehoa-v362.css','meehoa-v364.css','meehoa-v365.css','meehoa-ui-v3.css'];
const read=file=>fs.readFileSync(path.join(root,'assets',file),'utf8');
// UI V3 lowered total !important from 1,104 down to 504 (target <= 854, >= 250 reduction) with 0 in meehoa-ui-v3.css.
const limits={
  'meehoa-v3.css':160,'meehoa-v34.css':10,'meehoa-v35.css':35,
  'meehoa-v361.css':0,'meehoa-v362.css':3,'meehoa-v364.css':55,'meehoa-v365.css':280,'meehoa-ui-v3.css':0
};

test('UI V3 override debt must stay strictly below lowered ceilings and zero in new CSS',()=>{
  const actual={};
  for(const file of sources){
    const contents=read(file);
    const count=(contents.match(/!important\b/g)||[]).length;
    actual[file]=count;
    assert.ok(count<=limits[file],file+': '+count+' overrides; ceiling '+limits[file]);
  }
  assert.ok(Object.values(actual).reduce((sum,count)=>sum+count,0)<=600,'total override debt must stay <= 600 (down from 1,104 baseline)');
  assert.equal(actual['meehoa-v361.css'],0,'Dashboard V2 stylesheet must be free of !important');
  assert.equal(actual['meehoa-ui-v3.css'],0,'UI V3 stylesheet must be free of !important');
});
test('production CSS bundle is deterministic and does not load retired Dashboard components',()=>{
 const compiled=read('meehoa-core.css');
 for(const selector of ['mee-approved-summary','mee-approved-kpi','mee-atelier-dashboard-header','mee-chart-grid']){
  assert.ok(!compiled.includes(selector),'retired selector still compiled: '+selector);
 }
 assert.match(compiled,/\.mee-dv2-metrics/);
 assert.match(compiled,/\.mee-production-v2/);
});
test('shell branding and shipping presentation belong to the shell owner',()=>{
 assert.match(read('meehoa-v3.css'),/\.mee-brand-mark\{/);
 assert.match(read('meehoa-v3.css'),/\.mee-shipping-icon\{/);
 assert.doesNotMatch(read('meehoa-v35.css'),/\.mee-brand-mark|\.mee-brand-wordmark|\.mee-shipping-icon|\.sidebar \.brand-copy|\.loading-pill|\.page-status/);
});
