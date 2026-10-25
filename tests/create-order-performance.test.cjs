const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
test('uploads overlap with a bounded concurrency of three and retain input order',async()=>{
 const {createOperationStorage}=await import('../supabase/functions/_shared/storage.js');let id=0,active=0,peak=0,started=0,release=[];
 const storage=createOperationStorage({url:'https://qa',key:'qa',uuid:()=>String(++id),fetcher:async()=>{started++;peak=Math.max(peak,++active);await new Promise(r=>release.push(r));active--;return {ok:true}}});
 const pending=storage.uploadImages(Array(5).fill({data:'data:image/png;base64,YQ=='}),'order-images');await tick();assert.equal(started,3);release.splice(0).reverse().forEach(r=>r());await tick();assert.equal(started,5);release.splice(0).forEach(r=>r());const urls=await pending;assert.equal(peak,3);assert.deepEqual(urls,Array.from({length:5},(_,i)=>`supabase://order-images/${i+1}.png`));
});
test('parallel upload failure waits for late successes before deleting all attempted keys',async()=>{
 const {createOperationStorage}=await import('../supabase/functions/_shared/storage.js');let id=0,events=[],release;
 const storage=createOperationStorage({url:'https://qa',key:'qa',uuid:()=>String(++id),log(){},fetcher:async(url,args)=>{if(args.method==='DELETE'){events.push('delete');return {ok:true}}if(url.endsWith('/1.png'))throw Error('lost');await new Promise(r=>release=r);events.push('late-success');return {ok:true}}});
 const pending=storage.uploadImages(Array(2).fill({data:'data:image/png;base64,YQ=='}),'order-images');await tick();assert.deepEqual(events,[]);release();await assert.rejects(pending,/lost/);assert.deepEqual(events,['late-success','delete','delete']);
});
function core(){const context={console,TextEncoder,URL,Date,Intl,createOperationService:()=>({}),createOperationStorage:()=>({}),Deno:{env:{get:name=>name==='SUPABASE_URL'?'https://qa.supabase.co':''},serve(){}}};vm.createContext(context);vm.runInContext(fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8').replace(/^import .*\n/gm,''),context);return context;}
test('read requests omit unused exact counts while writes retain return representation',async()=>{
 const c=core(),headers=[];c.fetch=async(_url,options)=>{headers.push(options.headers);return {ok:true,text:async()=> '[]'}};
 await vm.runInContext("db('orders',{limit:'1'})",c);
 await vm.runInContext("db('orders',{},'POST',{id:'QA'})",c);
 assert.equal(headers[0].Prefer,undefined);
 assert.equal(headers[1].Prefer,'return=representation');
});
test('fresh save uses SQL committed row; duplicate receipt reloads latest row',async()=>{
 const c=core();c.result={ok:true,orderId:'QA',row:{id:'QA',status:'Chờ bó'}};c.reads=0;vm.runInContext("operations.run=async()=>result;one=async()=>{reads++;return {id:'QA',status:'Đã giao'}};saleDirectory=async()=>({});decoratedExisting=async row=>row",c);
 let r=await vm.runInContext("operationResult('createOrder',{}, {})",c);assert.equal(c.reads,0);assert.equal(r.order.status,'Chờ bó');assert.equal(r.row,undefined);
 c.result.idempotent=true;r=await vm.runInContext("operationResult('createOrder',{}, {})",c);assert.equal(c.reads,1);assert.equal(r.order.status,'Đã giao');
});
test('signed image requests overlap, retain order, and preserve existing URLs',async()=>{
 const c=core();let active=0,peak=0;c.fetch=async url=>{peak=Math.max(peak,++active);await tick();active--;return {ok:true,json:async()=>({signedURL:'/signed/'+url.split('/').pop()})}};
 c.urls=['supabase://order-images/a','https://existing/b','supabase://order-images/c','supabase://order-images/d'];const urls=await vm.runInContext('displayUrls(urls)',c);assert.equal(peak,2);assert.deepEqual(Array.from(urls),['https://qa.supabase.co/storage/v1/signed/a','https://existing/b','https://qa.supabase.co/storage/v1/signed/c','https://qa.supabase.co/storage/v1/signed/d']);
});
test('signed image cache coalesces duplicate requests and renews before expiry',async()=>{
 const c=core();let now=0,calls=0;
 c.Date=class extends Date{static now(){return now}};
 c.fetch=async()=>{calls++;await tick();return {ok:true,json:async()=>({signedURL:'/signed/token-'+calls})}};
 const key='supabase://order-images/sample.jpg';c.urls=[key,key];
 const [first,second]=await Promise.all([vm.runInContext('displayUrls(urls)',c),vm.runInContext('displayUrls(urls)',c)]);
 assert.equal(calls,1);assert.deepEqual(Array.from(first),Array.from(second));
 now=44*60*1000;
 assert.deepEqual(Array.from(await vm.runInContext('displayUrls(urls)',c)),Array.from(first));assert.equal(calls,1);
 now=46*60*1000;
 const renewed=await vm.runInContext('displayUrls(urls)',c);
 assert.equal(calls,2);assert.notEqual(renewed[0],first[0]);
});
test('expired signed image renews through its order before showing fallback',async()=>{
 const source=fs.readFileSync('html','utf8'),start=source.indexOf('function imageSrc('),end=source.indexOf('function isShop(',start);
 assert.ok(start>=0&&end>start);
 const old='https://qa.supabase.co/storage/v1/object/sign/order-images/sample.jpg?token=old';
 const fresh=old.replace('token=old','token=fresh');
 const order={id:'QA',imageUrls:[old]},S={orders:new Map([['QA',order]])};
 let calls=0;
 const c={URL,S,encodeURIComponent,gas:async(name,payload)=>{calls++;assert.equal(name,'getOrder');assert.equal(payload.orderId,'QA');return {ok:true,order:{id:'QA',imageUrls:[fresh]}}},rememberOrders:items=>items.forEach(item=>S.orders.set(item.id,item))};
 vm.createContext(c);vm.runInContext(source.slice(start,end),c);
 c.img={src:old,dataset:{},onerror:()=>{}};
 vm.runInContext('imageFallback(img)',c);await tick();
 assert.equal(calls,1);assert.equal(c.img.src,fresh);assert.equal(S.orders.get('QA').imageUrls[0],fresh);
});
test('image previews accept a fresh signed URL immediately',()=>{
 const source=fs.readFileSync('html','utf8'),start=source.indexOf('function imageSrc('),end=source.indexOf('function imageFallback',start);
 assert.ok(start>=0&&end>start);const context={URL};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const old='https://qa.supabase.co/storage/v1/object/sign/order-images/sample.jpg?token=old',fresh=old.replace('old','fresh');
 context.old=old;context.fresh=fresh;
 assert.equal(vm.runInContext('imageSrc(old,320)',context),old);
 assert.equal(vm.runInContext('imageSrc(fresh,320)',context),fresh);
 assert.equal(vm.runInContext("imageSrc('https://example.com/plain.jpg',320)",context),'https://example.com/plain.jpg');
});


test('order detail fetch overlaps independent user, settlement, sample and bill reads',async()=>{
 const c=core();c.active=0;c.peak=0;
 vm.runInContext(`
  requireUser=async()=>({username:'qa',role:'ADMIN'});
  one=async()=>({id:'QA',image_urls:['sample'],full_paid_bill_urls:['bill']});
  async function slot(){active++;peak=Math.max(active,peak);await Promise.resolve();await Promise.resolve();active--;}
  saleDirectory=async()=>{await slot();return {users:[],map:new Map()};};
  settlementMap=async()=>{await slot();return {};};
  displayUrls=async urls=>{await slot();return urls;};
  decorate=row=>({id:row.id,imageUrls:row.image_urls});
 `,c);
 const res=await vm.runInContext("fastOrder({orderId:'QA'})",c);
 assert.equal(res.ok,true);
 assert.equal(c.peak,4,'independent detail reads should not form a serial waterfall');
 assert.deepEqual(Array.from(res.order.imageUrls),['sample']);
 assert.deepEqual(Array.from(res.order.fullPaidBillUrls),['bill']);
});

test('direct upload tickets are actor/request bound, Storage verified and reject forgery',async()=>{
 const {webcrypto}=require('node:crypto');
 const c=core(),calls=[];c.crypto=webcrypto;
 c.fetch=async(url,args)=>{
  calls.push({url,method:args.method});
  if(args.method==='POST'&&url.includes('/object/upload/sign/'))
   return {ok:true,json:async()=>({url:new URL(url).pathname.replace('/storage/v1','')+'?token=qa'})};
  if(args.method==='HEAD')
   return {ok:true,headers:{get:()=>String(2048)}};
  throw Error('unexpected storage call');
 };
 vm.runInContext("requireUser=async()=>({username:'qa_sale',role:'SALE'})",c);
 const signed=await vm.runInContext("prepareOrderUploads({requestId:'abc',samples:1,bills:1})",c);
 assert.equal(signed.ok,true);assert.equal(signed.tickets.length,2);
 assert.deepEqual(Array.from(signed.tickets.map(x=>x.kind)),['sample','bill']);
 assert.ok(signed.tickets.every(x=>x.uploadUrl.includes('/storage/v1/object/upload/sign/')));
 c.claims={actor:'qa_sale',requestId:'abc',samples:[signed.tickets[0]],bills:[signed.tickets[1]]};
 const verified=await vm.runInContext('verifyStagedUploads(claims)',c);
 assert.equal(verified.samples.length,1);assert.equal(verified.bills.length,1);
 assert.match(verified.samples[0],/^supabase:\/\/order-images\//);
 const before=calls.length;
 c.claims={actor:'different_sale',requestId:'abc',samples:[signed.tickets[0]],bills:[]};
 await assert.rejects(vm.runInContext('verifyStagedUploads(claims)',c),/UPLOAD_CLAIM_INVALID/);
 assert.equal(calls.length,before,'forged claim must not request Storage');
 c.claims={actor:'qa_sale',requestId:'different-request',samples:[signed.tickets[0]],bills:[]};
 await assert.rejects(vm.runInContext('verifyStagedUploads(claims)',c),/UPLOAD_CLAIM_INVALID/);
 c.claims={actor:'qa_sale',requestId:'abc',samples:[signed.tickets[0],signed.tickets[0]],bills:[]};
 await assert.rejects(vm.runInContext('verifyStagedUploads(claims)',c),/UPLOAD_CLAIM_DUPLICATE/);
});
test('direct upload rejects a forged content length and unauthorized ticket roles',async()=>{
 const {webcrypto}=require('node:crypto');
 const c=core();c.crypto=webcrypto;
 c.fetch=async(url,args)=>{
   if(args.method==='POST')return {ok:true,json:async()=>({url:new URL(url).pathname.replace('/storage/v1','')+'?token=qa'})};
   return {ok:true,headers:{get:()=>String(6*1024*1024)}};
 };
 vm.runInContext("requireUser=async(_p,roles)=>{if(roles&&roles.indexOf('THO_OPS')<0)throw Error('Không có quyền thực hiện.');return {username:'qa_tho',role:'THO_OPS'}}",c);
 await assert.rejects(vm.runInContext("prepareOrderUploads({requestId:'abc',samples:1,bills:0})",c),/Không có quyền/);
 vm.runInContext("requireUser=async()=>({username:'qa_sale',role:'SALE'})",c);
 const signed=await vm.runInContext("prepareOrderUploads({requestId:'abc',samples:1,bills:0})",c);
 c.claims={actor:'qa_sale',requestId:'abc',samples:signed.tickets,bills:[]};
 await assert.rejects(vm.runInContext('verifyStagedUploads(claims)',c),/UPLOAD_NOT_READY/);
});
