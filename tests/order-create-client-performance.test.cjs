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
  assert.equal(metrics[0][0],'createOrder:upload');
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
