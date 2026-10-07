const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const src=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');

function duplicateMatcher(){
  const start=src.indexOf('function operationalDuplicateCandidate(row,target){');
  const end=src.indexOf('\n}',start);
  assert.ok(start>=0&&end>start,'production duplicate matcher must exist');
  const fn=src.slice(start,end+2);
  return vm.runInNewContext('('+fn+')');
}

test('operational duplicate matcher blocks the reported duplicate signature',()=>{
  const match=duplicateMatcher();
  const existing={
    deleted:false,
    identity:'p:0972485714|c:thao nguyen',
    sale:'cmui',
    amount:200000,
    shipping:'ghe lay',
    payment:'da coc 100.000 d'
  };
  assert.equal(match(existing,{...existing}),true);
});

test('duplicate matcher does not merge another customer or another assigned sale',()=>{
  const match=duplicateMatcher();
  const base={deleted:false,identity:'p:0972485714|c:thao nguyen',sale:'cmui',amount:200000,shipping:'ghe lay',payment:'da coc 100.000 d'};
  assert.equal(match({...base,identity:'p:0900000000|c:khach khac'},base),false);
  assert.equal(match({...base,sale:'hien'},base),false);
  assert.equal(match({...base,deleted:true},base),false);
});

test('create route performs request-id idempotency before operational duplicate lookup',()=>{
  const start=src.indexOf('async function safeCreateOrder');
  const end=src.indexOf('\n}\n\nasync function fastOrder',start);
  assert.ok(start>=0&&end>start);
  const create=src.slice(start,end+2);
  const requestPos=create.indexOf('request_id:');
  const candidatePos=create.indexOf("const rows=await all('orders'");
  assert.ok(requestPos>=0&&candidatePos>requestPos);
  assert.ok(create.includes('order_date:`eq.${date}`'));
  assert.ok(create.includes('order_time:`eq.${time}`'));
  assert.match(create,/duplicatePrevented:true/);
});
