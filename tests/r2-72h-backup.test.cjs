'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');

const readerSource=fs.readFileSync('supabase/functions/_shared/r2-image-reader.js','utf8').replace(/^export /gm,'');
const coreSource=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8').replace(/^import .*\n/gm,'');
const htmlSource=fs.readFileSync('html','utf8');
const uploadBegin=htmlSource.indexOf('async function uploadOrderEvidence(state)');
const uploadEnd=htmlSource.indexOf('function reportOrderSaveFailure',uploadBegin);
assert.ok(uploadBegin>=0&&uploadEnd>uploadBegin);
const browserSource=htmlSource.slice(uploadBegin,uploadEnd);
const start=Date.parse('2026-11-04T01:00:00.000Z');
const uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const jpeg=new Uint8Array([255,216,255,217]);
const enc=Buffer.from(jpeg).toString('base64');
const data='data:image/jpeg;base64,'+enc;

function make({now=start+1000,supabaseUrl='https://supabase.local',accessKey='qa-key',trial=true,reads=false,uploads=false,trialStart=new Date(start).toISOString()}={}){
  const supabase=new Map(),r2=new Map(),events=[],discarded=[];
  const vars={
    SUPABASE_URL:supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY:'qa-only',
    R2_MEDIA_BUCKET:'meehoa-test',
    R2_ACCOUNT_ID:'a'.repeat(32),
    R2_ACCESS_KEY_ID:accessKey,
    R2_SECRET_ACCESS_KEY:accessKey?'qa-secret':'',
    R2_TRIAL_BACKUP_ENABLED:String(trial),
    R2_TRIAL_START_AT:trialStart,
    R2_READS_ENABLED:String(reads),
    R2_UPLOADS_ENABLED:String(uploads),
  };
  class Clock extends Date{static now(){return now}}
  const response=(status,body='',headers={})=>({
    ok:status>=200&&status<300,status,
    headers:{get:key=>headers[String(key).toLowerCase()]||null},
    json:async()=>body,
    text:async()=>typeof body==='string'?body:JSON.stringify(body)
  });
  const media={
    key:(kind,path)=>(kind==='sample'?'order-images':'settlement-bills')+'/'+path,
    reference:key=>'r2://meehoa-test/'+key,
    parseReference:value=>String(value).startsWith('r2://meehoa-test/')?String(value).slice('r2://meehoa-test/'.length):null,
    signedUrl:async(method,key)=>'https://r2.local/'+method+'/'+key+'?X-Amz-Signature=deadbeef',
    exists:async key=>r2.has(key),
    verifyUpload:async key=>{if(!r2.has(key))throw Error('R2_UPLOAD_NOT_READY');return r2.get(key).length},
    discard:async ref=>{const key=media.parseReference(ref);discarded.push(ref);r2.delete(key)}
  };
  const fetcher=async(url,opts={})=>{
    url=String(url);const method=opts.method||'GET';
    events.push({url,method});
    const u=new URL(url),p=u.pathname,match=p.match(/\/(order-images|settlement-bills)\/(.+)$/);
    const key=match?match[1]+'/'+match[2]:'';
    if(u.hostname==='r2.local'){
      const segment=p.match(/^\/(PUT|GET|HEAD|DELETE)\/(order-images|settlement-bills)\/(.+)$/);
      if(!segment)return response(404);
      const object=segment[2]+'/'+segment[3];
      if(method==='PUT'){r2.set(object,new Uint8Array(opts.body));return response(200)}
      if(method==='HEAD')return r2.has(object)?response(200,'',{'content-length':String(r2.get(object).length)}):response(404);
      return response(404);
    }
    if(method==='POST'&&p.includes('/object/upload/sign/'))return response(200,{url:p.replace('/storage/v1','')+'?token=qa'});
    if(method==='PUT'&&p.includes('/object/upload/sign/')){supabase.set(key,new Uint8Array(opts.body));return response(200)}
    if(method==='POST'&&p.includes('/object/sign/'))return response(200,{signedURL:p.replace('/storage/v1','')+'?token=read'});
    if(method==='POST'&&p.match(/\/object\/(order-images|settlement-bills)\//)){supabase.set(key,new Uint8Array(opts.body));return response(200)}
    if(method==='HEAD'&&p.includes('/object/authenticated/'))return supabase.has(key)?response(200,'',{'content-length':String(supabase.get(key).length)}):response(404);
    return response(404);
  };
  const context={
    Date:Clock,Intl,URL,TextEncoder,crypto:webcrypto,Uint8Array,atob,
    console:{warn(){},error(){},log(){}},
    Deno:{env:{get:k=>vars[k]||''},serve(){}},
    createR2Media:()=>media,
    createOperationStorage:()=>({uploadImages:async(files,bucket)=>files.map(()=> 'supabase://'+bucket+'/'+uid+'.jpg'),discard:async refs=>{for(const ref of refs){discarded.push(ref);const m=String(ref).match(/^supabase:\/\/(.+)$/);if(m)supabase.delete(m[1])}}}),
    createOperationService:()=>({run:async()=>({ok:true})}),
    fetch:fetcher
  };
  vm.createContext(context);
  vm.runInContext(readerSource+'\n'+coreSource,context);
  vm.runInContext("requireUser=async()=>({username:'sale1',role:'SALE',display_name:'Sale 1'})",context);
  const evaluate=expr=>vm.runInContext(expr,context);
  return {context,evaluate,media,supabase,r2,events,discarded,fetcher,response,vars,now};
}
function claims(ticket){
  const make=t=>({path:t.path,storage:t.storage,expiresAt:t.expiresAt,proof:t.proof,...(t.backup?{backup:{path:t.backup.path,storage:t.backup.storage,expiresAt:t.backup.expiresAt,proof:t.backup.proof}}:{})});
  return {...make(ticket),...(ticket.preview?{preview:make(ticket.preview)}:{})};
}
async function tickets(h,{samples=1,bills=1,requestId='test-request'}={}){
  return h.evaluate('prepareOrderUploads('+JSON.stringify({requestId,samples,bills})+')');
}

test('Permanent R2: sample, preview and bill receive R2-only tickets without Supabase trial backup',async()=>{
 const h=make({now:start+30*24*3600*1000,trial:true,reads:false,uploads:false});
 const out=await tickets(h);
 assert.equal(out.ok,true);assert.equal(out.tickets.length,2);
 for(const t of [out.tickets[0],out.tickets[0].preview,out.tickets[1]]){
   assert.equal(t.storage,'r2');
   assert.equal(t.backup,undefined);
   assert.match(t.uploadUrl,/r2\.local\/PUT\//);
 }
 assert.equal(out.tickets[0].kind,'sample');assert.equal(out.tickets[1].kind,'bill');
 assert.equal(h.events.some(x=>x.url.includes('supabase.local')),false);
});

test('Permanent R2 never reverts to Supabase after 72h or when legacy trial env vars are empty/false',async()=>{
 for(const opts of [
   {now:start+72*3600*1000+1,trial:true,trialStart:new Date(start).toISOString(),uploads:false,reads:false},
   {now:start+200*3600*1000,trial:true,trialStart:'',uploads:false,reads:false},
   {now:start+1000,trial:false,trialStart:'',uploads:false,reads:false},
 ]){
   const h=make(opts);
   const out=await tickets(h,{samples:1,bills:1});
   assert.equal(out.tickets[0].storage,'r2');
   assert.equal(out.tickets[0].backup,undefined);
   assert.equal(out.tickets[1].storage,'r2');
   const result=await h.evaluate("uploadEvidenceImages([{data:"+JSON.stringify(data)+"}],'settlement-bills')");
   assert.match(result[0],/^r2:\/\/meehoa-test\/settlement-bills\//);
   assert.equal(h.supabase.size,0);
 }
});

test('Production fails closed with R2_NOT_CONFIGURED instead of silently reverting to Supabase when R2 key missing',async()=>{
 const h=make({supabaseUrl:'https://zxnfhshnavbmvdthrmrd.supabase.co',accessKey:''});
 await assert.rejects(tickets(h,{samples:1,bills:0}),/R2_NOT_CONFIGURED/);
 await assert.rejects(h.evaluate("uploadEvidenceImages([{data:"+JSON.stringify(data)+"}],'order-images')"),/R2_NOT_CONFIGURED/);
});

test('Loopback QA without R2 keys uses local disposable Storage cleanly',async()=>{
 const h=make({supabaseUrl:'http://127.0.0.1:54321',accessKey:''});
 const out=await tickets(h,{samples:1,bills:1});
 assert.equal(out.ok,true);
 assert.equal(out.tickets[0].storage,'supabase');
 assert.equal(out.tickets[1].storage,'supabase');
});

test('verifyStagedUploads validates R2 sample, preview and bill without requiring Supabase backup',async()=>{
 const h=make(),out=await tickets(h);
 for(const t of [out.tickets[0],out.tickets[0].preview,out.tickets[1]]){
   const key=(t===out.tickets[1]?'settlement-bills':'order-images')+'/'+t.path;
   h.r2.set(key,jpeg);
 }
 const claim=claims(out.tickets[0]),bill=claims(out.tickets[1]);
 const q={actor:'sale1',requestId:'test-request',samples:[claim],bills:[bill]};
 const result=await h.evaluate('verifyStagedUploads('+JSON.stringify(q)+')');
 assert.equal(result.samples.length,1);assert.equal(result.previews.length,1);assert.equal(result.bills.length,1);
 assert.match(result.samples[0],/^r2:\/\/meehoa-test\/order-images\//);
 assert.match(result.bills[0],/^r2:\/\/meehoa-test\/settlement-bills\//);
 h.r2.delete('settlement-bills/'+out.tickets[1].path);
 await assert.rejects(h.evaluate('verifyStagedUploads('+JSON.stringify(q)+')'),/R2_UPLOAD_NOT_READY/);
});

test('R2 image reader signs r2:// directly via R2 and legacy supabase:// via Supabase Storage',async()=>{
 const h=make();
 const r2Sample='r2://meehoa-test/order-images/'+uid+'.jpg';
 const r2Bill='r2://meehoa-test/settlement-bills/'+uid+'.jpg';
 const sbSample='supabase://order-images/'+uid+'.jpg';
 const sbBill='supabase://settlement-bills/'+uid+'.jpg';
 assert.match(await h.evaluate('signedImageUrl('+JSON.stringify(r2Sample)+')'),/^https:\/\/r2\.local\/GET\/order-images\//);
 assert.match(await h.evaluate('signedImageUrl('+JSON.stringify(r2Bill)+')'),/^https:\/\/r2\.local\/GET\/settlement-bills\//);
 assert.equal(h.events.some(x=>x.url.includes('supabase.local')),false);
 assert.match(await h.evaluate('signedImageUrl('+JSON.stringify(sbSample)+')'),/supabase\.local\/storage\/v1\/object\/sign\/order-images\//);
 assert.match(await h.evaluate('signedImageUrl('+JSON.stringify(sbBill)+')'),/supabase\.local\/storage\/v1\/object\/sign\/settlement-bills\//);
});

test('browser uploads original, preview and bill directly to R2 without exposing service credentials',async()=>{
 const h=make(),out=await tickets(h);
 const front={...h.context,gas:async(name)=>{assert.equal(name,'prepareOrderUploads');return out}};
 vm.createContext(front);
 vm.runInContext(browserSource,front);
 const state={requestId:'test-request',prepared:[[{data,previewData:data}],[{data}]]};
 const result=await vm.runInContext('uploadOrderEvidence',front)(state);
 assert.equal(result.samples.length,1);assert.equal(result.bills.length,1);
 assert.equal(result.samples[0].storage,'r2');assert.equal(result.samples[0].backup,undefined);
 assert.equal(result.bills[0].storage,'r2');assert.equal(result.bills[0].backup,undefined);
 for(const t of [out.tickets[0],out.tickets[0].preview,out.tickets[1]]){
   const key=(t===out.tickets[1]?'settlement-bills':'order-images')+'/'+t.path;
   assert.ok(h.r2.has(key));
   assert.equal(h.supabase.has(key),false);
 }
 assert.ok(!browserSource.includes('SUPABASE_SERVICE_ROLE_KEY'));
});
