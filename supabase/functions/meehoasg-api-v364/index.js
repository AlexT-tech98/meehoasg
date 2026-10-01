const UI_BUILD = '2026.09.28-supabase-v3';
const PROXY_BUILD = '2026.10.01-v364-bootstrap1';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY');
const V363_API = `${SUPABASE_URL}/functions/v1/meehoasg-api-v363`;
const ALLOWED_ORIGINS = ['https://ops.meehoasg.com','http://ops.meehoasg.com','https://meehoasg.com','http://meehoasg.com'];

function clean(v){return String(v??'').trim()}
function norm(v){return clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase().replace(/\s+/g,' ')}
function num(v){const n=Number(String(v??0).replace(/[^\d.-]/g,''));return Number.isFinite(n)?n:0}
function dateToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function corsHeaders(origin){const allow=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0];return {'Access-Control-Allow-Origin':allow,'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Vary':'Origin'}}
async function sha256(text){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('')}

async function db(table,query={},method='GET',body){
  const url=new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(query).forEach(([k,v])=>{if(v!==undefined&&v!==null)url.searchParams.set(k,String(v))});
  const res=await fetch(url,{method,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json',Prefer:method==='GET'?'count=exact':(query.on_conflict?'return=representation,resolution=merge-duplicates':'return=representation')},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await res.text();if(!res.ok)throw new Error(`Database ${res.status}: ${text.slice(0,240)}`);return text?JSON.parse(text):[];
}
async function all(table,query={}){const out=[];for(let offset=0;;offset+=1000){const part=await db(table,{...query,limit:'1000',offset:String(offset)});out.push(...part);if(part.length<1000)return out}}
async function one(table,query={}){return (await db(table,{...query,limit:'1'}))[0]||null}
async function requireUser(payload){const raw=clean(payload?.token);if(!raw||!/^[0-9a-f]{64}$/i.test(raw))throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');const session=await one('app_sessions',{token_hash:`eq.${await sha256(raw)}`,select:'username,expires_at'});if(!session||Date.parse(session.expires_at)<=Date.now())throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');const user=await one('app_users',{username:`eq.${session.username}`,select:'username,display_name,role,active'});if(!user||!user.active)throw new Error('Tài khoản đã bị khóa.');return user}

function accessoryTotal(o){return (o.card?10000:0)+(o.banner?35000:0)+num(o.charm_fee)+num(o.paper_fee)}
function paidAmount(payment,base){const text=norm(payment);if(!text||/chua/.test(text))return 0;if(/full|da tt|da thanh toan|thanh toan du/.test(text))return base;const m=text.replace(/\s/g,'').match(/([0-9.,]+)(k|tr|trieu)?/);if(!m)return 0;let a=num(m[1]);if(m[2]==='tr'||m[2]==='trieu')a*=1000000;else if(m[2]==='k'||(a>0&&a<=1000))a*=1000;return Math.max(0,a)}
function cleanTime(v){const m=clean(v).match(/(\d{1,2}):(\d{2})/);return m?`${m[1].padStart(2,'0')}:${m[2]}`:clean(v).slice(0,5)}
function dashboardOrder(o){const accessory=accessoryTotal(o);const ship=norm(o.shipping).includes('shop')?num(o.ship_fee):0;const base=num(o.flower_total)+accessory+num(o.vat);const total=base+ship;const paid=o.settled?total:paidAmount(o.payment,base);return {id:o.id,customer:o.customer||'',phone:o.phone||'',date:o.order_date,time:cleanTime(o.order_time),flower:o.flower||'',imageUrls:Array.isArray(o.image_urls)?o.image_urls:[],driveUrls:Array.isArray(o.image_urls)?o.image_urls:[],sampleUrls:Array.isArray(o.image_urls)?o.image_urls:[],note:o.note||'',shipping:o.shipping||'',address:o.address||'',flowerTotal:num(o.flower_total),payment:o.payment||'',paid,sale:o.sale||'',settled:!!o.settled,status:o.status||'Chờ bó',shipFee:num(o.ship_fee),vat:num(o.vat),accessoryTotal:accessory,debt:o.settled?0:Math.max(0,total-paid)} }

async function fastDashboard(payload){
  const user=await requireUser(payload);const start=clean(payload.start)||dateToday(),end=clean(payload.end)||start;
  let rows=await all('orders',{select:'id,customer,phone,order_date,order_time,flower,note,shipping,address,flower_total,payment,sale,status,settled,ship_fee,ship_confirmed,card,banner,charm_fee,paper_fee,vat,image_urls',and:`(order_date.gte.${start},order_date.lte.${end})`,order:'order_date.asc,order_time.asc'});
  if(user.role==='SALE'){const keys=new Set([norm(user.username),norm(user.display_name)].filter(Boolean));rows=rows.filter(r=>keys.has(norm(r.sale)))}
  const orders=rows.map(dashboardOrder);const summary={orders:0,revenue:0,grossRevenue:0,settledRevenue:0,unsettledRevenue:0,debt:0,cms:0,'Chờ bó':0,'Đã bó':0,'Đã giao':0,unsettled:0,alerts:0};
  const daily=new Map();const nearUnpacked=[],packedOverdue=[];const now=Date.now();
  for(const o of orders){summary.orders++;summary.grossRevenue+=o.flowerTotal;summary.debt+=o.debt;summary[o.status]=(summary[o.status]||0)+1;if(o.settled)summary.settledRevenue+=o.flowerTotal;else{summary.unsettledRevenue+=o.flowerTotal;summary.unsettled++}
    const key=`${o.date}|${o.sale||'Chưa gán'}`;const x=daily.get(key)||{date:o.date,sale:o.sale||'Chưa gán',orders:0,settledOrders:0,unsettledOrders:0,grossRevenue:0,settledRevenue:0,unsettledRevenue:0,revenue:0};x.orders++;x.grossRevenue+=o.flowerTotal;if(o.settled){x.settledOrders++;x.settledRevenue+=o.flowerTotal}else{x.unsettledOrders++;x.unsettledRevenue+=o.flowerTotal}x.revenue=x.settledRevenue;daily.set(key,x);
    const due=Date.parse(`${o.date}T${o.time||'00:00'}:00+07:00`);if(Number.isFinite(due)){if(o.status==='Chờ bó'&&due>=now&&due-now<=3600000)nearUnpacked.push(o);if(o.status==='Đã bó'&&due<now)packedOverdue.push(o)}
  }
  summary.revenue=summary.grossRevenue;summary.cms=summary.settledRevenue*.08;summary.nearUnpacked=nearUnpacked.length;summary.packedOverdue=packedOverdue.length;summary.alerts=summary.nearUnpacked+summary.packedOverdue;
  const salesDaily=[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)||(b.grossRevenue-a.grossRevenue)||a.sale.localeCompare(b.sale,'vi'));
  return {ok:true,range:{start,end},summary,attentionGroups:{nearUnpacked:nearUnpacked.slice(0,20),packedOverdue:packedOverdue.slice(0,20)},attention:[...nearUnpacked,...packedOverdue].slice(0,40),salesDaily,revenueRule:'SPLIT_SETTLEMENT',revenueLabels:{unsettled:'Doanh thu chưa tất toán',settled:'Doanh thu đã tất toán'}};
}

