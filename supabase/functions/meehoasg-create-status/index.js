// Session, account activity and creator scope are checked in one read-only RPC.
const BUILD='2026.10.09-create-status-scoped2';
const SUPABASE_URL=Deno.env.get('SUPABASE_URL');
const SERVICE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const clean=v=>String(v??'').trim();
async function sha256(value){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));return [...b].map(n=>n.toString(16).padStart(2,'0')).join('');}
Deno.serve(async req=>{
 const headers={'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'https://ops.meehoasg.com','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
 const reply=(data,status=200)=>new Response(JSON.stringify({build:BUILD,...data}),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({ok:false,message:'POST only'},405);
 if(!SUPABASE_URL||!SERVICE_KEY)return reply({ok:false,message:'Not configured'},503);
 try{
  const body=await req.json(),token=clean(body.token),requestId=clean(body.requestId);
  if(!/^[0-9a-f]{64}$/i.test(token)||!requestId||requestId.length>128)return reply({ok:false,found:false,code:'AUTH_REQUIRED'});
  const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/mee_create_status`,{method:'POST',headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({p_token_hash:await sha256(token),p_request_id:requestId})});
  if(!r.ok)throw Error('Database operation failed');return reply(await r.json());
 }catch(e){return reply({ok:false,found:false,message:'Không kiểm tra được trạng thái đơn.'},500);}
});
