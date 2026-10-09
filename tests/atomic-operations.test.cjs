const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
let db,api,seq=0;
const user={username:'sale1',display_name:'Sale 1',role:'SALE'},admin={username:'admin',display_name:'Admin',role:'ADMIN'};
const base=()=>({customer:'Khách test',phone:'0900000000',date:'2026-10-08',time:'10:00',flower:'Tulip',flowerTotal:500000,shipping:'Ghé lấy',payment:'Chưa thanh toán',card:false,banner:false,shipFeeActive:'0'});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function rpc(action,input,{actor='sale1',key='req-'+(++seq),fingerprint=hash(key)}={}){
 return (await db.query('select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as result',[actor,key,action,fingerprint,JSON.stringify(input)])).rows[0].result;
}
async function create(overrides={},options={}){
 const order=api.normalizeOperationOrder({...base(),...overrides},user);
 return rpc('createOrder',{newOrderId:'ORDER-'+(++seq),order,fullPaidRequested:false,newImageUrls:[],newBillUrls:[],...options.input},options);
}
async function current(id){return (await db.query('select to_jsonb(o) as row from public.orders o where id=$1',[id])).rows[0]?.row}
async function edit(row,overrides={},extras={},opts={}){
 const d={...base(),customer:row.customer,flower:row.flower,note:row.note,flowerTotal:row.flower_total,shipping:row.shipping,shipFeeActive:row.ship_confirmed?'1':'0',shipFee:row.ship_fee,...overrides};
 const order=api.normalizeOperationOrder(d,user,row);order.image_urls=row.image_urls;
 return rpc('updateOrder',{orderId:row.id,expectedUpdatedAt:row.updated_at,order,fullPaidRequested:row.full_paid,newBillUrls:[],newImageUrls:[],...extras},opts);
}
before(async()=>{
 api=await import('../supabase/functions/_shared/operations.js');if(process.env.AUDIT_DATABASE_URL){const {Pool}=require('pg');const pool=new Pool({connectionString:process.env.AUDIT_DATABASE_URL,max:4});db={query:(...args)=>pool.query(...args),exec:sql=>pool.query(sql),close:()=>pool.end()};}else db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);');
 await db.exec(fs.readFileSync('supabase/schema.sql','utf8'));
 for(const f of fs.readdirSync('supabase/migrations').sort())await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'));
 await db.exec("insert into app_users(username,password_hash,display_name,role) values ('admin','test','Admin','ADMIN'),('sale1','test','Sale 1','SALE'),('sale2','test','Sale 2','SALE'),('tho','test','Thợ','THO_OPS');");
});
after(async()=>{await db.close()});
beforeEach(async()=>{await db.exec('truncate operation_receipts,settlement_requests,orders,activity_log,deleted_orders,app_sessions restart identity cascade;update app_users set active=true;')});
test('normal order is committed with accessories, shipping author and audit together',async()=>{
 const r=await create({card:true,cardQty:2,cardText:'Chúc mừng',shipping:'Shop book ship',shipFeeActive:'1',shipFee:45000});
 assert.equal(r.ok,true);assert.equal(r.row.card_qty,2);assert.equal(Number(r.row.ship_fee),45000);assert.equal(r.row.ship_fee_updated_by,'sale1');
 assert.equal((await db.query('select count(*)::int as n from activity_log')).rows[0].n,1);
});
test('two different bouquets with the old duplicate signature remain two orders',async()=>{
 const a=await create({flower:'Tulip'}),b=await create({flower:'Hồng Ecuador'});assert.equal(a.ok,true);assert.equal(b.ok,true);assert.notEqual(a.orderId,b.orderId);
 assert.equal((await db.query('select count(*)::int as n from orders')).rows[0].n,2);
});
test('lost-response retry returns one receipt without mutating the order',async()=>{
 const key='same-create',a=await create({}, {key}),b=await create({}, {key});assert.equal(b.ok,true);assert.equal(b.idempotent,true);assert.equal(a.orderId,b.orderId);
 assert.equal((await db.query('select count(*)::int as n from orders')).rows[0].n,1);
});
test('changed content with a committed key is rejected',async()=>{
 await create({}, {key:'same',fingerprint:hash('a')});const r=await create({flower:'Other'},{key:'same',fingerprint:hash('b')});assert.equal(r.code,'REQUEST_CHANGED');
});
test('another actor cannot reuse request ID to modify an existing order',async()=>{
 const a=await create({}, {key:'shared-key'});const r=await create({card:true,cardQty:9,cardText:'Other'},{key:'shared-key',actor:'sale2'});assert.equal(r.code,'LEGACY_REQUEST_EXISTS');assert.equal((await current(a.orderId)).card_qty,0);
});
test('owner and optimistic timestamp are checked inside the transaction',async()=>{
 const a=await create();const blocked=await edit(a.row,{note:'wrong'},{},{actor:'sale2'});assert.equal(blocked.code,'NOT_OWNER');
 const b=await edit(a.row,{note:'A new'});assert.equal(b.ok,true);const c=await edit(a.row,{flower:'B new'});assert.equal(c.code,'ORDER_CONFLICT');assert.equal((await current(a.orderId)).note,'A new');
});
test('database refuses invalid time, shipping and negative money',async()=>{
 for(const patch of [{order_time:'99:99'},{shipping:'INVALID'},{charm_fee:-1},{vat:-1},{flower_total:-1}]){
 const order={...api.normalizeOperationOrder(base(),user),...patch};const r=await rpc('createOrder',{newOrderId:'bad-'+(++seq),order,newBillUrls:[]});assert.equal(r.code,'ORDER_INPUT_INVALID');}
 assert.equal((await db.query('select count(*)::int as n from orders')).rows[0].n,0);
});
test('edge validator rejects malformed money, dates and out-of-range card counts',()=>{
 for(const patch of [{flowerTotal:'abc'},{time:'99:99'},{date:'2026-02-30'},{charmFee:-1},{card:true,cardQty:100,cardText:'Hello'}])assert.throws(()=>api.normalizeOperationOrder({...base(),...patch},user));
 assert.equal(api.operationMoney('1.500.000'),1500000);assert.equal(api.operationMoney('1.500.000,50'),1500000.5);
});
test('Full Paid commits evidence and the exact 645000 total with ship and 2 cards',async()=>{
 const r=await create({card:true,cardQty:2,cardText:'Hi',banner:true,bannerText:'Hi',charmFee:15000,paperFee:20000,vat:10000,shipping:'Shop book ship',shipFeeActive:'1',shipFee:45000},{input:{fullPaidRequested:true,newBillUrls:['supabase://settlement-bills/bill.jpg'],order:{...api.normalizeOperationOrder({...base(),card:true,cardQty:2,cardText:'Hi',banner:true,bannerText:'Hi',charmFee:15000,paperFee:20000,vat:10000,shipping:'Shop book ship',shipFeeActive:'1',shipFee:45000},user),image_urls:['supabase://order-images/sample.jpg']}}});
 assert.equal(r.ok,true);assert.equal(r.row.full_paid,true);assert.equal(Number(r.row.full_paid_total),645000);assert.equal(r.row.full_paid_bill_urls.length,1);
});
test('Full Paid missing evidence leaves no partial order',async()=>{
 const r=await create({}, {input:{fullPaidRequested:true}});assert.equal(r.code,'FULL_PAID_EVIDENCE_REQUIRED');assert.equal((await db.query('select count(*)::int as n from orders')).rows[0].n,0);
});
test('increase invalidates Full Paid, preserves collected amount, new bill can reconfirm',async()=>{
 const order=api.normalizeOperationOrder(base(),user);order.image_urls=['supabase://order-images/sample.jpg'];const a=await create({}, {input:{order,fullPaidRequested:true,newBillUrls:['supabase://settlement-bills/bill.jpg']}});
 const b=await edit(a.row,{flowerTotal:600000});assert.equal(b.ok,true);assert.equal(b.row.full_paid,false);assert.match(b.row.payment,/500000/);
 const c=await edit(b.row,{}, {fullPaidRequested:true,newBillUrls:['supabase://settlement-bills/new.jpg']});assert.equal(c.row.full_paid,true);assert.equal(Number(c.row.full_paid_total),600000);
});
test('invalid retained image cannot be attached to another order',async()=>{
 const a=await create();const r=await edit(a.row,{}, {order:{...api.normalizeOperationOrder(base(),user),image_urls:['supabase://order-images/foreign.jpg']}});assert.equal(r.code,'IMAGE_INVALID');
});
test('failure in final audit rolls back order, Full Paid and receipt',async()=>{
 await db.exec("create function test_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'TEST_AUDIT_FAILURE'; end $$; create trigger test_fail before insert on activity_log for each row execute function test_fail_audit();");
 try{await assert.rejects(()=>create(),/TEST_AUDIT_FAILURE/);assert.equal((await db.query('select count(*)::int as n from orders')).rows[0].n,0);assert.equal((await db.query('select count(*)::int as n from operation_receipts')).rows[0].n,0);}
 finally{await db.exec('drop trigger test_fail on activity_log;drop function test_fail_audit();')}
});
async function delivered(){const a=await create({shipping:'Shop book ship',shipFeeActive:'1',shipFee:45000});await db.query("update orders set status='Đã giao' where id=$1",[a.orderId]);return current(a.orderId)}
async function submit(row,key){return rpc('submitSettlement',{orderId:row.id,expectedUpdatedAt:row.updated_at,newSettlementId:'SET-'+(++seq),newBillUrls:['supabase://settlement-bills/bill.jpg']},{key:key||'submit-'+(++seq)})}
test('submission uses canonical ship total and cannot have a second pending request',async()=>{
 const row=await delivered(),a=await submit(row,'submit-key'),retry=await submit(row,'submit-key');assert.equal(a.ok,true);assert.equal(Number(a.requiredAmount),545000);assert.equal(retry.idempotent,true);
 const b=await submit(await current(row.id));assert.equal(b.code,'SETTLEMENT_EXISTS');assert.equal((await db.query('select count(*)::int as n from settlement_requests')).rows[0].n,1);
});
test('sale cannot change another sale shipping on any RPC path',async()=>{
 const row=await delivered();const r=await rpc('saveShipFee',{orderId:row.id,expectedUpdatedAt:row.updated_at,shipFee:1},{actor:'sale2'});assert.equal(r.code,'NOT_OWNER');assert.equal(Number((await current(row.id)).ship_fee),45000);
});
test('review commits APPROVED, settled, audit and receipt atomically and retries safely',async()=>{
 const row=await delivered(),a=await submit(row);const r=await rpc('reviewSettlement',{settlementId:a.requestId,decision:'APPROVED'},{actor:'admin',key:'review-key'});assert.equal(r.ok,true);assert.equal(r.row.settled,true);
 const retry=await rpc('reviewSettlement',{settlementId:a.requestId,decision:'APPROVED'},{actor:'admin',key:'review-key'});assert.equal(retry.idempotent,true);
 assert.equal((await db.query('select status from settlement_requests')).rows[0].status,'APPROVED');
});
test('failure after request approval rolls back BOTH finance tables',async()=>{
 const row=await delivered(),a=await submit(row);
 await db.exec("create function test_fail_settled() returns trigger language plpgsql as $$ begin if new.settled then raise exception 'TEST_SETTLED_FAILURE'; end if;return new;end $$;create trigger test_fail before update on orders for each row execute function test_fail_settled();");
 try{await assert.rejects(()=>rpc('reviewSettlement',{settlementId:a.requestId,decision:'APPROVED'},{actor:'admin'}),/TEST_SETTLED_FAILURE/);assert.equal((await db.query('select status from settlement_requests')).rows[0].status,'PENDING');assert.equal((await current(row.id)).settled,false);}
 finally{await db.exec('drop trigger test_fail on orders;drop function test_fail_settled();')}
});
test('already APPROVED historical inconsistency is repaired only by admin approval',async()=>{
 const row=await delivered(),a=await submit(row);await db.query("update settlement_requests set status='APPROVED' where id=$1",[a.requestId]);const r=await rpc('reviewSettlement',{settlementId:a.requestId,decision:'APPROVED'},{actor:'admin'});assert.equal(r.row.settled,true);
});
test('rejection unlocks the order but opposite repeated review cannot change outcome',async()=>{
 const row=await delivered(),a=await submit(row);const r=await rpc('reviewSettlement',{settlementId:a.requestId,decision:'REJECTED',reason:'Bill sai'},{actor:'admin'});assert.equal(r.ok,true);assert.equal(r.row.settled,false);
 const conflict=await rpc('reviewSettlement',{settlementId:a.requestId,decision:'APPROVED'},{actor:'admin'});assert.equal(conflict.code,'REVIEW_CONFLICT');assert.equal((await edit(await current(row.id),{note:'Corrected'})).ok,true);
});
test('locked orders cannot be edited or have fees changed',async()=>{
 const row=await delivered();await submit(row);const n=await current(row.id);assert.equal((await edit(n,{note:'wrong'})).code,'ORDER_LOCKED');assert.equal((await rpc('saveShipFee',{orderId:n.id,expectedUpdatedAt:n.updated_at,shipFee:1})).code,'ORDER_LOCKED');
});
test('RPC execution is unavailable to anon/authenticated roles',async()=>{
 await db.exec('set role anon;');try{await assert.rejects(()=>db.query("select public.mee_ops_mutate('sale1','x','createOrder',$1,'{}')",[hash('x')]),/permission denied/);}finally{await db.exec('reset role;')}
});
test('receipt is returned before uploads after an ambiguous edge response',async()=>{
 let uploads=0,mutationCalls=0,receipt=null;
 const service=api.createOperationService({db:async(name,q,m,body)=>{if(name==='rpc/mee_ops_lookup')return receipt;mutationCalls++;receipt={ok:true,orderId:'ONE'};throw Error('Lost response after commit');},one:async()=>null,sha256:async s=>hash(s),newId:()=> 'ONE',uploadImages:async()=>{uploads++;return ['supabase://order-images/a.jpg']}});
 const payload={requestId:'same',order:{...base(),imageFiles:[{data:'test'}]}};await assert.rejects(()=>service.run('createOrder',payload,user),/Lost response/);const r=await service.run('createOrder',payload,user);assert.equal(r.orderId,'ONE');assert.equal(uploads,2);assert.equal(mutationCalls,1);
});

