const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const read=p=>fs.readFileSync(p,'utf8');
const metrics=JSON.parse(read('runtime-metrics.json'));
const ownership=JSON.parse(read('runtime-ownership.json'));
const build=read('scripts/build-runtime.cjs');
const v3=read('assets/meehoa-v3.js');
const v35=read('assets/meehoa-v35.js');
const v361=read('assets/meehoa-v361.js');
const v362=read('assets/meehoa-v362.js');
const v364=read('assets/meehoa-v364.js');
const v365=read('assets/meehoa-v365.js');

const retired=[
  'assets/meehoa-hotfix-20261005.js',
  'assets/meehoa-ops-hotfix2.js',
  'assets/meehoa-runtime-fix-20261005.js',
  'assets/meehoa-v3-fix.css',
  'assets/meehoa-v3-hotfix.css',
  'assets/meehoa-prod-fix.css',
  'assets/meehoa-scroll-contract.css',
  'assets/meehoa-v363.js'
];

test('runtime architecture is explicit single-owner modules',()=>{
  assert.equal(metrics.schemaVersion,2);
  assert.equal(metrics.architecture,'single-owner-modules');
  assert.equal(metrics.cssFiles.length,7);
  assert.ok(metrics.jsFiles.length>=7);
  assert.equal(metrics.sourceRequestsBefore,metrics.cssFiles.length+metrics.jsFiles.length);
  assert.equal(metrics.runtimeRequestsAfter,2);
  assert.ok(Object.keys(ownership).length>=7);
  const declared=new Set(Object.values(ownership).flatMap(x=>x.files));
  [...metrics.cssFiles,...metrics.jsFiles].forEach(file=>assert.ok(declared.has(file),`${file} must have an owner`));
});

test('retired fix/hotfix compatibility files are physically removed',()=>{
  retired.forEach(file=>assert.equal(fs.existsSync(file),false,`${file} must stay deleted`));
  [...metrics.cssFiles,...metrics.jsFiles].forEach(file=>assert.doesNotMatch(file,/(?:fix|hotfix|runtime-fix|ops-hotfix|scroll-contract|v363)/i));
  assert.match(build,/Non-canonical runtime layer is forbidden/);
});

test('dashboard has exactly one source owner plus the latest hourly widget',()=>{
  assert.doesNotMatch(v3,/addDashboardCharts|parseStatusCounts/);
  assert.doesNotMatch(v35,/function patchDashboard|Doanh thu theo nhân viên \/ ngày/);
  assert.match(v361,/function patchDashboard/);
  assert.doesNotMatch(v361,/injectStyles|patchFit|mee-v361-charts/);
  assert.match(v365,/meeHourlySingleV365/);
});

test('payment has one latest owner',()=>{
  assert.doesNotMatch(v362,/patchSettlement|S\.page!=='settlement'/);
  assert.match(v364,/S\.page!=='payment'/);
  assert.match(v364,/mee-settlement-select-all-v364/);
});

test('copy and create confirmation remain only in latest ops runtime',()=>{
  assert.match(v365,/function buildCopyText/);
  assert.match(v365,/function textareaCopy/);
  assert.match(v365,/mee_pending_create/);
  assert.match(v365,/meehoasg-create-status/);
});

test('search fails closed outside Orders rather than exposing a dead production control',()=>{
  assert.match(v3,/var show=page==='orders'/);
  assert.doesNotMatch(v3,/page==='orders'\|\|page==='production'/);
});
