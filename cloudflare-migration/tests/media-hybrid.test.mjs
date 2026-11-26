import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaStorage,serveMedia} from '../runtime/media.js';
const key='test-key';
const id='supabase://order-images/historical.jpg';
const env={MEDIA_SIGNING_KEY:key,MEDIA_R2:{async get(){return null;}},SUPABASE_URL:'https://example.supabase.co/',SUPABASE_SERVICE_ROLE_KEY:'test-secret'};
test('historical storage fallback and sealed credentials',async()=>{
 const link=(await createMediaStorage(env).displayUrls([id]))[0];
 const oldFetch=globalThis.fetch;
 let called=0;
 globalThis.fetch=async(url,options)=>{called++;assert.equal(url.href,'https://example.supabase.co/storage/v1/object/authenticated/order-images/historical.jpg');assert.equal(options.headers.apikey,'test-secret');return new Response(new Uint8Array([7,8,9]),{headers:{'content-type':'image/jpeg'}});};
 try{
  const response=await serveMedia(new Request('https://worker.test'+link),env);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(called,1);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[7,8,9]);
  assert.equal((await serveMedia(new Request('https://worker.test'+link.replace(/sig=[^&]+/,'sig=bad')),env)).status,403);
  assert.equal(called,1);
 }finally{globalThis.fetch=oldFetch;}
});
test('missing thumbnail never falls back to full size',async()=>{
 const link=(await createMediaStorage(env).displayUrls([id]))[0];
 const oldFetch=globalThis.fetch;
 globalThis.fetch=()=>{throw Error('should not fetch')};
 try{assert.equal((await serveMedia(new Request('https://worker.test'+link+'&thumb=1'),env)).status,404)}finally{globalThis.fetch=oldFetch}
});
test('upstream failure hides secrets',async()=>{
 const link=(await createMediaStorage(env).displayUrls([id]))[0];
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response('test-secret',{status:402});
 try{const result=await serveMedia(new Request('https://worker.test'+link),env);assert.equal(result.status,502);assert.ok(!(await result.text()).includes('test-secret'))}finally{globalThis.fetch=oldFetch}
});
