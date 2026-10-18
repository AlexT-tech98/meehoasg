const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const entry=fs.readFileSync('index.html','utf8');
const metrics=JSON.parse(fs.readFileSync('runtime-metrics.json','utf8'));
const coreJs=fs.readFileSync('assets/meehoa-core.js','utf8');
const coreCss=fs.readFileSync('assets/meehoa-core.css','utf8');

const CORE_CSS=/meehoa-core\.css\?v=[A-Za-z0-9._-]+/;
const CORE_JS=/meehoa-core\.js\?v=[A-Za-z0-9._-]+/;

test('browser runtime is two consolidated frontend requests built from canonical owner modules',()=>{
  assert.equal(metrics.schemaVersion,2);
  assert.equal(metrics.architecture,'single-owner-modules');
  assert.equal(metrics.runtimeRequestsAfter,2);
  assert.equal(metrics.sourceRequestsBefore,metrics.cssFiles.length+metrics.jsFiles.length);
  assert.match(entry,CORE_CSS);
  assert.match(entry,CORE_JS);
  for(const source of [...metrics.cssFiles,...metrics.jsFiles]) assert.equal(entry.includes(source),false,`entry must not load ${source} directly`);
});

test('generated core preserves each declared canonical source exactly once',()=>{
  for(const file of metrics.cssFiles)assert.equal((coreCss.match(new RegExp(`===== ${file.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')} =====`,'g'))||[]).length,1);
  for(const file of metrics.jsFiles)assert.equal((coreJs.match(new RegExp(`===== ${file.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')} =====`,'g'))||[]).length,1);
});

test('canonical runtime renders directly without observer patch infrastructure',()=>{
  assert.equal(metrics.sourceMutationObservers,0);
  assert.equal(metrics.nativeMutationObserversAfter,0);
  assert.doesNotMatch(coreJs,/MutationObserver|__MEE_SHARED_MUTATION_OBSERVER__/);
});
