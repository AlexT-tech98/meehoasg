// Private R2 media. Existing supabase:// identity stays unchanged in business records.
// Media keys are never exposed as public R2 URLs.
const allowed=new Set(['order-images','settlement-bills']);
const enc=new TextEncoder();
function hex(bytes){return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function signature(secret,message){
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(message))));
}
function identity(value){
  const match=String(value).match(/^supabase:\/\/(order-images|settlement-bills)\/(.+)$/);
  if(match)return {bucket:match[1],path:match[2]};
  try{
    const url=new URL(String(value));
    if(url.protocol!=='https:'||url.hostname!=='drive.google.com')return null;
    const id=url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1]
      ||(url.pathname==='/uc'?url.searchParams.get('id'):null);
    return id&&/^[A-Za-z0-9_-]+$/.test(id)?{bucket:'drive-images',path:id}:null;
  }catch{return null;}
}
function keyOf(item){return `${item.bucket}/${item.path}`;}
async function toBytes(file){
  const match=String(file?.data||'').match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/);
  if(!match)throw Error('File ảnh không hợp lệ.');
  const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));
  if(bytes.length<1||bytes.length>5*1024*1024)throw Error('Mỗi ảnh cần dung lượng 1 byte–5 MB.');
  return {type:match[1],bytes};
}
export function createMediaStorage(env){
  async function uploadImages(files,bucket){
    if(!allowed.has(bucket))throw Error('IMAGE_INVALID');
    if(!env.MEDIA_R2)throw Error('R2_NOT_CONFIGURED');
    const parsed=await Promise.all((files||[]).map(toBytes)),urls=[];
    try{
      for(const file of parsed){
        const suffix=file.type==='image/jpeg'?'jpg':file.type.split('/')[1];
        const item={bucket,path:crypto.randomUUID()+'.'+suffix};
        const id=`supabase://${bucket}/${item.path}`;
        await env.MEDIA_R2.put(keyOf(item),file.bytes,{httpMetadata:{contentType:file.type}});
        urls.push(id);
      }
      return urls;
    }catch(error){await discard(urls);throw error;}
  }
  async function discard(urls){if(!env.MEDIA_R2)return;for(const url of urls||[]){const item=identity(url);if(item)await env.MEDIA_R2.delete(keyOf(item));}}
  // Stable signed links within a 15-minute window; permissions enforced by the calling authenticated API.
  // A recipient can still reuse a signed link until expiry, so never use indefinite/public R2 links.
  async function displayUrls(urls){
    if(!env.MEDIA_SIGNING_KEY)throw Error('MEDIA_SIGNING_KEY_REQUIRED');
    const out=[];
    const exp=(Math.floor(Date.now()/900000)+1)*900;
    for(const url of urls||[]){
      const item=identity(url);
      if(!item){out.push(url);continue;}
      const key=keyOf(item),sig=await signature(env.MEDIA_SIGNING_KEY,`${key}|${exp}`);
      out.push(`/media/${key}?exp=${exp}&sig=${sig}`);
    }
    return out;
  }
  return {uploadImages,discard,displayUrls};
}
export async function serveMedia(request,env){
  const url=new URL(request.url),match=url.pathname.match(/^\/media\/(order-images|settlement-bills|drive-images)\/(.+)$/);
  if(request.method!=='GET'||!match)return new Response('Not found',{status:404});
  if(!env.MEDIA_SIGNING_KEY)return new Response('Not configured',{status:503});
  const path=`${match[1]}/${match[2]}`,exp=Number(url.searchParams.get('exp'));
  if(!Number.isInteger(exp)||exp<Math.floor(Date.now()/1000)||exp>Math.floor(Date.now()/1000)+900)return new Response('Expired',{status:403});
  const expected=await signature(env.MEDIA_SIGNING_KEY,`${path}|${exp}`),given=url.searchParams.get('sig')||'';
  let mismatch=expected.length^given.length;
  for(let i=0;i<expected.length;i++)mismatch|=expected.charCodeAt(i)^(given.charCodeAt(i)||0);
  if(mismatch!==0)return new Response('Forbidden',{status:403});
  const thumbnail=url.searchParams.get('thumb')==='1'&&match[1]!=='settlement-bills';
  const object=env.MEDIA_R2?await env.MEDIA_R2.get(thumbnail?`thumbnails/${path}`:path):null;
  if(object)return new Response(object.body,{headers:{'content-type':object.httpMetadata?.contentType||'application/octet-stream','cache-control':'private, max-age=300','x-content-type-options':'nosniff'}});
  // Historical Supabase objects may not have been migrated yet. Never fallback for
  // new Drive objects, or when a requested thumbnail is missing (avoid full-size transfer).
  if(thumbnail||match[1]==='drive-images')return new Response('Not found',{status:404});
  if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)return new Response('Not found',{status:404});
  const raw=match[2];
  if(!raw||raw.split('/').some(part=>!part||part==='.'||part==='..'||/%2f|%5c/i.test(part)))return new Response('Not found',{status:404});
  let base;
  try{base=new URL(env.SUPABASE_URL);}catch{return new Response('Upstream unavailable',{status:502});}
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')return new Response('Upstream unavailable',{status:502});
  const objectPath=[match[1],...raw.split('/')].map(encodeURIComponent).join('/');
  const target=new URL(`/storage/v1/object/authenticated/${objectPath}`,base);
  try{
    const upstream=await fetch(target,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},redirect:'error'});
    if(upstream.status===404)return new Response('Not found',{status:404});
    if(!upstream.ok)return new Response('Historical media temporarily unavailable',{status:502});
    const type=upstream.headers.get('content-type')||'';
    if(!/^(image\/(jpeg|png|webp|gif)|application\/pdf)(;|$)/i.test(type))return new Response('Unsupported media type',{status:502});
    return new Response(upstream.body,{headers:{'content-type':type,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }catch{return new Response('Historical media temporarily unavailable',{status:502});}
}
