const test=require('node:test');const assert=require('node:assert/strict');const {evaluate}=require('../scripts/egress-guard.cjs');
const start=new Date(Date.now()-86400000).toISOString(),end=new Date(Date.now()+29*86400000).toISOString(),observedAt=new Date().toISOString();
const base={cycleStart:start,cycleEnd:end,observedAt,source:'supabase-billing-verified',scope:'organization',scopeId:'wrrijfopxqixxvovsajd',uncachedGB:0.75,cachedGB:0.022};
test('rejects unverified input',()=>assert.equal(evaluate({...base,source:'request-logs'}).status,'UNKNOWN'));
test('rejects missing data',()=>assert.equal(evaluate(null).status,'UNKNOWN'));
test('separates cached and uncached',()=>{const r=evaluate(base);assert.equal(r.totalGB,0.772);assert.equal(r.uncachedGB,0.75)});
test('alerts at threshold crossing',()=>{const r=evaluate({...base,uncachedGB:2.1},{...base,uncachedGB:1.8});assert.ok(r.alerts.some(x=>x.includes('2 GB')))});
test('does not repeat threshold',()=>{const r=evaluate({...base,uncachedGB:2.1},{...base,uncachedGB:1.8},[base.scopeId+':'+start+':uncached:2']);assert.ok(!r.alerts.some(x=>x.includes('mốc 2 GB')))});
test('alerts on projected Free risk',()=>assert.ok(evaluate(base).alerts.some(x=>x.includes('5 GB'))));
test('rejects stale snapshot',()=>assert.equal(evaluate({...base,observedAt:'2020-01-01T00:00:00Z'}).status,'UNKNOWN'));
test('cycle reset does not compare old baseline',()=>{const r=evaluate(base,{...base,cycleStart:'2026-09-14',uncachedGB:4});assert.equal(r.totalGB,0.772)});

test('requires organization total instead of a project filter',()=>assert.equal(evaluate({...base,scope:'project'}).status,'UNKNOWN'));
test('independent limits: combined over 5 GB is not automatically over Free',()=>{const r=evaluate({...base,uncachedGB:3,cachedGB:3});assert.equal(r.alerts.some(a=>a.includes('Vượt giới hạn Free')),false)});
test('cached alone above 5 GB exceeds Free',()=>assert.ok(evaluate({...base,uncachedGB:0.2,cachedGB:5.1}).alerts.some(a=>a.includes('Vượt giới hạn Free'))));
test('uncached threshold dedup does not silence cached crossing',()=>{const x=evaluate({...base,uncachedGB:2.1,cachedGB:2.1},{...base,uncachedGB:1.9,cachedGB:1.9},[base.scopeId+':'+start+':uncached:2']);assert.ok(x.alerts.some(a=>a.includes('Egress cached đã vượt mốc 2')));assert.equal(x.alerts.some(a=>a.includes('Egress uncached đã vượt mốc 2')),false)});