async function patchBootstrapDashboard(name,payload,result){
  if(!result?.ok||result?.initial?.page!=='dashboard')return result;
  const bootToken=name==='loginAndBootstrap'?clean(result.token):clean(payload?.token);
  if(!bootToken)return result;
  const day=dateToday();
  const fresh=await fastDashboard({token:bootToken,start:day,end:day});
  return {...result,initial:{...result.initial,data:fresh,at:Date.now()}};
}

function localFlowers(text){const raw=clean(text),n=norm(raw),out=[];const add=x=>{if(x&&!out.includes(x))out.push(x)};
  if(/\b(ly|li|lily|lilies)\b/.test(n)){let label='Ly';if(/xanh/.test(n)&&/nhuom/.test(n))label=/dam/.test(n)?'Ly xanh nhuộm đậm':'Ly xanh nhuộm';else if(/son\s*xanh/.test(n))label=/dam/.test(n)?'Ly sơn xanh đậm':'Ly sơn xanh';else if(/tim\s*pastel/.test(n))label='Ly tím pastel';else if(/xanh\s*mint/.test(n))label='Ly xanh mint';else if(/hong/.test(n))label='Ly hồng';else if(/vang\s*cam/.test(n))label='Ly vàng cam';else if(/kep/.test(n))label='Ly kép';add(label)}
  if(/hong\s*(ecu|ecuador)|ecuador/.test(n))add('Hồng Ecuador');if(/chiet\s*xa/.test(n))add('Chiết xạ');if(/\bohara\b/.test(n))add('Hồng Ohara');if(/\b(phang|phan|carnation)\b/.test(n))add('Hoa phăng');if(/\btulip\b/.test(n))add('Tulip');if(/\bbaby\b/.test(n))add(/xanh/.test(n)?'Baby xanh':'Baby');if(/cam\s*tu\s*cau/.test(n))add('Cẩm tú cầu');if(/thanh\s*lieu/.test(n))add('Thanh liễu');if(/huong\s*duong/.test(n))add('Hướng dương');if(/mao\s*luong/.test(n))add('Mao lương');if(/dong\s*tien/.test(n))add('Đồng tiền');return out}
