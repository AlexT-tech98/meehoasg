const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const entry=fs.readFileSync('index.html','utf8');
const metrics=JSON.parse(fs.readFileSync('runtime-metrics.json','utf8'));
const coreJs=fs.readFileSync('assets/meehoa-core.js','utf8');
const coreCss=fs.readFileSync('assets/meehoa-core.css','utf8');

const CORE_CSS=/meehoa-core\.css\?v=[A-Za-z0-9._-]+/;
const CORE_JS=/meehoa-core\.js\?v=[A-Za-z0-9._-]+/;

test('browser runtime is two consolidated frontend requests',()=>{
  assert.equal(metrics.runtimeRequestsAfter,2);
  assert.ok(metrics.sourceRequestsBefore>=18);
  assert.match(entry,CORE_CSS);
  assert.match(entry,CORE_JS);
  for(const legacy of ['meehoa-v3.css','meehoa-v34.css','meehoa-v35.js','meehoa-v361.js','meehoa-v362.js','meehoa-v363.js','meehoa-v364.js','meehoa-v365.js']){
    assert.equal(entry.includes(legacy),false,`entry must not load ${legacy} directly`);
  }
});

test('generated core preserves ordered compatibility source exactly once per module',()=>{
  for(const file of metrics.cssFiles)assert.equal((coreCss.match(new RegExp(`===== ${file.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')} =====`,'g'))||[]).length,1);
  for(const file of metrics.jsFiles)assert.equal((coreJs.match(new RegExp(`===== ${file.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')} =====`,'g'))||[]).length,1);
});

test('consolidated JS multiplexes compatibility observers through one native MutationObserver',()=>{
  assert.ok(metrics.sourceMutationObservers>=2);
  assert.equal(metrics.nativeMutationObserversAfter,1);
  assert.match(coreJs,/MEEHOA shared MutationObserver multiplexer/);
  assert.match(coreJs,/window\.__MEE_SHARED_MUTATION_OBSERVER__=true/);
});
