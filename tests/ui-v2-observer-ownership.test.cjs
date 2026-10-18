const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=x=>fs.readFileSync(path.join(__dirname,'..','assets',x),'utf8');
const sources=['meehoa-v3.js','meehoa-v34.js','meehoa-v35.js','meehoa-v361.js','meehoa-v362.js','meehoa-v364.js','meehoa-v366.js','meehoa-order-actions.js'];
const baseline={'meehoa-v3.js':1,'meehoa-v34.js':1,'meehoa-v35.js':0,'meehoa-v361.js':0,'meehoa-v362.js':1,'meehoa-v364.js':2,'meehoa-v366.js':0,'meehoa-order-actions.js':2};
test('legacy observer entry points are bounded; new UI components must render directly',()=>{
  for(const file of sources){
    const count=(read(file).match(/new\s+MutationObserver\s*\(/g)||[]).length;
    assert.ok(count<=baseline[file],file+' reintroduced observer UI patches: '+count+' > '+baseline[file]);
  }
  assert.doesNotMatch(read('meehoa-v361.js'),/MutationObserver|wrapOpenForm|patchDashboard/);
  assert.doesNotMatch(read('meehoa-v35.js'),/MutationObserver|patchPaidCopy|patchProductionRangeButton/);
});
test('the remaining ops patch owner must stay explicit until safely migrated',()=>{
 const source=read('meehoa-v366.js');
 assert.doesNotMatch(source,/function patchDelete\(/);
 assert.match(source,/data-mee-delete-order/);
 assert.doesNotMatch(source,/function wrapOpenForm\(/);
 assert.match(source,/MEE_ORDER_FORM_ENHANCE=patchOrderForm/);
 assert.match(source,/MEE_COPY_ACTIONS_SYNC=patchCopyActions/);
 assert.doesNotMatch(source,/new\s+MutationObserver/);
 assert.match(require('node:fs').readFileSync('html','utf8'),/MEE_ORDER_FORM_ENHANCE\(\)/);
 assert.match(source,/function delegatedEditTap\(/);
 assert.match(source,/function delegatedCopyTap\(/);
});