async function fallbackFlowers(payload){const user=await requireUser(payload);if(!['ADMIN','THO_OPS'].includes(user.role))throw new Error('Không có quyền thực hiện.');const date=clean(payload.date)||dateToday();const rows=await all('orders',{select:'id,customer,order_date,order_time,flower',and:`(order_date.gte.${date},order_date.lte.${date})`,order:'order_time.asc'});const groups=new Map(),reviewOrders=[];for(const o of rows){const names=localFlowers(o.flower);if(!names.length)reviewOrders.push({id:o.id,customer:o.customer,flower:o.flower,date:o.order_date,time:cleanTime(o.order_time)});for(const name of names){const g=groups.get(name)||{name,orders:0,orderList:[]};g.orders++;g.orderList.push({id:o.id,customer:o.customer,flower:o.flower,date:o.order_date,time:cleanTime(o.order_time)});groups.set(name,g)}}return {ok:true,status:'ready',totalOrders:rows.length,analyzedOrders:rows.length,reviewCount:reviewOrders.length,items:[...groups.values()].sort((a,b)=>b.orders-a.orders||a.name.localeCompare(b.name,'vi')),reviewOrders,classifierVersion:'v364-local-fallback',aiModel:null,aiStatus:'FALLBACK_NO_KEY',aiMessage:'Gemini API key chưa được cấu hình; đang dùng bộ phân loại local tạm thời.',fallback:true}}

async function delegate(raw,request){const upstream=await fetch(V363_API,{method:'POST',headers:{'Content-Type':'application/json',Authorization:request.headers.get('authorization')||'',apikey:request.headers.get('apikey')||''},body:raw});const text=await upstream.text();let data={};try{data=text?JSON.parse(text):{}}catch(_){data={ok:false,message:'Máy chủ trả dữ liệu không hợp lệ.'}}return {status:upstream.status,data}}

Deno.serve(async request=>{const cors=corsHeaders(request.headers.get('origin')||'');if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});if(request.method!=='POST')return new Response(JSON.stringify({ok:false,message:'Method not allowed',build:UI_BUILD}),{status:405,headers:cors});const started=Date.now();try{const raw=await request.text();let input={};try{input=raw?JSON.parse(raw):{}}catch(_){}const name=clean(input?.name),payload=input?.payload&&typeof input.payload==='object'?input.payload:{};let result,status=200;if(name==='getDashboardSummary'){result=await fastDashboard(payload)}else if(name==='getFlowerInventory'&&!GEMINI_KEY){result=await fallbackFlowers(payload)}else if(name==='loginAndBootstrap'||name==='getCurrentUserAndBootstrap'){const u=await delegate(raw,request);result=await patchBootstrapDashboard(name,payload,u.data);status=u.status}else{const u=await delegate(raw,request);result=u.data;status=u.status}const perf=result?._perf&&typeof result._perf==='object'?result._perf:{};return new Response(JSON.stringify({...result,build:UI_BUILD,proxyBuild:PROXY_BUILD,_perf:{...perf,serverMs:Date.now()-started,proxy:'v364'}}),{status,headers:cors})}catch(error){return new Response(JSON.stringify({ok:false,message:error?.message||'Máy chủ gặp lỗi. Vui lòng thử lại.',code:'SERVER_ERROR',build:UI_BUILD,proxyBuild:PROXY_BUILD}),{status:200,headers:cors})}});
