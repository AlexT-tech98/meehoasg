import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaStorage,serveMedia} from '../runtime/media.js';
const memory=new Map();
const env={MEDIA_SIGNING_KEY:'staging-test-key',MEDIA_R2:{
  async put(k,b,opt){memory.set(k,{bytes:b,contentType:opt.httpMetadata.contentType});},
  async get(k){const v=memory.get(k);return v?{body:v.bytes,httpMetadata:{contentType:v.contentType}}:null;},
  async delete(k){memory.delete(k);}
}};
test('private R2 upload retains identity, URL expires and requires signature',async()=>{
  const store=createMediaStorage(env);
  const urls=await store.uploadImages([{data:'data:image/png;base64,AQID'}],'order-images');
  assert.match(urls[0],/^supabase:\/\/order-images\//);
  const [link]=await store.displayUrls(urls);
  assert.match(link,/^\/media\/order-images\//);
  assert.equal((await serveMedia(new Request('https://staging.example'+link.replace(/sig=[^&]+/,'sig=wrong')),env)).status,403);
  const res=await serveMedia(new Request('https://staging.example'+link),env);
  assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'image/png');
  await store.discard(urls);assert.equal((await serveMedia(new Request('https://staging.example'+link),env)).status,404);
});
test('existing Drive links resolve to private R2 objects',async()=>{
  const id='19IXiKF4kdlLBhrDARtC1FSFNBj4IPq8X';
  memory.set('drive-images/'+id,{bytes:new Uint8Array([1,2,3]),contentType:'image/jpeg'});
  memory.set('thumbnails/drive-images/'+id,{bytes:new Uint8Array([4,5]),contentType:'image/webp'});
  const links=await createMediaStorage(env).displayUrls([
    `https://drive.google.com/file/d/${id}/view`,
    `https://drive.google.com/uc?id=${id}`
  ]);
  assert.equal(links[0],links[1]);
  assert.match(links[0],new RegExp(`^/media/drive-images/${id}\\?`));
  assert.equal((await serveMedia(new Request('https://staging.example'+links[0]),env)).status,200);
  const preview=await serveMedia(new Request('https://staging.example'+links[0]+'&thumb=1'),env);
  assert.equal(preview.status,200);
  assert.equal(preview.headers.get('content-type'),'image/webp');
  assert.deepEqual([...new Uint8Array(await preview.arrayBuffer())],[4,5]);
  assert.equal((await serveMedia(new Request('https://staging.example'+links[0].replace(/sig=[^&]+/,'sig=wrong')),env)).status,403);
});
