const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const src=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');

function duplicateMatcher(){
  const m=src.match(/function operationalDuplicateCandidate\\(row,target\\)\\{[\\s\\S]*?\\n\\}/);
  assert.ok(m,'production duplicate matcher must exist');
  return vm.runInNewContext('('+m[0]+')');
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
  const incoming={...existing};
  assert.equal(match(existing,incoming),true);
});

test('duplicate matcher does not merge another customer or another assigned sale',()=>{
  const match=duplicateMatcher();
  const base={deleted:false,identity:'p:0972485714|c:thao nguyen',sale:'cmui',amount:200000,shipping:'ghe lay',payment:'da coc 100.000 d'};
  assert.equal(match({...base,identity:'p:0900000000|c:khach khac'},base),false);
  assert.equal(match({...base,sale:'hien'},base),false);
  assert.equal(match({...base,deleted:true},base),false);
});

test('create route performs request-id idempotency before operational duplicate lookup',()=>{
  const requestPos=src.indexOf("request_id:`eq.${requestId}`");
  const candidatePos=src.indexOf("const rows=await all('orders'");
  assert.ok(requestPos>=0&&candidatePos>requestPos);
  assert.match(src,/order_date:`eq\\.\\$\\{date\\}`/);
  assert.match(src,/order_time:`eq\\.\\$\\{time\\}`/);
  assert.match(src,/duplicatePrevented:true/);
});
