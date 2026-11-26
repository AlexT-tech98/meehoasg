import {createOperationStorage} from '../_shared/storage.js';
import {createOperationService} from '../_shared/operations.js';
import {createR2Media} from '../_shared/r2-media.js';
const BUILD='2026.11.26-order-actions-r2-permanent';
const SUPABASE_URL=Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const IS_LOOPBACK_QA=/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(SUPABASE_URL||'');
const R2_UPLOADS_ENABLED=true;
const r2Media=R2_UPLOADS_ENABLED&&Deno.env.get('R2_ACCESS_KEY_ID')
  ? createR2Media({
      accountId:Deno.env.get('R2_ACCOUNT_ID'),
      accessKeyId:Deno.env.get('R2_ACCESS_KEY_ID'),
      secretAccessKey:Deno.env.get('R2_SECRET_ACCESS_KEY'),
      bucket:Deno.env.get('R2_MEDIA_BUCKET'),
      endpointUrl:Deno.env.get('R2_ENDPOINT_URL')||'',
    })
  : null;
// Permanent R2 writes for settlement bills: never reverts to Supabase Storage on Production.
function r2WriteEnabled(){return !(IS_LOOPBACK_QA&&!r2Media)}
function r2BackupEnabled(){return false}
function clean(v:unknown){return String(v??'').trim()}
async function sha256(text:string){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('')}
function newId(prefix:string){return prefix+'-'+crypto.randomUUID().replaceAll('-','').slice(0,16).toUpperCase()}
async function db(table:string,query:Record<string,string>={},method='GET',body?:unknown){
  const url=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const [k,v] of Object.entries(query))url.searchParams.set(k,v);
  const r=await fetch(url,{method,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json',Prefer:'return=representation'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!r.ok)throw Error(`DB ${r.status}`);const text=await r.text();return text?JSON.parse(text):null;
}
async function one(table:string,query:Record<string,string>){return (await db(table,{...query,limit:'1'}))[0]||null}
async function requireUser(raw:string){
  if(!/^[0-9a-f]{64}$/i.test(raw))throw Error('AUTH_REQUIRED');
  const s=await one('app_sessions',{token_hash:'eq.'+await sha256(raw)});
  if(!s||Date.parse(s.expires_at)<=Date.now())throw Error('AUTH_REQUIRED');
  const u=await one('app_users',{username:'eq.'+s.username});if(!u?.active)throw Error('AUTH_REQUIRED');return u;
}
const operationStorage=createOperationStorage({url:SUPABASE_URL,key:SERVICE_KEY});
async function discardEvidence(urls:string[]){
  await operationStorage.discard(urls);
  if(r2Media)await Promise.allSettled((urls||[]).map(url=>r2Media.discard(url)));
}
async function uploadEvidenceImages(files:Array<{data?:string}>,bucket:string){
  if(!r2WriteEnabled())return operationStorage.uploadImages(files,bucket);
  if(!r2Media)throw Error('R2_NOT_CONFIGURED');
  const kind=bucket==='order-images'?'sample':bucket==='settlement-bills'?'bill':null;
  if(!kind)throw Error('IMAGE_INVALID');
  const images=(files||[]).map(file=>{
    const match=String(file?.data||'').match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/);
    if(!match)throw Error('File ảnh không hợp lệ.');
    const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));
    if(!bytes.length||bytes.length>5*1024*1024)throw Error('Mỗi ảnh cần dung lượng 1 byte–5 MB.');
    const extension=match[1]==='image/jpeg'?'jpg':match[1].split('/')[1];
    const objectKey=r2Media.key(kind,crypto.randomUUID()+'.'+extension);
    return {bytes,type:match[1],objectKey,ref:r2Media.reference(objectKey)};
  });
  const uploaded:string[]=[];
  try{
    // Bounded concurrency (3 at a time); fail closed to R2, never fallback to Supabase Storage.
    for(let offset=0;offset<images.length;offset+=3){
      const results=await Promise.allSettled(images.slice(offset,offset+3).map(async image=>{
        uploaded.push(image.ref);
        const uploadUrl=await r2Media.signedUrl('PUT',image.objectKey,{expiresSeconds:900,contentType:image.type});
        const response=await fetch(uploadUrl,{method:'PUT',headers:{'Content-Type':image.type},body:image.bytes});
        if(!response.ok)throw Error('R2_UPLOAD_FAILED');
      }));
      const failed=results.find(x=>x.status==='rejected') as PromiseRejectedResult|undefined;
      if(failed)throw failed.reason;
    }
    return images.map(x=>x.ref);
  }catch(error){
    await Promise.allSettled(uploaded.map(ref=>r2Media.discard(ref)));
    throw error;
  }
}
const operations=createOperationService({db,one,uploadImages:uploadEvidenceImages,discardImages:discardEvidence,sha256,newId});
Deno.serve(async req=>{
  const origin=req.headers.get('origin')||'',allowed=['https://ops.meehoasg.com','http://ops.meehoasg.com','https://meehoasg.com','http://meehoasg.com'];
  const headers={'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':allowed.includes(origin)?origin:allowed[0],'Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'};
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});if(req.method!=='POST')return new Response('{}',{status:405,headers});
  try{
    const text=await req.text();if(new TextEncoder().encode(text).length>12*1024*1024)return new Response(JSON.stringify({ok:false,message:'Dữ liệu gửi lên quá lớn.'}),{status:413,headers});
    const body=JSON.parse(text),user=await requireUser(clean(body.token)),action=clean(body.action);
    if(!['saveShipFee','submitSettlement'].includes(action))return new Response(JSON.stringify({ok:false,message:'Thao tác không được hỗ trợ.'}),{headers});
    const result=await operations.run(action,body,user);const output={...result};delete output.row;
    return new Response(JSON.stringify({...output,build:BUILD}),{headers});
  }catch(e){
    const msg=String((e as Error)?.message||'');
    const auth=msg==='AUTH_REQUIRED';
    const r2Cfg=msg==='R2_NOT_CONFIGURED';
    const r2Err=msg==='R2_UPLOAD_FAILED';
    const badImg=msg==='File ảnh không hợp lệ.'||msg==='Mỗi ảnh cần dung lượng 1 byte–5 MB.'||msg==='IMAGE_INVALID';
    console.error('order-actions',e);
    const code=auth?'AUTH_REQUIRED':r2Cfg?'R2_NOT_CONFIGURED':r2Err?'R2_UPLOAD_FAILED':badImg?'IMAGE_INVALID':'SERVER_ERROR';
    const message=auth?'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.'
      :r2Cfg?'Hệ thống lưu trữ ảnh R2 chưa được cấu hình. Vui lòng liên hệ quản trị viên.'
      :r2Err?'Không tải được ảnh bill lên R2. Giữ nguyên mã yêu cầu để thử lại.'
      :badImg?msg
      :'Chưa xác nhận kết quả. Giữ nguyên mã yêu cầu để thử lại.';
    return new Response(JSON.stringify({ok:false,code,message}),{headers});
  }
});
