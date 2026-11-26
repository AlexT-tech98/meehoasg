export function createR2ImageReader({media,source,serviceKey,fetcher}) {
  const cache=new Map();
  async function resolve(value) {
    const raw=String(value||'');
    const r2Key=media?.parseReference(raw)||null;
    const legacy=raw.match(/^supabase:\/\/(order-images|settlement-bills)\/(.+)$/);
    if(!r2Key&&!legacy){
      if(/^r2:\/\//.test(raw))return null;
      return value;
    }
    const cached=cache.get(raw);
    if(cached&&cached.expires>Date.now())return cached.value;
    if(cached?.pending)return cached.pending;
    const pending=(async()=>{
      let signed;
      if(r2Key){
        signed=await media.signedUrl('GET',r2Key,{expiresSeconds:3600});
      }else{
        const doFetch=fetcher||fetch;
        const response=await doFetch(source+'/storage/v1/object/sign/'+legacy[1]+'/'+legacy[2],{
          method:'POST',
          headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},
          body:JSON.stringify({expiresIn:3600})
        });
        if(!response.ok)return null;
        const result=await response.json();
        signed=source+'/storage/v1'+result.signedURL;
      }
      if(cache.size>=500)cache.clear();
      cache.set(raw,{value:signed,expires:Date.now()+45*60*1000});
      return signed;
    })();
    cache.set(raw,{pending});
    try{return await pending}finally{if(cache.get(raw)?.pending===pending)cache.delete(raw)}
  }
  resolve.invalidate=value=>cache.delete(String(value||''));
  return resolve;
}