test('missing DB fields cannot bypass boundary validation through SQL NULL semantics',async()=>{
 for(const field of ['order_time','shipping','card','banner','ship_confirmed']){const order={...api.normalizeOperationOrder(base(),user),[field]:null};const r=await rpc('createOrder',{newOrderId:'bad-'+(++seq),order,newBillUrls:[]});assert.equal(r.code,'ORDER_INPUT_INVALID');}
 const order={...api.normalizeOperationOrder({...base(),card:true,cardQty:1,cardText:'Hi'},user),card_qty:null};assert.equal((await rpc('createOrder',{newOrderId:'bad-'+(++seq),order,newBillUrls:[]})).code,'ORDER_INPUT_INVALID');
});

// These tests require independent PostgreSQL connections; PGlite has one session.
test('two real PostgreSQL sessions retry the same creation with exactly one order and audit',{skip:!process.env.AUDIT_DATABASE_URL},async()=>{
 const [a,b]=await Promise.all([create({}, {key:'concurrent-key'}),create({}, {key:'concurrent-key'})]);
 assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(a.orderId,b.orderId);assert.equal(a.idempotent===true||b.idempotent===true,true);
 assert.equal((await db.query('select count(*)::int as n from orders')).rows[0].n,1);assert.equal((await db.query('select count(*)::int as n from activity_log')).rows[0].n,1);
});
test('two real PostgreSQL sessions edit a stale snapshot with exactly one winner',{skip:!process.env.AUDIT_DATABASE_URL},async()=>{
 const a=await create(),results=await Promise.all([edit(a.row,{note:'Session A'}),edit(a.row,{flower:'Session B'})]);
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.code==='ORDER_CONFLICT').length,1);
 const row=await current(a.orderId);assert.equal(row.note==='Session A'||row.flower==='Session B',true);
 assert.equal(row.note==='Session A'&&row.flower==='Session B',false);
});
test('two real PostgreSQL sessions submit settlement with exactly one pending request',{skip:!process.env.AUDIT_DATABASE_URL},async()=>{
 const row=await delivered(),results=await Promise.all([submit(row),submit(row)]);
 assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.code==='ORDER_CONFLICT').length,1);
 assert.equal((await db.query('select count(*)::int as n from settlement_requests')).rows[0].n,1);
});

