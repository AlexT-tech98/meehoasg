// Strictly isolated Cloudflare R2 staging-only smoke. No production data/API.
'use strict';
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
const account=process.env.R2_TEST_ACCOUNT_ID;
const keyId=process.env.R2_TEST_ACCESS_KEY_ID;
const secret=process.env.R2_TEST_SECRET_ACCESS_KEY;
const bucket='meehoasg-media-staging';
const allowedAccount='1e6471cd334eaedfa609d98fa1442466';
const origin='https://ops.meehoasg.com';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9l0yEAAAAASUVORK5CYII=','base64');
if(account!==allowedAccount)throw Error('QA_ACCOUNT_MISMATCH: account ID is not the approved staging account');
if(!keyId||!secret)throw Error('QA_CREDENTIALS_REQUIRED: add limited staging-only R2 token to GitHub repository Actions secrets; never paste keys in chat');
if(png.length>1024*1024)throw Error('QA_IMAGE_TOO_LARGE');
const secureHost='https://'+account+'.r2.cloudflarestorage.com/'+bucket+'/';
const expectedPngDigest=digest(png);
const results=[];
let passed=true;
(async()=>{
 const {createR2Media}=await import('../supabase/functions/_shared/r2-media.js');
 const media=createR2Media({accountId:account,accessKeyId:keyId,secretAccessKey:secret,bucket});
 for(const kind of ['sample','bill']){
   const objectKey=media.key(kind,randomUUID()+'.png');
   let uploaded=false;
   try{
     const signedPut=await media.signedUrl('PUT',objectKey,{expiresSeconds:120,contentType:'image/png'});
     const preflight=await fetch(signedPut,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type'}});
     const allowOrigin=preflight.headers.get('access-control-allow-origin');
     const allowMethods=preflight.headers.get('access-control-allow-methods')||'';
     const allowHeaders=preflight.headers.get('access-control-allow-headers')||'';
     assert.ok(preflight.ok&&allowOrigin===origin&&allowMethods.toUpperCase().includes('PUT')&&allowHeaders.toLowerCase().includes('content-type'),'CORS policy must allow OPS PUT and Content-Type');
     results.push({kind,check:'CORS',pass:true});
     const put=await fetch(signedPut,{method:'PUT',headers:{'Content-Type':'image/png'},body:png});
     assert.ok(put.ok,'signed fake upload HTTP '+put.status);
     uploaded=true;
     results.push({kind,check:'SIGNED_PUT',pass:true});
     const unsigned=await fetch(secureHost+objectKey);
     assert.ok([401,403].includes(unsigned.status),'public unsigned read must be denied, got '+unsigned.status);
     results.push({kind,check:'PRIVATE_UNSIGNED_DENY',pass:true});
     const signedGet=await media.signedUrl('GET',objectKey,{expiresSeconds:120});
     const got=await fetch(signedGet);
     assert.ok(got.ok,'signed read HTTP '+got.status);
     assert.equal(digest(Buffer.from(await got.arrayBuffer())),expectedPngDigest,'image bytes SHA256 must match');
     results.push({kind,check:'SIGNED_GET_SHA256',pass:true});
     const shortUrl=await media.signedUrl('GET',objectKey,{expiresSeconds:1});
     const fresh=await fetch(shortUrl);
     assert.ok(fresh.ok,'fresh signed read HTTP '+fresh.status);
     await new Promise(resolve=>setTimeout(resolve,5000));
     const expired=await fetch(shortUrl,{headers:{'cache-control':'no-store'}});
     assert.ok([401,403].includes(expired.status),'expired signed URL must be denied, got '+expired.status);
     results.push({kind,check:'EXPIRED_URL_DENY',pass:true});
   }catch(error){
     passed=false;
     results.push({kind,check:'FAILED',pass:false,detail:String(error.message||error).slice(0,190).replace(/https?:\/\/\S+/g,'[URL_REDACTED]')});
   }finally{
     // Signed DELETE is attempted even if upload response failed (e.g. a timeout).
     try{
       const url=await media.signedUrl('DELETE',objectKey,{expiresSeconds:120});
       const deleted=await fetch(url,{method:'DELETE'});
       if(!deleted.ok&&deleted.status!==404){passed=false;results.push({kind,check:'CLEANUP',pass:false,detail:'HTTP '+deleted.status});}
       else results.push({kind,check:'CLEANUP',pass:true});
     }catch(_){passed=false;results.push({kind,check:'CLEANUP',pass:false});}
   }
 }
 const fs=require('node:fs'),path=require('node:path');
 const file=path.join(process.env.GITHUB_WORKSPACE||process.cwd(),'r2-staging-smoke-results.json');
 fs.writeFileSync(file,JSON.stringify({date:new Date().toISOString(),bucket,scope:'one-pixel fake PNG; staging only; no production changes',pass:passed,results},null,2)+'\n',{mode:0o600});
 for(const r of results)console.log(r.kind+' '+r.check+' '+(r.pass?'PASS':'FAIL')+(r.detail?' '+r.detail:''));
 console.log('R2_STAGING_SMOKE='+ (passed?'PASS':'FAIL'));
 if(!passed)process.exitCode=1;
})().catch(err=>{
 console.error('R2_STAGING_SMOKE=FAIL '+String(err.message||err).slice(0,180).replace(/https?:\/\/\S+/g,'[URL_REDACTED]'));
 process.exitCode=1;
});
