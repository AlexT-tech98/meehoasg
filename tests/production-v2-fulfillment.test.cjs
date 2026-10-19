const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
const migration=read('supabase/migrations/20261018120000_ui_v2_fulfillment_states.sql');
const frontend=read('html');
const core=read('supabase/functions/meehoasg-api-core/index.js');
const builder=read('scripts/flatten-core-bootstrap.cjs');

test('fulfillment migration replaces canonical SQL RPC and retains settlement authority',()=>{
 assert.match(migration,/ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check/);
 assert.match(migration,/CREATE OR REPLACE FUNCTION public.mee_ops_mutate/);
 assert.match(migration,/o.status='Chờ bó' and v_status='Đã bó'/);
 assert.match(migration,/o.status='Đã bó' and v_status=case when o.shipping='Ghé lấy' then 'Chờ lấy' else 'Chờ giao' end/);
 assert.match(migration,/o.status in \('Chờ giao','Chờ lấy'\) and v_status in \('Đã bó','Đã giao'\)/);
 assert.match(migration,/o.status='Đã giao' and v_status=case when o.shipping='Ghé lấy' then 'Chờ lấy' else 'Chờ giao' end/);
 assert.match(migration,/p_action='submitSettlement'/);
 assert.match(migration,/u.role<>'ADMIN'/);
 assert.match(migration,/operation_receipts/);
 assert.match(migration,/SHIPPING_STATUS_CONFLICT/);
 assert.match(migration,/o.status in \('Chờ lấy','Chờ giao'\)/);
 assert.doesNotMatch(migration,/array_position\(array\['Chờ bó','Đã bó','Đã giao'\]/);
});

test('production lanes, order filters and accounting scopes display both readiness states',()=>{
 assert.match(frontend,/\['Chờ bó','Chờ giao','Chờ lấy','Đã giao'\]/);
 assert.match(frontend,/function readinessStatus\(o\)/);
 assert.match(frontend,/function nextStatusValue\(o\)/);
 assert.match(frontend,/function previousStatusValue\(o\)/);
 assert.match(frontend,/mee-production-selection/);
 assert.match(frontend,/data-mee-order-action="edit"/);
 assert.match(frontend,/Chờ giao/);
 assert.match(frontend,/Chờ lấy/);
 assert.match(core,/statuses:\['Chờ bó','Chờ giao','Chờ lấy','Đã giao'\]/);
 assert.match(builder,/statuses:\['Chờ bó','Chờ giao','Chờ lấy','Đã giao'\]/);
});

test('bulk production preserves per-order audit receipts and requires privileged RPC',()=>{
 assert.match(core,/name==='updateStatusBulk'/);
 assert.match(core,/operationResult\('updateStatus'/);
 assert.match(core,/requestId:bulkId\+'-'\+i/);
 assert.match(migration,/u.role not in \('ADMIN','THO_OPS'\)/);
 assert.doesNotMatch(frontend,/onclick="MEEOPS7.changeStatus\('.*','Đã giao'\)"/);
});

test('both deployed API entrypoints expose readiness statuses and overdue attention',()=>{
 const legacy=read('supabase/functions/meehoasg-api/index.js');
 const states="statuses: ['Chờ bó', 'Chờ giao', 'Chờ lấy', 'Đã giao']";
 assert.equal(legacy.split(states).length-1,2,'login and options must include both queues');
 assert.match(legacy,/\['Chờ giao', 'Chờ lấy'\]\.includes\(o\.status\)/);
 assert.match(legacy,/'Chờ giao': 0, 'Chờ lấy': 0/);
 assert.match(core,/statuses:\['Chờ bó','Chờ giao','Chờ lấy','Đã giao'\]/);
});

test('UI V2 migration is packaged as an independent deployable delta with hashed manifest',()=>{
 const build=read('scripts/build-release.cjs');
 const old=JSON.parse(read('scripts/release-migrations.json'));
 assert.ok(!old.includes('20261018120000_ui_v2_fulfillment_states.sql'),'do not replay PR39 deltas');
 assert.match(build,/files\.push\(uiV2Migration\)/);
 assert.match(build,/ui-v2-schema-delta\.sql/);
 assert.match(build,/uiV2SchemaDelta:\{path:'ui-v2-schema-delta\.sql'/);
 assert.match(build,/sha256:sha\(uiV2Delta\)/);
 assert.match(migration,/CREATE OR REPLACE FUNCTION public\.mee_ops_mutate/);
});

test('dashboard has explicit counters for all four production states',()=>{
 assert.match(core,/'Chờ bó':0,'Chờ giao':0,'Chờ lấy':0,'Đã giao':0,unsettled:0/);
 assert.match(core,/summary\[o\.status\]=\(summary\[o\.status\]\|\|0\)\+1/);
});

test('release package retains the historical five-state frontend without downgrading the backend',()=>{
 const script=read('scripts/build-release.cjs');
 assert.match(script,/const anchor='6d41af509775d33350a2c29e15bd0cbec84cee29'/);
 assert.match(script,/rollback=\['index.html','html','assets\/meehoa-core.js','assets\/meehoa-core.css','manifest.webmanifest'\]/);
 assert.match(script,/Retain upgraded production SQL, core\/legacy\/order-actions\/shared backend/);
 assert.doesNotMatch(script,/anchor='52718b2cd9311891297e4666dfeba4a72629b463',rollback/);
});
