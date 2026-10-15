// Canonical delete endpoint: queue, audit and receipt commit through mee_ops_mutate.
const BUILD='2026.10.09-delete-atomic2';
const SUPABASE_URL=Deno.env.get('SUPABASE_URL');
const SERVICE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const clean=v=>String(v??'').trim();
async function sha256(value){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));return [...b].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function rest(table,query={},method='GET',body){
 const url=new URL(`${SUPABASE_URL}/rest/v1/${table}`);for(const [k,v] of Object.entries(query))url.searchParams.set(k,v);
 const r=await fetch(url,{method,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!r.ok)throw Error('Database operation failed');return r.json();
}
Deno.serve(async req=>{
 const headers={'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'https://ops.meehoasg.com','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
 const reply=(data,status=200)=>new Response(JSON.stringify({build:BUILD,...data}),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({ok:false,message:'POST only'},405);
 if(!SUPABASE_URL||!SERVICE_KEY)return reply({ok:false,message:'Not configured'},503);
 try{
  const body=await req.json(),token=clean(body.token),orderId=clean(body.orderId);
  if(!/^[0-9a-f]{64}$/i.test(token)||!orderId||orderId.length>128)return reply({ok:false,code:'AUTH_REQUIRED',message:'Thiếu thông tin xóa đơn.'});
  const sessions=await rest('app_sessions',{token_hash:'eq.'+await sha256(token),select:'username,expires_at',limit:'1'}),session=sessions[0],expiry=Date.parse(session?.expires_at);
  if(!session||!Number.isFinite(expiry)||expiry<=Date.now())return reply({ok:false,code:'AUTH_REQUIRED',message:'Phiên đăng nhập không hợp lệ.'});
  const users=await rest('app_users',{username:'eq.'+session.username,select:'username,role,active',limit:'1'}),user=users[0];
  if(!user?.active)return reply({ok:false,code:'AUTH_REQUIRED',message:'Tài khoản đã bị khóa.'});
  if(user.role!=='ADMIN')return reply({ok:false,code:'NOT_OWNER',message:'Chỉ Admin được xóa đơn.'});
  // Existing cached clients lack keys/versions. A stable delete intent safely
  // retries after a lost response or archive; new clients send the viewed version.
  const requestId=clean(body.requestId)||'delete:'+await sha256(orderId);
  if(requestId.length>128)return reply({ok:false,code:'REQUEST_ID_REQUIRED',message:'Mã yêu cầu không hợp lệ.'});
  const args={p_actor:user.username,p_request_id:requestId,p_action:'deleteOrder',p_fingerprint:await sha256(JSON.stringify({orderId}))};
  let expectedUpdatedAt=clean(body.expectedUpdatedAt);
  const mutate=()=>rest('rpc/mee_ops_mutate',{},'POST',{...args,p_input:{orderId,expectedUpdatedAt}});
  // The transaction rechecks the current Admin role before receipt recovery.
  // A legacy first attempt with no version returns VERSION_REQUIRED without writes.
  let result=await mutate();
  if(!expectedUpdatedAt&&result?.code==='VERSION_REQUIRED'){
   const rows=await rest('orders',{id:'eq.'+orderId,select:'updated_at',limit:'1'});
   if(!rows[0])return reply({ok:false,code:'NOT_FOUND',message:'Đơn không còn tồn tại.'});
   expectedUpdatedAt=rows[0].updated_at;
   result=await mutate();
  }
  return reply(result);
 }catch(e){console.error('Delete transaction failed');return reply({ok:false,message:'Không xóa được đơn. Vui lòng thử lại.'},500);}
});
