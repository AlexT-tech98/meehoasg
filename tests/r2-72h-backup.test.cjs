'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');

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

function make({now=start+1000,trial=true,reads=true,uploads=true,trialStart=new Date(start).toISOString()}={}){
  const supabase=new Map(),r2=new Map(),events=[],discarded=[];
  const vars={
    SUPABASE_URL:'https://supabase.local',
    SUPABASE_SERVICE_ROLE_KEY:'qa-only',
    R2_MEDIA_BUCKET:'meehoa-test',
    R2_ACCOUNT_ID:'a'.repeat(32),
    R2_ACCESS_KEY_ID:'qa-key',
    R2_SECRET_ACCESS_KEY:'qa-secret',
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
    signedUrl:async(method,key)=>'https://r2.local/'+method+'/'+key,
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
  vm.runInContext(coreSource,context);
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

test('72h trial: sample, preview and bill each receive R2 and same-key private Supabase backup tickets',async()=>{
 const h=make(),out=await tickets(h);
 assert.equal(out.ok,true);assert.equal(out.tickets.length,2);
 for(const t of [out.tickets[0],out.tickets[0].preview,out.tickets[1]]){
   assert.equal(t.storage,'r2');assert.equal(t.backup.storage,'supabase');
   assert.equal(t.path,t.backup.path);
   assert.ok(t.expiresAt<=start+72*3600*1000);
   assert.match(t.uploadUrl,/r2\.local\/PUT\//);
   assert.match(t.backup.uploadUrl,/supabase\.local\/storage\/v1\/object\/upload\/sign\//);
 }
 assert.equal(out.tickets[0].kind,'sample');assert.equal(out.tickets[1].kind,'bill');
});

test('trial requires signed backup evidence and verifies both stores before order commit',async()=>{
 const h=make(),out=await tickets(h);
 for(const t of [out.tickets[0],out.tickets[0].preview,out.tickets[1]]){
   const key=(t===out.tickets[1]?'settlement-bills':'order-images')+'/'+t.path;
   h.r2.set(key,jpeg);h.supabase.set(key,jpeg);
 }
 const claim=claims(out.tickets[0]),bill=claims(out.tickets[1]);
 const q={actor:'sale1',requestId:'test-request',samples:[claim],bills:[bill]};
 const result=await h.evaluate('verifyStagedUploads('+JSON.stringify(q)+')');
 assert.equal(result.samples.length,1);assert.equal(result.previews.length,1);assert.equal(result.bills.length,1);
 assert.match(result.samples[0],/^r2:\/\//);
 await assert.rejects(h.evaluate('verifyStagedUploads('+JSON.stringify({...q,samples:[{...claim,backup:undefined}]})+')'),/R2_TRIAL_BACKUP_REQUIRED/);
 h.supabase.delete('settlement-bills/'+out.tickets[1].path);
 await assert.rejects(h.evaluate('verifyStagedUploads('+JSON.stringify(q)+')'),/UPLOAD_NOT_READY/);
});

test('bad backup signature or mismatched size does not pass final verification',async()=>{
 const h=make(),out=await tickets(h,{bills:0});const t=out.tickets[0];
 for(const x of [t,t.preview]){h.r2.set('order-images/'+x.path,jpeg);h.supabase.set('order-images/'+x.path,jpeg)}
 const q={actor:'sale1',requestId:'test-request',samples:[claims(t)],bills:[]};
 await assert.rejects(h.evaluate('verifyStagedUploads('+JSON.stringify({...q,samples:[{...q.samples[0],backup:{...q.samples[0].backup,proof:'0'.repeat(64)}}]})+')'),/UPLOAD_BACKUP_CLAIM_INVALID/);
 h.supabase.set('order-images/'+t.path,new Uint8Array([1,2]));
 await assert.rejects(h.evaluate('verifyStagedUploads('+JSON.stringify(q)+')'),/R2_BACKUP_SIZE_MISMATCH/);
});

test('R2 off: trial image and bill references resolve to signed private Supabase backup URLs',async()=>{
 const h=make({reads:false,uploads:false});
 const ref='r2://meehoa-test/order-images/'+uid+'.jpg';
 const signed=await h.evaluate('signedImageUrl('+JSON.stringify(ref)+')');
 assert.match(signed,/supabase\.local\/storage\/v1\/object\/sign\/order-images\//);
 assert.equal(h.events.some(x=>x.url.includes('r2.local')),false);
 const bill='r2://meehoa-test/settlement-bills/'+uid+'.jpg';
 const sb=await h.evaluate('signedImageUrl('+JSON.stringify(bill)+')');
 assert.match(sb,/object\/sign\/settlement-bills\//);
});

test('R2 read errors or missing migrated objects fall back to signed Supabase URLs',async()=>{
 const h=make({reads:true});
 const ref='r2://meehoa-test/order-images/'+uid+'.jpg';
 const signed=await h.evaluate('signedImageUrl('+JSON.stringify(ref)+')');
 assert.match(signed,/supabase\.local/);
 const h2=make({reads:true});h2.r2.set('order-images/'+uid+'.jpg',jpeg);
 const s2=await h2.evaluate('signedImageUrl('+JSON.stringify(ref)+')');
 assert.match(s2,/^https:\/\/r2\.local\/GET\//);
});

test('after 72h no automatic R2-only switch: new tickets and direct images return to Supabase',async()=>{
 const h=make({now:start+72*3600*1000+1});
 const out=await tickets(h,{samples:0,bills:1});
 assert.equal(out.tickets[0].storage,'supabase');assert.equal(out.tickets[0].backup,undefined);
 const result=await h.evaluate("uploadEvidenceImages([{data:"+JSON.stringify(data)+"}],'settlement-bills')");
 assert.match(result[0],/^supabase:\/\//);
 const noStart=make({trialStart:''}),ticketsNoStart=await tickets(noStart,{samples:0,bills:1});
 assert.equal(ticketsNoStart.tickets[0].storage,'supabase');
});

test('direct legacy image upload also stages and checks R2+Supabase while trial active',async()=>{
 const h=make();
 const result=await h.evaluate("uploadEvidenceImages([{data:"+JSON.stringify(data)+"}],'settlement-bills')");
 assert.equal(result.length,1);
 assert.match(result[0],/^r2:\/\//);
 const key=result[0].split('meehoa-test/')[1];
 assert.ok(h.r2.has(key));assert.ok(h.supabase.has(key));
 assert.equal(h.r2.get(key).length,h.supabase.get(key).length);
});

test('browser uploads original, preview and each temporary backup without putting service credentials in UI',async()=>{
 const h=make(),out=await tickets(h);
 const front={...h.context,gas:async(name,payload)=>{assert.equal(name,'prepareOrderUploads');return out}};
 vm.createContext(front);
 vm.runInContext(browserSource,front);
 const state={requestId:'test-request',prepared:[[{data,previewData:data}],[{data}]]};
 const result=await vm.runInContext('uploadOrderEvidence',front)(state);
 assert.equal(result.samples.length,1);assert.equal(result.bills.length,1);
 assert.ok(result.samples[0].backup);assert.ok(result.samples[0].preview.backup);
 assert.ok(result.bills[0].backup);
 const expected=[out.tickets[0],out.tickets[0].preview,out.tickets[1]];
 for(const t of expected){const key=(t===out.tickets[1]?'settlement-bills':'order-images')+'/'+t.path;assert.ok(h.r2.has(key));assert.ok(h.supabase.has(key))}
 assert.ok(!browserSource.includes('SUPABASE_SERVICE_ROLE_KEY'));
});

test('without trial flag, R2 write behavior remains unchanged and no Supabase backup is minted',async()=>{
 const h=make({trial:false});const out=await tickets(h);
 assert.equal(out.tickets[0].storage,'r2');assert.equal(out.tickets[0].backup,undefined);
});

test('without R2 write flag, unchanged Supabase-only signed upload path is used',async()=>{
 const h=make({uploads:false});const out=await tickets(h);
 assert.equal(out.tickets[0].storage,'supabase');assert.equal(out.tickets[0].backup,undefined);
});
