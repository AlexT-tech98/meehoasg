'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('supabase/functions/_shared/operations.js','utf8').replace(/^export /gm,'');
const {privateImageIdentity,createOperationService}=vm.runInNewContext(source+'\n;({privateImageIdentity,createOperationService})',{URL,console});
const original='supabase://order-images/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg';
const different='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg';
const signed='https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com/meehoasg-media/order-images/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=abcdef';
const supabaseSigned='https://example.supabase.co/storage/v1/object/sign/order-images/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg?token=opaque';
const order={customer:'QA',flower:'Hoa tươi',date:'2026-11-04',time:'16:30',shipping:'Shop book ship',flowerTotal:'350000',payment:'Đã thanh toán đủ tiền hoa',imageUrls:[signed]};
const current={id:'MEE-QA',image_urls:[original],sale:'sale1'};
const user={role:'SALE',username:'sale1',display_name:'Sale 1'};
function service(){
 let mutation=null,calls=0;
 const instance=createOperationService({
  one:async()=>current,
  db:async(table,query,method,body)=>{
   if(table==='rpc/mee_ops_lookup')return null;
   if(table==='rpc/mee_ops_mutate'){calls++;mutation=body;return {ok:true,orderId:'MEE-QA',row:current};}
   throw Error('Unexpected database operation: '+table);
  },
  uploadImages:async()=>[],
  sha256:async()=> 'f'.repeat(64),
  newId:()=> 'MEE-NEW',
 });
 return {instance,mutation:()=>mutation,calls:()=>calls};
}
test('R2 signed image equals existing private Supabase object (read-only R2 migration)',()=>{
 assert.equal(privateImageIdentity(signed),privateImageIdentity(original));
 assert.equal(privateImageIdentity(supabaseSigned),privateImageIdentity(original));
});
test('R2 private-reference and R2 signed URL use same identity as current order image',()=>{
 assert.equal(privateImageIdentity('r2://meehoasg-media/order-images/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg'),privateImageIdentity(signed));
});
test('updateOrder retains existing photo with R2-read presigned URL',async()=>{
 const s=service();
 const saved=await s.instance.run('updateOrder',{requestId:'qa-1',orderId:'MEE-QA',order},user);
 assert.equal(saved.ok,true);
 assert.equal(s.calls(),1);
 assert.deepEqual(Array.from(s.mutation().p_input.order.image_urls),[original]);
});
test('image from a different order is still forbidden',async()=>{
 const s=service();
 const invalid=signed.replace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg',different);
 const saved=await s.instance.run('updateOrder',{requestId:'qa-2',orderId:'MEE-QA',order:{...order,imageUrls:[invalid]}},user);
 assert.equal(saved.ok,false);
 assert.equal(saved.code,'IMAGE_INVALID');
 assert.equal(s.calls(),0);
});
test('untrusted host or unsigned R2 object cannot impersonate a retained image',async()=>{
 const invalid=[signed.replace('.r2.cloudflarestorage.com','.evil.example'),signed.replace('X-Amz-Signature','No-Signature')];
 for(const imageUrl of invalid){
  const s=service();
  const saved=await s.instance.run('updateOrder',{requestId:'qa-invalid',orderId:'MEE-QA',order:{...order,imageUrls:[imageUrl]}},user);
  assert.equal(saved.ok,false);
  assert.equal(saved.code,'IMAGE_INVALID');
  assert.equal(s.calls(),0);
 }
});
test('changing read URL format does not change order authorization rules',async()=>{
 const s=service();
 const outsider={...user,username:'different',display_name:'Different'};
 const saved=await s.instance.run('updateOrder',{requestId:'qa-not-owner',orderId:'MEE-QA',order},outsider);
 assert.equal(saved.ok,false);
 assert.equal(saved.code,'NOT_OWNER');
 assert.equal(s.calls(),0);
});
