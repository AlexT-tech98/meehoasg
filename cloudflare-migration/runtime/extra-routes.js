import {createCore} from './core.js';
import {createOperationRpc} from './operations.js';
const clean=v=>String(v??'').trim();
const encoder=new TextEncoder();
async function sha256(value){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)));return [...b].map(n=>n.toString(16).padStart(2,'0')).join('')}
function reply(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
export async function orderActions(request,env){
  if(request.method!=='POST')return reply({ok:false,message:'POST only'},405);
  try{
    const raw=await request.text();if(encoder.encode(raw).length>12*1024*1024)return reply({ok:false,message:'Dữ liệu gửi lên quá lớn.'},413);
    const payload=JSON.parse(raw),action=clean(payload.action);
    if(!['saveShipFee','submitSettlement'].includes(action))return reply({ok:false,message:'Thao tác không được hỗ trợ.'});
    return createCore(env)(new Request(new URL('/api-core',request.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:action,payload})}));
  }catch(e){console.error('Order action error',e);return reply({ok:false,code:'SERVER_ERROR',message:'Chưa xác nhận kết quả. Giữ nguyên mã yêu cầu để thử lại.'})}
}
export async function deleteOrder(request,env){
  if(request.method!=='POST')return reply({ok:false,message:'POST only'},405);
  if(!env.DB)return reply({ok:false,message:'Máy chủ chưa cấu hình.'},503);
  try{
    const raw=await request.text();if(encoder.encode(raw).length>12*1024*1024)return reply({ok:false,message:'Dữ liệu gửi lên quá lớn.'},413);
    const body=JSON.parse(raw),token=clean(body.token),orderId=clean(body.orderId);
    if(!/^[0-9a-f]{64}$/i.test(token)||!orderId||orderId.length>128)return reply({ok:false,code:'AUTH_REQUIRED',message:'Thiếu thông tin xóa đơn.'});
    const tokenHash=await sha256(token);
    const sessionRow=await env.DB.prepare('SELECT data FROM app_sessions WHERE row_key=?').bind(tokenHash).first();
    const session=sessionRow&&JSON.parse(sessionRow.data);
    if(!session||!(Date.parse(session.expires_at)>Date.now()))return reply({ok:false,code:'AUTH_REQUIRED',message:'Phiên đăng nhập không hợp lệ.'});
    const userRow=await env.DB.prepare('SELECT data FROM app_users WHERE row_key=?').bind(session.username).first();
    const user=userRow&&JSON.parse(userRow.data);
    if(!user?.active)return reply({ok:false,code:'AUTH_REQUIRED',message:'Tài khoản đã bị khóa.'});
    if(user.role!=='ADMIN')return reply({ok:false,code:'NOT_OWNER',message:'Chỉ Admin được xóa đơn.'});
    const requestId=clean(body.requestId)||'delete:'+await sha256(orderId);
    if(requestId.length>128)return reply({ok:false,code:'REQUEST_ID_REQUIRED',message:'Mã yêu cầu không hợp lệ.'});
    const rpc=createOperationRpc(env.DB),args={p_actor:user.username,p_request_id:requestId,p_action:'deleteOrder',p_fingerprint:await sha256(JSON.stringify({orderId}))};
    let expectedUpdatedAt=clean(body.expectedUpdatedAt);
    let result=await rpc('mee_ops_mutate',{...args,p_input:{orderId,expectedUpdatedAt}});
    if(!expectedUpdatedAt&&result?.code==='VERSION_REQUIRED'){
      const orderRow=await env.DB.prepare('SELECT data FROM orders WHERE row_key=?').bind(orderId).first();
      if(!orderRow)return reply({ok:false,code:'NOT_FOUND',message:'Đơn không còn tồn tại.'});
      expectedUpdatedAt=JSON.parse(orderRow.data).updated_at;
      result=await rpc('mee_ops_mutate',{...args,p_input:{orderId,expectedUpdatedAt}});
    }
    return reply(result);
  }catch(e){console.error('Delete action failed',e);return reply({ok:false,code:'SERVER_ERROR',message:'Không xóa được đơn. Vui lòng thử lại.'},500)}
}
