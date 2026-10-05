const BUILD='2026.10.06-order-actions-v1';
const SUPABASE_URL=Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const encoder=new TextEncoder();

function clean(v:unknown){return String(v??'').trim()}
function norm(v:unknown){return clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase().replace(/\s+/g,' ')}
function num(v:unknown){if(typeof v==='number')return Number.isFinite(v)?v:0;let raw=clean(v).replace(/[^\d.,-]/g,'');if(raw.includes(',')&&raw.includes('.'))raw=raw.replaceAll('.','').replace(',','.');else if(/^-?\d{1,3}(?:[.,]\d{3})+$/.test(raw))raw=raw.replace(/[.,]/g,'');else raw=raw.replace(',','.');const n=Number(raw);return Number.isFinite(n)?n:0}
function fail(message:string,code?:string){return{ok:false,message,...(code?{code}:{})}}
async function sha256(text:string){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)));return[...b].map(n=>n.toString(16).padStart(2,'0')).join('')}
function newId(prefix:string){return prefix+'-'+crypto.randomUUID().replaceAll('-','').slice(0,16).toUpperCase()}

async function rest(table:string,query:Record<string,string>={},method='GET',body?:unknown){
  const u=new URL(`${SUPABASE_URL}/rest/v1/${table}`);Object.entries(query).forEach(([k,v])=>u.searchParams.set(k,v));
  const r=await fetch(u,{method,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json',Prefer:method==='GET'?'count=exact':'return=representation'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const t=await r.text();if(!r.ok)throw new Error(`DB ${r.status}: ${t.slice(0,260)}`);return t?JSON.parse(t):[];
}
async function one(table:string,query:Record<string,string>){return (await rest(table,{...query,limit:'1'}))[0]||null}
async function requireUser(token:string){
  if(!/^[0-9a-f]{64}$/i.test(token))throw new Error('AUTH_REQUIRED');
  const s=await one('app_sessions',{token_hash:`eq.${await sha256(token)}`,select:'username,expires_at'});
  if(!s||Date.parse(s.expires_at)<=Date.now())throw new Error('AUTH_REQUIRED');
  const u=await one('app_users',{username:`eq.${s.username}`,select:'username,display_name,role,active'});
  if(!u?.active)throw new Error('AUTH_REQUIRED');return u;
}
async function audit(user:any,orderId:string,action:string,before:any,after:any){try{await rest('activity_log',{},'POST',{username:user.username,display_name:user.display_name,role:user.role,order_id:orderId,action,before_data:before||null,after_data:after||null})}catch(_){}}
async function activeSettlement(orderId:string){return one('settlement_requests',{order_id:`eq.${orderId}`,status:'in.(PENDING,APPROVED)',select:'id,status,submitted_at',order:'submitted_at.desc'})}
function accessoryTotal(o:any){const q=o.card?Math.max(1,Math.min(99,Math.floor(num(o.card_qty)||1))):0;return q*10000+(o.banner?35000:0)+num(o.charm_fee)+num(o.paper_fee)}

async function uploadImages(files:any[]){
  const out:string[]=[];
  for(const file of files||[]){
    const m=String(file?.data||'').match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/);if(!m)throw new Error('BILL_INVALID');
    const binary=atob(m[2]),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length>5*1024*1024)throw new Error('BILL_TOO_LARGE');
    const ext=m[1]==='image/jpeg'?'jpg':m[1].split('/')[1],path=crypto.randomUUID()+'.'+ext;
    const r=await fetch(`${SUPABASE_URL}/storage/v1/object/settlement-bills/${path}`,{method:'POST',headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':m[1],'x-upsert':'false'},body:bytes});
    if(!r.ok)throw new Error('BILL_UPLOAD_FAILED');out.push(`supabase://settlement-bills/${path}`);
  }
  return out;
}

async function saveShipFee(body:any,user:any){
  if(!['ADMIN','THO_OPS'].includes(user.role))return fail('Chỉ thợ hoặc Admin được nhập phí ship.','ROLE_REQUIRED');
  const id=clean(body.orderId),o=await one('orders',{id:`eq.${id}`,select:'*'});if(!o)return fail('Không tìm thấy đơn.');
  if(o.settled)return fail('Đơn đã tất toán nên không thể đổi phí ship.');
  if(await activeSettlement(id))return fail('Đơn đang có yêu cầu tất toán nên phí ship đã khóa.');
  if(!norm(o.shipping).includes('shop'))return fail('Chỉ nhập phí ship cho đơn Shop book ship.');
  const fee=num(body.shipFee);if(fee<0)return fail('Phí ship không hợp lệ.');
  const now=new Date().toISOString();
  await rest('orders',{id:`eq.${id}`},'PATCH',{ship_fee:fee,ship_confirmed:true,ship_fee_updated_by:user.username,ship_fee_updated_role:user.role,ship_fee_updated_at:now,updated_at:now});
  await audit(user,id,'SHIP_FEE',{shipFee:o.ship_fee,shipConfirmed:o.ship_confirmed},{shipFee:fee,shipConfirmed:true});
  return{ok:true,build:BUILD,orderId:id,shipFee:fee,shipConfirmed:true,message:'Đã cập nhật phí ship.'};
}

async function submitSettlement(body:any,user:any){
  if(!['ADMIN','SALE'].includes(user.role))return fail('Chỉ Sale phụ trách hoặc Admin được gửi tất toán.','ROLE_REQUIRED');
  const id=clean(body.orderId),o=await one('orders',{id:`eq.${id}`,select:'*'});if(!o)return fail('Không tìm thấy đơn.');
  if(o.settled)return fail('Đơn đã tất toán.');
  if(await activeSettlement(id))return fail('Đơn đã có yêu cầu tất toán đang xử lý.');
  const owner=norm(o.sale)===norm(user.username)||norm(o.sale)===norm(user.display_name);
  if(user.role==='SALE'&&!owner)return fail('Bạn chỉ được tất toán đơn do mình phụ trách.','NOT_OWNER');
  if(o.status!=='Đã giao')return fail('Chỉ gửi tất toán sau khi đơn đã giao.');
  const shop=norm(o.shipping).includes('shop');
  if(shop&&!o.ship_confirmed)return fail('Thợ cần nhập phí ship thực tế trước khi Sale gửi tất toán.','SHIP_FEE_REQUIRED');
  const files=Array.isArray(body.billFiles)?body.billFiles:[],existing=Array.isArray(body.billUrls)?body.billUrls.map(clean).filter(Boolean):[];
  const uploaded=await uploadImages(files),billUrls=[...new Set([...existing,...uploaded])];if(!billUrls.length)return fail('Cần ít nhất một ảnh bill.','BILL_REQUIRED');
  const accessory=accessoryTotal(o),ship=shop?num(o.ship_fee):0,required=num(o.flower_total)+accessory+num(o.vat)+ship,requestId=newId('SET');
  await rest('settlement_requests',{},'POST',{id:requestId,order_id:id,sale_username:user.username,sale_name:user.display_name,flower_total:num(o.flower_total),accessory_total:accessory,vat:num(o.vat),ship_fee:ship,required_amount:required,bill_urls:billUrls,note:clean(body.note),status:'PENDING'});
  await audit(user,id,'SETTLEMENT',null,{requestId,required,shipFee:ship,cardQty:o.card?Math.max(1,Math.floor(num(o.card_qty)||1)):0});
  return{ok:true,build:BUILD,requestId,orderId:id,requiredAmount:required,settlementStatus:'PENDING',message:'Đã gửi tất toán.'};
}

Deno.serve(async req=>{
  const origin=req.headers.get('origin')||'',allowed=['https://ops.meehoasg.com','http://ops.meehoasg.com','https://meehoasg.com','http://meehoasg.com'],allow=allowed.includes(origin)?origin:allowed[0];
  const headers={'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':allow,'Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'};
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});if(req.method!=='POST')return new Response(JSON.stringify(fail('POST only')),{status:405,headers});
  try{
    if(Number(req.headers.get('content-length')||0)>12*1024*1024)return new Response(JSON.stringify(fail('Dữ liệu gửi lên quá lớn.')),{status:413,headers});
    const body=await req.json(),user=await requireUser(clean(body.token)),action=clean(body.action);let result;
    if(action==='saveShipFee')result=await saveShipFee(body,user);else if(action==='submitSettlement')result=await submitSettlement(body,user);else result=fail('Thao tác không được hỗ trợ.');
    return new Response(JSON.stringify({...result,build:BUILD}),{status:200,headers});
  }catch(e){const code=String((e as Error)?.message||'');let message='Máy chủ gặp lỗi. Vui lòng thử lại.';if(code==='AUTH_REQUIRED')message='Phiên đăng nhập không hợp lệ hoặc đã hết hạn.';else if(code==='BILL_INVALID')message='Ảnh bill không hợp lệ.';else if(code==='BILL_TOO_LARGE')message='Mỗi ảnh bill tối đa 5 MB.';else if(code==='BILL_UPLOAD_FAILED')message='Không lưu được ảnh bill.';console.error('meehoasg-order-actions',e);return new Response(JSON.stringify(fail(message,code==='AUTH_REQUIRED'?'AUTH_REQUIRED':'SERVER_ERROR')),{status:200,headers})}
});