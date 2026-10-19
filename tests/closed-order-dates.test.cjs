const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

async function operations(){
 const source=fs.readFileSync('supabase/functions/_shared/operations.js','utf8');
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
function harness(createOperationService,receipt=null){
 const calls=[],uploads=[];
 const service=createOperationService({
  db:async (name,query,method,body)=>{
   calls.push({name,body});
   if(name==='rpc/mee_ops_lookup')return receipt;
   if(name==='rpc/mee_ops_mutate')return {ok:true,row:{id:'MEE-TEST'}};
   throw Error('Unexpected database call: '+name);
  },
  one:async()=>({sale:'sale',image_urls:[],full_paid:false}),
  uploadImages:async(files,bucket)=>{uploads.push({files,bucket});return [];},
  discardImages:async()=>{},
  sha256:async()=> 'test-fingerprint',
  newId:()=> 'MEE-TEST'
 });
 return {service,calls,uploads};
}
const actor={role:'SALE',username:'sale',display_name:'Sale'};
const order=date=>({date,customer:'Khách',flower:'Hoa tươi',time:'12:30',shipping:'Ghé lấy',flowerTotal:500000});

test('seasonal closure is limited to 2026-10-19 and 2026-10-20',async()=>{
 const {isClosedReceptionDate}=await operations();
 assert.equal(isClosedReceptionDate('2026-10-19'),true);
 assert.equal(isClosedReceptionDate('2026-10-20'),true);
 for(const day of ['2026-10-18','2026-10-21','2027-10-19','2025-10-20']){
  assert.equal(isClosedReceptionDate(day),false);
 }
});
test('server rejects each closed date before uploading or writing order data',async()=>{
 const {createOperationService}=await operations();
 for(const date of ['2026-10-19','2026-10-20']){
  const h=harness(createOperationService);
  const result=await h.service.run('createOrder',{requestId:'request-'+date,order:order(date)},actor);
  assert.equal(result.ok,false);
  assert.equal(result.code,'ORDER_DATE_CLOSED');
  assert.match(result.message,/ngưng nhận đơn/);
  assert.deepEqual(h.calls.map(x=>x.name),['rpc/mee_ops_lookup']);
  assert.equal(h.uploads.length,0);
 }
});
test('open dates may create; existing orders can be edited on closed dates',async()=>{
 const {createOperationService}=await operations();
 const created=harness(createOperationService);
 assert.equal((await created.service.run('createOrder',{requestId:'new',order:order('2026-10-21')},actor)).ok,true);
 assert.equal(created.calls.some(x=>x.name==='rpc/mee_ops_mutate'),true);
 const editing=harness(createOperationService);
 assert.equal((await editing.service.run('updateOrder',{requestId:'edit',orderId:'MEE-EXISTING',order:order('2026-10-19')},actor)).ok,true);
 assert.equal(editing.calls.some(x=>x.name==='rpc/mee_ops_mutate'),true);
});
test('an already committed request can still return its idempotency receipt',async()=>{
 const {createOperationService}=await operations();
 const receipt={ok:true,idempotent:true,orderId:'MEE-EXISTING'};
 const h=harness(createOperationService,receipt);
 const result=await h.service.run('createOrder',{requestId:'retry',order:order('2026-10-19')},actor);
 assert.deepEqual(result,receipt);
 assert.deepEqual(h.calls.map(x=>x.name),['rpc/mee_ops_lookup']);
});
