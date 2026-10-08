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
const v366=read('assets/meehoa-v366.js');

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

test('dashboard owns summary, report and hourly tracking without duplicate ops ownership',()=>{
  assert.doesNotMatch(v3,/addDashboardCharts|parseStatusCounts/);
  assert.doesNotMatch(v35,/function patchDashboard|Doanh thu theo nhân viên \/ ngày/);
  assert.match(v361,/function patchDashboard/);
  assert.match(v361,/function hourlyModel/);
  assert.match(v361,/meeHourlySingleV361/);
  assert.doesNotMatch(v361,/injectStyles|patchFit|mee-v361-charts/);
  assert.doesNotMatch(v366,/renderHourly|cleanupHourly|meeHourlySingleV365|hourlyBusy|hourlyLastAt/);
});

test('payment has one latest owner',()=>{
  assert.doesNotMatch(v362,/patchSettlement|S\.page!=='settlement'/);
  assert.match(v364,/S\.page!=='payment'/);
  assert.match(v364,/mee-settlement-select-all-v364/);
});

test('copy stays in latest ops runtime while saving belongs to base form',()=>{
  assert.match(v366,/function buildCopyText/);
  assert.match(v366,/function textareaCopy/);
  assert.doesNotMatch(v366,/mee_pending_create|meehoasg-create-status|MEEOPS7\.saveOrder=/);
  assert.match(fs.readFileSync('html','utf8'),/async function saveOrder/);
});

test('search fails closed outside Orders rather than exposing a dead production control',()=>{
  assert.match(v3,/var show=page==='orders'/);
  assert.doesNotMatch(v3,/page==='orders'\|\|page==='production'/);
});
