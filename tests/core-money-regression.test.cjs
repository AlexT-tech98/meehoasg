const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');
const start=source.indexOf('function num(v)');
const end=source.indexOf('function norm(v)',start);
if(start<0||end<0)throw new Error('Cannot locate core num()');
const ctx={};
vm.runInNewContext(source.slice(start,end),ctx);

test('core money parser preserves Vietnamese thousand separators',()=>{
  assert.equal(ctx.num('500.000'),500000);
  assert.equal(ctx.num('1.250.000đ'),1250000);
  assert.equal(ctx.num('500,000'),500000);
});

test('core money parser still accepts numeric and decimal inputs',()=>{
  assert.equal(ctx.num(550000),550000);
  assert.equal(ctx.num('1250.50'),1250.5);
  assert.equal(ctx.num('1.250,50'),1250.5);
});