async function queueDelete(row,key='delete-'+(++seq),actor='admin'){return rpc('deleteOrder',{orderId:row.id,expectedUpdatedAt:row.updated_at},{key,actor})}
async function statusFor(actor,key,{expired=false}={}){const token=hash('session-'+actor);await db.query("insert into app_sessions(token_hash,username,expires_at) values($1,$2,now()+$3::interval) on conflict(token_hash) do update set expires_at=excluded.expires_at",[token,actor,expired?'-1 hour':'1 hour']);return (await db.query('select mee_create_status($1,$2) as r',[token,key])).rows[0].r}
test('admin delete queues exactly one marker, receipt and audit; retry survives archive',async()=>{
 const a=await create({}, {key:'created'}),r=await queueDelete(a.row,'delete-one');assert.equal(r.ok,true);assert.equal(r.row.delete_after_sheet_sync,true);assert.equal(r.row.needs_sheet_sync,true);assert.match(r.row.customer,/^\[ĐÃ XÓA\] /);assert.match(r.row.note,/\n|ĐÃ XÓA TRÊN OPS/);
 const retry=await queueDelete(a.row,'delete-one');assert.equal(retry.idempotent,true);assert.equal((await db.query("select count(*)::int n from activity_log where action='deleteOrder'")).rows[0].n,1);
 await db.query('update orders set needs_sheet_sync=false,sheet_synced_at=now() where id=$1',[a.orderId]);assert.equal(await current(a.orderId),undefined);
 assert.equal((await db.query('select snapshot from deleted_orders where id=$1',[a.orderId])).rows[0].snapshot.delete_requested_by,'admin');
 assert.equal((await queueDelete(a.row,'delete-one')).idempotent,true);const status=await statusFor('sale1','created');assert.equal(status.found,true);assert.equal(status.archived,true);assert.equal(status.order.id,a.orderId);
});
test('sale, inactive admin and stale snapshot cannot queue deletion',async()=>{
 const a=await create();assert.equal((await queueDelete(a.row,undefined,'sale1')).code,'NOT_OWNER');
 await db.query("update app_users set active=false where username='admin'");assert.equal((await queueDelete(a.row)).code,'AUTH_REQUIRED');await db.query("update app_users set active=true where username='admin'");
 await edit(a.row,{note:'updated'});assert.equal((await queueDelete(a.row)).code,'ORDER_CONFLICT');assert.equal((await current(a.orderId)).delete_after_sheet_sync,false);
});
test('settled or pending settlement blocks deletion with no partial marker',async()=>{
 const row=await delivered(),req=await submit(row);let n=await current(row.id);assert.equal((await queueDelete(n)).code,'ORDER_LOCKED');assert.equal((await current(row.id)).delete_after_sheet_sync,false);
 await rpc('reviewSettlement',{settlementId:req.requestId,decision:'APPROVED'},{actor:'admin'});n=await current(row.id);assert.equal((await queueDelete(n)).code,'ORDER_LOCKED');
});
test('queued deletion blocks canonical edits and settlement, including direct legacy writes',async()=>{
 const row=await delivered(),q=await queueDelete(row);assert.equal(q.ok,true);assert.equal((await submit(q.row)).code,'ORDER_DELETING');assert.equal((await edit(q.row,{note:'unexpected'})).code,'ORDER_DELETING');
 await assert.rejects(()=>db.query("insert into settlement_requests(id,order_id,status) values('legacy',$1,'PENDING')",[row.id]),/ORDER_DELETING/);
 await assert.rejects(()=>db.query("update orders set settled=true where id=$1",[row.id]),/ORDER_DELETING/);
 assert.equal((await queueDelete(q.row,'another-key')).idempotent,true);assert.equal((await db.query("select count(*)::int n from activity_log where action='deleteOrder'")).rows[0].n,1);
});
test('audit failure rolls back delete marker and leaves no delete receipt',async()=>{
 const a=await create();await db.exec("create function test_delete_fail() returns trigger language plpgsql as $$begin if new.action='deleteOrder' then raise exception 'TEST_DELETE_AUDIT';end if;return new;end$$;create trigger test_delete_fail before insert on activity_log for each row execute function test_delete_fail();");
 try{await assert.rejects(()=>queueDelete(a.row,'failed-delete'),/TEST_DELETE_AUDIT/);assert.equal((await current(a.orderId)).delete_after_sheet_sync,false);assert.equal((await db.query("select count(*)::int n from operation_receipts where action='deleteOrder'")).rows[0].n,0);}finally{await db.exec('drop trigger test_delete_fail on activity_log;drop function test_delete_fail();')}
});
test('create-status rejects inactive and expired sessions before returning customer data',async()=>{
 await create({}, {key:'mine'});assert.equal((await statusFor('sale1','mine')).found,true);
 await db.query("update app_users set active=false where username='sale1'");const locked=await statusFor('sale1','mine');assert.equal(locked.code,'AUTH_REQUIRED');assert.equal('order' in locked,false);
 await db.query("update app_users set active=true where username='sale1'");assert.equal((await statusFor('sale1','mine',{expired:true})).code,'AUTH_REQUIRED');
});
test('create-status scopes receipts to creator; admin may investigate; unknown key is not found',async()=>{
 const a=await create({}, {key:'mine'});const foreign=await statusFor('sale2','mine');assert.equal(foreign.code,'NOT_OWNER');assert.equal('order' in foreign,false);
 assert.equal((await statusFor('admin','mine')).order.id,a.orderId);assert.equal((await statusFor('sale1','unknown')).found,false);
 await db.exec("delete from operation_receipts;update orders set sale='sale2';");assert.equal((await statusFor('sale1','mine')).found,true);assert.equal((await statusFor('sale2','mine')).code,'NOT_OWNER');
});
test('new status RPC is service-only',async()=>{for(const role of ['anon','authenticated']){await db.exec('set role '+role);try{await assert.rejects(()=>db.query("select mee_create_status($1,'x')",[hash('x')]),/permission denied/);}finally{await db.exec('reset role')}}});
test('concurrent delete versus settlement has exactly one winner and never queues a payable order',{skip:!process.env.AUDIT_DATABASE_URL},async()=>{
 const row=await delivered(),results=await Promise.all([queueDelete(row),submit(row)]);assert.equal(results.filter(r=>r.ok).length,1);
 const n=await current(row.id),count=(await db.query('select count(*)::int n from settlement_requests where order_id=$1',[row.id])).rows[0].n;
 assert.equal(n.delete_after_sheet_sync?count===0:count===1,true);
});
test('concurrent delete retries have one marker and audit across real sessions',{skip:!process.env.AUDIT_DATABASE_URL},async()=>{
 const a=await create(),results=await Promise.all([queueDelete(a.row,'double-delete'),queueDelete(a.row,'double-delete')]);assert.ok(results.every(r=>r.ok));assert.ok(results.some(r=>r.idempotent));assert.equal((await db.query("select count(*)::int n from activity_log where action='deleteOrder'")).rows[0].n,1);
});
test('a demoted admin cannot recover an old delete receipt',async()=>{
 const a=await create();await queueDelete(a.row,'old-delete');await db.query("update app_users set role='SALE' where username='admin'");
 try{assert.equal((await queueDelete(a.row,'old-delete')).code,'NOT_OWNER');}finally{await db.query("update app_users set role='ADMIN' where username='admin'")}
});
test('direct legacy settlement racing delete also has exactly one winner',{skip:!process.env.AUDIT_DATABASE_URL},async()=>{
 const row=await delivered(),results=await Promise.allSettled([queueDelete(row),db.query("insert into settlement_requests(id,order_id,status) values('legacy-race',$1,'PENDING')",[row.id])]);
 assert.equal(results[0].status,'fulfilled');const deleted=results[0].value.ok===true,inserted=results[1].status==='fulfilled';assert.notEqual(deleted,inserted);
 if(!inserted)assert.match(results[1].reason.message,/ORDER_DELETING/);
 const n=await current(row.id),count=(await db.query('select count(*)::int n from settlement_requests where order_id=$1',[row.id])).rows[0].n;assert.equal(n.delete_after_sheet_sync?count===0:count===1,true);
});
