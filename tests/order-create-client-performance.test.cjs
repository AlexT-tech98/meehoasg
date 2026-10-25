const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('html','utf8');
const between=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));

test('create request preserves the API payload and reports upload time without a second upload',async()=>{
  const metrics=[],requests=[];
  class FakeXHR{
    constructor(){this.upload={addEventListener:(name,fn)=>{this.uploadDone=fn}};this.headers={};this.status=200;this.responseText='{"ok":true,"orderId":"MEE-1"}';requests.push(this)}
    open(method,url){this.method=method;this.url=url}
    setRequestHeader(name,value){this.headers[name]=value}
    send(body){this.body=JSON.parse(body);this.uploadDone();this.onload()}
  }
  const context={XMLHttpRequest:FakeXHR,S:{token:'session'},perfClock:()=>123,recordClientPerf:(...values)=>metrics.push(values),JSON,Object,Promise};
  vm.createContext(context);vm.runInContext(between('function gasOnce(name, p) {','function safeReadEndpoint('),context);
  const result=await context.gasOnce('createOrder',{requestId:'same-request',order:{customer:'A'}});
  assert.equal(result.orderId,'MEE-1');
  assert.equal(requests.length,1);
  assert.equal(requests[0].body.payload.requestId,'same-request');
  assert.equal(requests[0].body.payload.token,'session');
  assert.equal(requests[0].headers['Content-Type'],'application/json');
  assert.equal(metrics[0][0],'createOrder:requestUpload');
});

test('sample photos use fewer pixels while bills retain higher resolution',async()=>{
  const outputs=[];let revoked=0;
  class FakeImage{
    constructor(){this.naturalWidth=3200;this.naturalHeight=2400}
    set src(_){this.onload()}
  }
  const context={Image:FakeImage,URL:{createObjectURL:()=>'/blob',revokeObjectURL:()=>revoked++},document:{createElement:()=>({getContext:()=>({drawImage(){}}),toDataURL(type,quality){outputs.push({width:this.width,height:this.height,type,quality});return 'data:image/jpeg;base64,QQ=='}})},Promise};
  vm.createContext(context);vm.runInContext(between('function fileData(f,kind) {','function setProductionDate('),context);
  const photo=await context.fileData({type:'image/png',name:'flower.png'},'sample');
  const bill=await context.fileData({type:'image/png',name:'bill.png'},'bill');
  assert.equal(photo.mimeType,'image/jpeg');
  assert.deepEqual(outputs.map(x=>[x.width,x.height,x.quality]),[[1280,960,.74],[1600,1200,.82]]);
  assert.equal(revoked,2);
  assert.equal(bill.name,'bill.jpg');
});

test('sale telemetry contains only bounded create-order timings',async()=>{
  const source=fs.readFileSync('supabase/functions/meehoasg-api/index.js','utf8');
  const fn=source.slice(source.indexOf('async function logPerformanceBatch('),source.indexOf('async function performanceReport('));
  const writes=[];
  const context={db:async(_table,_query,_method,rows)=>writes.push(...rows),clean:v=>String(v||'').trim(),num:v=>Number(v)||0,Date,Math,Array,Set};
  vm.createContext(context);vm.runInContext(fn,context);
  const items=[{api:'getOrders',totalMs:1},{api:'createOrder:upload',totalMs:200},{api:'createOrder',totalMs:300},{api:'getPerformanceReport',totalMs:1}];
  const result=await context.logPerformanceBatch({items},{username:'sale',role:'SALE'});
  assert.equal(result.count,2);
  assert.deepEqual(writes.map(x=>x.api),['createOrder:upload','createOrder']);
});

test('direct Storage uploader sends binary JPEG, separates sample/bill, and resumes after failed network',async()=>{
 const html=fs.readFileSync('html','utf8');
 const start=html.indexOf('async function uploadOrderEvidence(state){');
 const end=html.indexOf('async function saveOrder(e,id){',start);
 assert.ok(start>0&&end>start);
 const sent=[];let prepareCalls=0,failOnce=true;
 const url='https://qa.supabase.co/storage/v1/object/upload/sign/';
 const ticket=(kind,n)=>({kind,path:'p'+n+'.jpg',expiresAt:10000,proof:'qa'+n,uploadUrl:url+kind+'/p'+n+'.jpg?token=qa'});
 const ctx={
   Promise,Uint8Array,atob,gas:async(name,payload)=>{
     assert.equal(name,'prepareOrderUploads');assert.equal(payload.requestId,'immutable-request');
     prepareCalls++;return {ok:true,tickets:[ticket('sample',0),ticket('bill',1)]};
   },fetch:async(u,o)=>{
     sent.push({url:u,method:o.method,size:o.body.length,contentType:o.headers['Content-Type']});
     if(u.includes('/bill/')&&failOnce){failOnce=false;throw Error('NetworkError');}
     return {ok:true,status:200};
   }
 };
 vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
 const state={requestId:'immutable-request',prepared:[[{data:'data:image/jpeg;base64,QQ=='}],[{data:'data:image/jpeg;base64,Qg=='}]]};
 ctx.state=state;
 await assert.rejects(vm.runInContext('uploadOrderEvidence(state)',ctx),/NetworkError/);
 assert.equal(state.complete[0],true);
 const res=await vm.runInContext('uploadOrderEvidence(state)',ctx);
 assert.equal(res.samples.length,1);assert.equal(res.bills.length,1);
 assert.equal(prepareCalls,1,'network recovery must reuse tickets');
 assert.equal(sent.filter(x=>x.url.includes('/sample/')).length,1,'successful sample cannot upload twice');
 assert.equal(sent.filter(x=>x.url.includes('/bill/')).length,2);
 assert.ok(sent.every(x=>x.method==='PUT'&&x.size===1&&x.contentType==='image/jpeg'));
});
