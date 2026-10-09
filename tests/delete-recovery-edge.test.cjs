const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const token='a'.repeat(64);
function harness(name,respond){let handler,calls=[];const context={URL,Request,Response,TextEncoder,Date,crypto:webcrypto,console:{error(){}},Deno:{env:{get:k=>({SUPABASE_URL:'https://test.local',SUPABASE_SERVICE_ROLE_KEY:'fixture-only'})[k]},serve:fn=>handler=fn},fetch:async(url,args)=>{const call={url:new URL(url),method:args.method||'GET',body:args.body&&JSON.parse(args.body)};calls.push(call);return new Response(JSON.stringify(await respond(call)),{status:200});}};vm.createContext(context);vm.runInContext(fs.readFileSync('supabase/functions/'+name+'/index.js','utf8'),context);return {calls,request:body=>handler(new Request('https://test.local',{method:'POST',body:JSON.stringify(body)}))};}
function authorized(call){const path=call.url.pathname;if(path.endsWith('/app_sessions'))return [{username:'admin',expires_at:'2099-01-01T00:00:00Z'}];if(path.endsWith('/app_users'))return [{username:'admin',role:'ADMIN',active:true}];}
test('delete endpoint rejects invalid session, expired and inactive users before mutation',async()=>{
 for(const mode of ['invalid','expired','inactive','sale']){
  const h=harness('meehoasg-delete-order',c=>{if(mode==='expired'&&c.url.pathname.endsWith('/app_sessions'))return [{username:'admin',expires_at:'2000-01-01T00:00:00Z'}];if(c.url.pathname.endsWith('/app_users'))return [{username:'admin',active:mode!=='inactive',role:mode==='sale'?'SALE':'ADMIN'}];return authorized(c);});
  const r=await h.request({token:mode==='invalid'?'bad':token,orderId:'ONE'});assert.equal((await r.json()).ok,false);assert.equal(h.calls.some(c=>c.url.pathname.includes('/rpc/')),false);
 }
});
test('legacy delete derives stable intent and retry recovers receipt before touching archived order',async()=>{
 let receipt=null;const h=harness('meehoasg-delete-order',c=>{const auth=authorized(c);if(auth)return auth;if(c.url.pathname.endsWith('/orders'))return [{updated_at:'2026-10-09T01:00:00Z'}];if(c.url.pathname.endsWith('mee_ops_mutate')){if(receipt)return receipt;if(!c.body.p_input.expectedUpdatedAt)return {ok:false,code:'VERSION_REQUIRED'};return receipt={ok:true,orderId:'ONE',idempotent:true};}throw Error('Unexpected access');});
 assert.equal((await (await h.request({token,orderId:'ONE'})).json()).ok,true);const n=h.calls.length;
 assert.equal((await (await h.request({token,orderId:'ONE'})).json()).ok,true);assert.equal(h.calls.slice(n).some(c=>c.url.pathname.endsWith('/orders')),false);
 const keys=h.calls.filter(c=>c.url.pathname.endsWith('mee_ops_mutate')).map(c=>c.body.p_request_id);assert.equal(keys[0],keys[2]);
});
test('versioned delete passes the viewed version to the canonical transaction',async()=>{
 const h=harness('meehoasg-delete-order',c=>authorized(c)??(c.url.pathname.endsWith('mee_ops_lookup')?null:{ok:false,code:'ORDER_CONFLICT'}));
 const r=await h.request({token,orderId:'ONE',requestId:'req',expectedUpdatedAt:'2026-10-09T01:00:00Z'});assert.equal((await r.json()).code,'ORDER_CONFLICT');
 const c=h.calls.find(c=>c.url.pathname.endsWith('mee_ops_mutate'));assert.equal(c.body.p_input.expectedUpdatedAt,'2026-10-09T01:00:00Z');assert.equal(c.body.p_action,'deleteOrder');assert.equal(h.calls.some(c=>c.method==='PATCH'),false);
});
test('create-status only sends hashed token and request key to scoped SQL RPC',async()=>{
 const h=harness('meehoasg-create-status',()=>({ok:false,found:false,code:'AUTH_REQUIRED'}));assert.equal((await (await h.request({token:'bad',requestId:'mine'})).json()).ok,false);assert.equal(h.calls.length,0);
 const r=await h.request({token,requestId:'mine'});assert.equal((await r.json()).code,'AUTH_REQUIRED');assert.equal(h.calls.length,1);const c=h.calls[0];assert.ok(c.url.pathname.endsWith('mee_create_status'));assert.notEqual(c.body.p_token_hash,token);assert.match(c.body.p_token_hash,/^[a-f0-9]{64}$/);assert.equal('token' in c.body,false);
});
function deleteUi(order){const source=fs.readFileSync('assets/meehoa-v366.js','utf8').match(/  async function requestDelete\(id,btn\)\{[\s\S]*?(?=\n  function patchDelete)/)[0];const calls=[],messages=[];let fail=true;const S={token,user:{role:'ADMIN'},page:'orders'},window={S,confirm:()=>true,toast:message=>messages.push(message)};const context={window,S,DELETE_URL:'https://test.local/delete',crypto:webcrypto,findOrderDeep:()=>order,fetch:async(url,args)=>{calls.push(JSON.parse(args.body));if(fail){fail=false;throw Error('Lost response');}return {json:async()=>({ok:true})};}};vm.createContext(context);vm.runInContext(source,context);return {...context,calls,messages};}
test('delete button retries the exact payload after a lost response',async()=>{
 const h=deleteUi({id:'ONE',customer:'Fixture',updatedAt:'2026-10-09T01:00:00Z'}),btn={textContent:'Xóa đơn'};
 await h.requestDelete('ONE',btn);assert.equal(btn.disabled,false);assert.equal(h.calls.length,1);await h.requestDelete('ONE',btn);assert.deepEqual(h.calls[0],h.calls[1]);assert.equal(h.calls[0].expectedUpdatedAt,'2026-10-09T01:00:00Z');assert.ok(h.calls[0].requestId);
});
test('delete button refuses to send when detail lacks its version',async()=>{const h=deleteUi({id:'ONE'});await h.requestDelete('ONE',{textContent:'Xóa đơn'});assert.equal(h.calls.length,0);assert.match(h.messages[0],/Tải lại/);});
