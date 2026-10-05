const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('canonical operational module is part of the declared build',()=>{
  const build=fs.readFileSync('scripts/build-runtime.cjs','utf8');
  const owner=fs.readFileSync('runtime-ownership.json','utf8');
  assert.match(build,/meehoa-order-actions\.js/);
  assert.match(owner,/shippingAndSettlement/);
});
