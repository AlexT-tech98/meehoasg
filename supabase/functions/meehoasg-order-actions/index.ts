import {createOperationStorage} from '../_shared/storage.js';
import {createOperationService} from '../_shared/operations.js';
const BUILD='2026.10.08-order-actions-atomic';
const SUPABASE_URL=Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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
const uploadImages=operationStorage.uploadImages;
const operations=createOperationService({db,one,uploadImages,discardImages:operationStorage.discard,sha256,newId});
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
  }catch(e){const auth=String((e as Error).message)==='AUTH_REQUIRED';console.error('order-actions',e);return new Response(JSON.stringify({ok:false,code:auth?'AUTH_REQUIRED':'SERVER_ERROR',message:auth?'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.':'Chưa xác nhận kết quả. Giữ nguyên mã yêu cầu để thử lại.'}),{headers});}
});
