'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const {pathToFileURL}=require('node:url');

const ROOT=path.resolve(__dirname,'..');
const readerSource=fs.readFileSync(path.join(ROOT,'supabase/functions/_shared/r2-image-reader.js'),'utf8').replace(/^export /gm,'');
const coreSource=fs.readFileSync(path.join(ROOT,'supabase/functions/meehoasg-api-core/index.js'),'utf8').replace(/^import .*\n/gm,'');
const apiSource=fs.readFileSync(path.join(ROOT,'supabase/functions/meehoasg-api/index.js'),'utf8').replace(/^import .*\n/gm,'');
const deleteSource=fs.readFileSync(path.join(ROOT,'supabase/functions/meehoasg-delete-order/index.js'),'utf8');
const actionsSource=fs.readFileSync(path.join(ROOT,'supabase/functions/meehoasg-order-actions/index.ts'),'utf8');

function uuid(n){
  const hex=String(n).padStart(12,'0');
  return `11111111-2222-4333-8444-${hex}`;
}

test('Permanent R2 real SigV4 signing & reader verifies 24 samples + 24 bills across R2 and legacy Supabase',async()=>{
  const [{createR2Media},{createR2ImageReader},{privateImageIdentity}]=await Promise.all([
    import(pathToFileURL(path.join(ROOT,'supabase/functions/_shared/r2-media.js')).href),
    import(pathToFileURL(path.join(ROOT,'supabase/functions/_shared/r2-image-reader.js')).href),
    import(pathToFileURL(path.join(ROOT,'supabase/functions/_shared/operations.js')).href),
  ]);
  const sbSignCalls=[];
  const fetcher=async(url,opts={})=>{
    const u=String(url);
    sbSignCalls.push({url:u,method:opts.method||'GET'});
    const m=u.match(/\/storage\/v1\/object\/sign\/(order-images|settlement-bills)\/(.+)$/);
    if(m)return {ok:true,status:200,json:async()=>({signedURL:`/object/sign/${m[1]}/${m[2]}?token=sb-tok`})};
    return {ok:false,status:404,json:async()=>({})};
  };
  const accountId='0123456789abcdef0123456789abcdef';
  const bucket='meehoa-media-prod';
  const media=createR2Media({accountId,accessKeyId:'test-access-key',secretAccessKey:'test-secret-key',bucket,fetcher});
  const resolve=createR2ImageReader({media,source:'https://zxnfhshnavbmvdthrmrd.supabase.co',serviceKey:'svc-key',fetcher});

  const sampleRefs=[];
  const billRefs=[];
  for(let i=1;i<=12;i++){
    sampleRefs.push(`r2://${bucket}/order-images/${uuid(i)}.jpg`);
    sampleRefs.push(`supabase://order-images/${uuid(100+i)}.jpg`);
    billRefs.push(`r2://${bucket}/settlement-bills/${uuid(200+i)}.jpg`);
    billRefs.push(`supabase://settlement-bills/${uuid(300+i)}.jpg`);
  }
  assert.equal(sampleRefs.length,24);
  assert.equal(billRefs.length,24);

  const signedSamples=await Promise.all(sampleRefs.map(r=>resolve(r)));
  const signedBills=await Promise.all(billRefs.map(r=>resolve(r)));
  for(let i=0;i<sampleRefs.length;i++){
    const raw=sampleRefs[i],signed=signedSamples[i];
    assert.ok(signed,'sample '+i+' signed');
    if(raw.startsWith('r2://')){
      assert.match(signed,new RegExp(`^https://${accountId}\\.r2\\.cloudflarestorage\\.com/${bucket}/order-images/`));
      assert.match(signed,/X-Amz-Signature=[0-9a-f]+/);
      assert.match(signed,/X-Amz-Expires=3600/);
      assert.equal(privateImageIdentity(signed),privateImageIdentity(raw),'R2 signed URL maps back to stable image identity for updateOrder');
    }else{
      assert.match(signed,/^https:\/\/zxnfhshnavbmvdthrmrd\.supabase\.co\/storage\/v1\/object\/sign\/order-images\//);
      assert.equal(privateImageIdentity(signed),privateImageIdentity(raw));
    }
  }
  for(let i=0;i<billRefs.length;i++){
    const raw=billRefs[i],signed=signedBills[i];
    assert.ok(signed,'bill '+i+' signed');
    if(raw.startsWith('r2://')){
      assert.match(signed,new RegExp(`^https://${accountId}\\.r2\\.cloudflarestorage\\.com/${bucket}/settlement-bills/`));
      assert.match(signed,/X-Amz-Signature=[0-9a-f]+/);
      assert.equal(privateImageIdentity(signed),privateImageIdentity(raw));
    }else{
      assert.match(signed,/^https:\/\/zxnfhshnavbmvdthrmrd\.supabase\.co\/storage\/v1\/object\/sign\/settlement-bills\//);
      assert.equal(privateImageIdentity(signed),privateImageIdentity(raw));
    }
  }
  // Only the 24 legacy supabase:// items should hit Supabase Storage sign endpoint (0 for the 24 R2 items).
  assert.equal(sbSignCalls.length,24);

  // Cache hit on repeat reads -> 0 additional Supabase Storage calls; invalidate forces re-sign.
  await Promise.all(sampleRefs.map(r=>resolve(r)));
  assert.equal(sbSignCalls.length,24);
  resolve.invalidate(sampleRefs[1]);
  await resolve(sampleRefs[1]);
  assert.equal(sbSignCalls.length,25);
});

test('Both Core API and Fallback API resolve 20+ samples and 20+ bills (R2 + legacy Supabase) and write new uploads to R2',async()=>{
  const [{createR2Media}]=await Promise.all([
    import(pathToFileURL(path.join(ROOT,'supabase/functions/_shared/r2-media.js')).href),
  ]);
  const accountId='fedcba9876543210fedcba9876543210';
  const bucket='meehoa-media-prod';
  const jpegData='data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');

  function makeEnv(sourceCode,extraStubs={}){
    const r2Store=new Map(),sbSigns=[],r2Puts=[],r2Deletes=[];
    const vars={
      SUPABASE_URL:'https://zxnfhshnavbmvdthrmrd.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY:'svc-prod-sim',
      R2_ACCOUNT_ID:accountId,
      R2_ACCESS_KEY_ID:'prod-r2-key',
      R2_SECRET_ACCESS_KEY:'prod-r2-secret',
      R2_MEDIA_BUCKET:bucket,
      R2_TRIAL_BACKUP_ENABLED:'true',
      R2_TRIAL_START_AT:'2026-11-04T01:00:00.000Z',
    };
    const fetcher=async(url,opts={})=>{
      const u=String(url),method=opts.method||'GET';
      const parsed=new URL(u);
      if(parsed.hostname.endsWith('.r2.cloudflarestorage.com')){
        const key=parsed.pathname.replace(new RegExp(`^/${bucket}/`),'');
        if(method==='PUT'){r2Store.set(key,new Uint8Array(opts.body));r2Puts.push(key);return {ok:true,status:200,headers:{get:()=>null},text:async()=>'',json:async()=>({})};}
        if(method==='HEAD'){const b=r2Store.get(key);return b?{ok:true,status:200,headers:{get:k=>k.toLowerCase()==='content-length'?String(b.length):null}}:{ok:false,status:404,headers:{get:()=>null}};}
        if(method==='DELETE'){r2Store.delete(key);r2Deletes.push(key);return {ok:true,status:204,headers:{get:()=>null}};}
      }
      const m=parsed.pathname.match(/\/storage\/v1\/object\/sign\/(order-images|settlement-bills)\/(.+)$/);
      if(m&&method==='POST'){
        sbSigns.push(`${m[1]}/${m[2]}`);
        return {ok:true,status:200,json:async()=>({signedURL:`/object/sign/${m[1]}/${m[2]}?token=sb`}),text:async()=>'{}'};
      }
      return {ok:false,status:404,json:async()=>({}),text:async()=>''};
    };
    const ctx={
      Date,Intl,URL,TextEncoder,Request,Headers,Response,crypto:webcrypto,Uint8Array,atob,
      console:{warn(){},error(){},log(){}},
      Deno:{env:{get:k=>vars[k]||''},serve(){}},
      createR2Media:cfg=>createR2Media({...cfg,fetcher}),
      createOperationStorage:()=>({uploadImages:async()=>{throw Error('SUPABASE_UPLOAD_MUST_NOT_BE_CALLED')},discard:async()=>{}}),
      createOperationService:()=>({run:async()=>({ok:true})}),
      fetch:fetcher,
      ...extraStubs,
    };
    vm.createContext(ctx);
    vm.runInContext(readerSource+'\n'+sourceCode,ctx);
    return {ctx,r2Store,sbSigns,r2Puts,r2Deletes,eval:(e)=>vm.runInContext(e,ctx)};
  }

  const samples=[],bills=[];
  for(let i=1;i<=10;i++){
    samples.push(`r2://${bucket}/order-images/${uuid(400+i)}.jpg`);
    samples.push(`supabase://order-images/${uuid(500+i)}.jpg`);
    bills.push(`r2://${bucket}/settlement-bills/${uuid(600+i)}.jpg`);
    bills.push(`supabase://settlement-bills/${uuid(700+i)}.jpg`);
  }
  assert.equal(samples.length,20);
  assert.equal(bills.length,20);

  const core=makeEnv(coreSource);
  const coreSamples=await core.eval(`displayUrls(${JSON.stringify(samples)})`);
  const coreBills=await core.eval(`displayUrls(${JSON.stringify(bills)})`);
  assert.equal(coreSamples.length,20);
  assert.equal(coreBills.length,20);
  assert.equal(coreSamples.filter(u=>u.includes('.r2.cloudflarestorage.com/')).length,10);
  assert.equal(coreSamples.filter(u=>u.includes('/storage/v1/object/sign/order-images/')).length,10);
  assert.equal(coreBills.filter(u=>u.includes('.r2.cloudflarestorage.com/')).length,10);
  assert.equal(coreBills.filter(u=>u.includes('/storage/v1/object/sign/settlement-bills/')).length,10);
  const coreUploaded=await core.eval(`uploadEvidenceImages([{data:${JSON.stringify(jpegData)}}],'order-images')`);
  assert.match(coreUploaded[0],new RegExp(`^r2://${bucket}/order-images/`));
  assert.equal(core.r2Puts.length,1);

  const fallback=makeEnv(apiSource);
  const fbOrder=await fallback.eval(`visibleOrder({id:'MEE-FB-1',image_urls:${JSON.stringify(samples)},full_paid_bill_urls:${JSON.stringify(bills)}})`);
  assert.equal(fbOrder.image_urls.length,20);
  assert.equal(fbOrder.full_paid_bill_urls.length,20);
  assert.equal(fbOrder.image_urls.filter(u=>u.includes('.r2.cloudflarestorage.com/')).length,10);
  assert.equal(fbOrder.image_urls.filter(u=>u.includes('/storage/v1/object/sign/order-images/')).length,10);
  assert.equal(fbOrder.full_paid_bill_urls.filter(u=>u.includes('.r2.cloudflarestorage.com/')).length,10);
  assert.equal(fbOrder.full_paid_bill_urls.filter(u=>u.includes('/storage/v1/object/sign/settlement-bills/')).length,10);
  const fbUploaded=await fallback.eval(`uploadEvidenceImages([{data:${JSON.stringify(jpegData)}}],'settlement-bills')`);
  assert.match(fbUploaded[0],new RegExp(`^r2://${bucket}/settlement-bills/`));
  assert.equal(fallback.r2Puts.length,1);
});

test('Auth guards on verify_jwt=false functions (meehoasg-delete-order and meehoasg-order-actions) enforce opaque session + role/ownership',()=>{
  assert.match(deleteSource,/\^\[0-9a-f\]\{64\}\$/i);
  assert.match(deleteSource,/rest\('app_sessions'/);
  assert.match(deleteSource,/if\(!user\?\.active\)return reply\(\{ok:false,code:'AUTH_REQUIRED'/);
  assert.match(deleteSource,/if\(!\['ADMIN','SALE','THO_OPS'\]\.includes\(user\.role\)\)return reply\(\{ok:false,code:'NOT_OWNER'/);
  assert.match(deleteSource,/if\(!reason\)return reply\(\{ok:false,code:'DELETE_REASON_REQUIRED'/);
  assert.match(deleteSource,/rest\('rpc\/mee_ops_mutate'/);

  assert.match(actionsSource,/\^\[0-9a-f\]\{64\}\$/i);
  assert.match(actionsSource,/one\('app_sessions'/);
  assert.match(actionsSource,/if\(!u\?\.active\)throw Error\('AUTH_REQUIRED'\)/);
  assert.match(actionsSource,/!\['saveShipFee','submitSettlement'\]\.includes\(action\)/);
});

test('Release package includes all 3 UI V3 migrations, backfill/rollback SQL, and in-repo Go-Live Runbook',()=>{
  const buildScript=fs.readFileSync(path.join(ROOT,'scripts/build-release.cjs'),'utf8');
  assert.match(buildScript,/20261125010000_ui_v3_tag_note_soft_delete_server_filter\.sql/);
  assert.match(buildScript,/20261125020000_ui_v3_rc3_order_source_and_walkin\.sql/);
  assert.match(buildScript,/20261126010000_ui_v3_final_deletion_policy_override\.sql/);
  assert.match(buildScript,/ui-v3-schema-delta\.sql/);
  assert.match(buildScript,/docs\/UI_V3_GO_LIVE_RUNBOOK\.md/);
  assert.match(buildScript,/scripts\/legacy-deleted-orders-backfill\.sql/);
  assert.match(buildScript,/scripts\/legacy-deleted-orders-rollback\.sql/);
  assert.match(buildScript,/permanentR2:/);

  const runbook=fs.readFileSync(path.join(ROOT,'docs/UI_V3_GO_LIVE_RUNBOOK.md'),'utf8');
  assert.match(runbook,/20261125010000_ui_v3_tag_note_soft_delete_server_filter\.sql/);
  assert.match(runbook,/20261125020000_ui_v3_rc3_order_source_and_walkin\.sql/);
  assert.match(runbook,/20261126010000_ui_v3_final_deletion_policy_override\.sql/);
  assert.match(runbook,/NEVER re-enable Google Sheets Sync/);
  assert.match(runbook,/meehoasg-delete-order[\s\S]*?false/);
  assert.match(runbook,/artifacts\/rollback\/ui-v3-compatible-backend-core/);
});
