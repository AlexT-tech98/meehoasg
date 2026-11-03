const PRIVATE_REFERENCE=/^supabase:\/\/(order-images|settlement-bills)\/([0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp))$/;
const MAX_IMAGE_BYTES=5*1024*1024;
const MIME_TYPES={jpg:'image/jpeg',png:'image/png',webp:'image/webp'};

/** Optional private R2 mirror. Supabase keeps all committed image references. */
export function createR2Bridge({readsEnabled=false,writesEnabled=false,media=null,sourceUrl='',serviceKey='',fetcher=fetch,logger=console}={}) {
  const parse=value=>{
    const m=String(value||'').match(PRIVATE_REFERENCE);
    return m?{bucket:m[1],path:m[2],key:m[1]+'/'+m[2],type:MIME_TYPES[m[2].split('.').pop()]}:null;
  };
  const enabledReads=!!(readsEnabled&&media);
  const enabledWrites=!!(writesEnabled&&media);
  const storageUrl=String(sourceUrl).replace(/\/+$/,'');
  const headers={apikey:serviceKey,Authorization:'Bearer '+serviceKey};

  async function readUrl(reference) {
    const item=parse(reference);
    if(!enabledReads||!item)return null;
    try {
      if(!await media.exists(item.key))return null;
      return await media.signedUrl('GET',item.key,{expiresSeconds:3600});
    } catch (_) {
      logger.warn?.('R2_READ_FALLBACK_TO_SUPABASE');
      return null;
    }
  }

  async function verifyBytes(reference,original) {
    const response=await fetcher(await media.signedUrl('GET',reference,{expiresSeconds:60}),{method:'GET'});
    if(!response.ok)return false;
    const bytes=new Uint8Array(await response.arrayBuffer());
    return bytes.length===original.length&&bytes.every((value,index)=>value===original[index]);
  }

  async function mirror(reference) {
    const item=parse(reference);
    if(!enabledWrites||!item)return false;
    try {
      const response=await fetcher(storageUrl+'/storage/v1/object/authenticated/'+item.key,{method:'GET',headers});
      if(!response.ok)throw Error('SOURCE_READ_FAILED');
      const announced=Number(response.headers.get('content-length'));
      if(Number.isFinite(announced)&&announced>MAX_IMAGE_BYTES)throw Error('SOURCE_TOO_LARGE');
      const bytes=new Uint8Array(await response.arrayBuffer());
      if(bytes.length<1||bytes.length>MAX_IMAGE_BYTES)throw Error('SOURCE_INVALID_SIZE');
      if(await media.exists(item.key)){
        if(!await verifyBytes(item.key,bytes))throw Error('R2_EXISTING_MISMATCH');
        return true;
      }
      const url=await media.signedUrl('PUT',item.key,{expiresSeconds:900,contentType:item.type});
      const put=await fetcher(url,{method:'PUT',headers:{'Content-Type':item.type},body:bytes});
      if(!put.ok||!await verifyBytes(item.key,bytes))throw Error('R2_WRITE_VERIFY_FAILED');
      return true;
    } catch (_) {
      // A failed mirror never blocks the operation; Supabase retains the image.
      logger.warn?.('R2_MIRROR_FAILED_SUPABASE_PRESERVED');
      return false;
    }
  }

  async function discard(reference) {
    const item=parse(reference);
    if(!enabledWrites||!item)return false;
    try {
      await media.discard(media.reference(item.key));
      return true;
    }catch(_){
      logger.warn?.('R2_ROLLBACK_CLEANUP_FAILED');
      return false;
    }
  }

  return {readUrl,mirror,discard};
}
