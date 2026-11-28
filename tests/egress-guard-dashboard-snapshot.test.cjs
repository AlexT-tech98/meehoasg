const test=require('node:test');
const assert=require('node:assert/strict');
const snapshot=require('../docs/validation/egress-snapshots/2026-10-26T150227Z.json');
const {evaluate}=require('../scripts/egress-guard.cjs');
test('verified 26 Oct organization Billing snapshot triggers Free risk and all uncached thresholds',()=>{
  const result=evaluate(snapshot,null,[],Date.parse(snapshot.observedAt));
  assert.equal(result.status,'ALERT');
  assert.equal(result.uncachedGB,22.181);
  assert.equal(result.cachedGB,0.248);
  for(const threshold of [2,3,4]) assert.ok(result.alerts.some(a=>a.includes('Egress uncached')&&a.includes('mốc '+threshold+' GB')));
  assert.ok(result.alerts.some(a=>a.includes('Vượt giới hạn Free')));
  assert.ok(result.alerts.some(a=>a.includes('dự báo vượt 5 GB')));
});
