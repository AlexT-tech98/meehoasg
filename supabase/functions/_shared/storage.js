/* Storage is outside the SQL transaction. Delete only provably uncommitted uploads. */
export function createOperationStorage({url,key,fetcher=fetch,uuid=()=>crypto.randomUUID(),log=console.error}) {
  const headers={apikey:key,Authorization:`Bearer ${key}`};
  async function discard(urls){
    for(const value of urls||[]){
      const m=String(value).match(/^supabase:\/\/(order-images|settlement-bills)\/(.+)$/);if(!m)continue;
      try{const r=await fetcher(`${url}/storage/v1/object/${m[1]}`,{method:'DELETE',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prefixes:[m[2]]})});if(!r.ok)log('Unused upload cleanup failed',r.status,value);}catch(e){log('Unused upload cleanup failed',String(e),value);}
    }
  }
  async function uploadImages(files,bucket){
    if(!['order-images','settlement-bills'].includes(bucket))throw Error('IMAGE_INVALID');
    // Validate the complete batch before uploading any object.
    const images=(files||[]).map(file=>{
      const m=String(file?.data||'').match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/);if(!m)throw Error('File ảnh không hợp lệ.');
      const bytes=Uint8Array.from(atob(m[2]),c=>c.charCodeAt(0));if(!bytes.length||bytes.length>5*1024*1024)throw Error('Mỗi ảnh cần dung lượng 1 byte–5 MB.');
      return {bytes,type:m[1],path:uuid()+'.'+(m[1]==='image/jpeg'?'jpg':m[1].split('/')[1])};
    });
    const urls=[];
    try{
      for(const image of images){
        // Record the known key BEFORE the request; an upload can succeed while its response is lost.
        urls.push(`supabase://${bucket}/${image.path}`);
        const r=await fetcher(`${url}/storage/v1/object/${bucket}/${image.path}`,{method:'POST',headers:{...headers,'Content-Type':image.type,'x-upsert':'false'},body:image.bytes});
        if(!r.ok)throw Error('Không lưu được ảnh.');
      }
      return urls;
    }catch(e){await discard(urls);throw e;}
  }
  return {uploadImages,discard};
}
