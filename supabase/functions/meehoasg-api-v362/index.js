const BUILD = '2026.10.01-v362';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY');
const ENV_GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || '';
const V361_API = `${SUPABASE_URL}/functions/v1/meehoasg-api-v361`;
const ALLOWED_ORIGINS = [
  'https://ops.meehoasg.com',
  'http://ops.meehoasg.com',
  'https://meehoasg.com',
  'http://meehoasg.com'
];

function clean(v){ return String(v ?? '').trim(); }
function norm(v){ return clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase().replace(/\s+/g,' '); }
function flowerKey(v){ return norm(v).replace(/\s+/g,' '); }
function fail(message, code){ return {ok:false,message,...(code?{code}:{})}; }
function dateToday(){ return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
async function sha256(text){ const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))); return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join(''); }

async function db(table, query={}, method='GET', body){
  const url=new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(query).forEach(([k,v])=>{ if(v!==undefined&&v!==null) url.searchParams.set(k,String(v)); });
  const res=await fetch(url,{
    method,
    headers:{
      apikey:SERVICE_KEY,
      Authorization:`Bearer ${SERVICE_KEY}`,
      'Content-Type':'application/json',
      Prefer:method==='GET'?'count=exact':(query.on_conflict?'return=representation,resolution=merge-duplicates':'return=representation')
    },
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const text=await res.text();
  if(!res.ok) throw new Error(`Database ${res.status}: ${text.slice(0,300)}`);
  return text?JSON.parse(text):[];
}
async function all(table, query={}){
  const out=[];
  for(let offset=0;;offset+=1000){
    const part=await db(table,{...query,limit:'1000',offset:String(offset)});
    out.push(...part);
    if(part.length<1000) return out;
  }
}
async function one(table, query={}){ return (await db(table,{...query,limit:'1'}))[0]||null; }

async function delegate(name,payload,request){
  const res=await fetch(V361_API,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      Authorization:request.headers.get('authorization')||'',
      apikey:request.headers.get('apikey')||''
    },
    body:JSON.stringify({name,payload})
  });
  const text=await res.text();
  let data;
  try{ data=text?JSON.parse(text):{}; }catch(_){ data=fail('Máy chủ trả dữ liệu không hợp lệ.'); }
  return {status:res.status,data};
}

async function requireProxyUser(payload,roles){
  const raw=clean(payload?.token);
  if(!raw||!/^[0-9a-f]{64}$/i.test(raw)) throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
  const tokenHash=await sha256(raw);
  const session=await one('app_sessions',{token_hash:`eq.${tokenHash}`,select:'username,expires_at'});
  if(!session||Date.parse(session.expires_at)<=Date.now()) throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
  const user=await one('app_users',{username:`eq.${session.username}`,select:'username,display_name,role,active'});
  if(!user||!user.active) throw new Error('Tài khoản đã bị khóa.');
  if(roles&&!roles.includes(user.role)) throw new Error('Không có quyền thực hiện.');
  return user;
}

function titleCaseIngredient(value){
  const raw=clean(value).replace(/\s+/g,' ');
  return raw?raw.charAt(0).toUpperCase()+raw.slice(1):'';
}
function normalizeLyLabel(raw){
  let value=clean(raw).replace(/\s+/g,' ');
  value=value.replace(/^hoa\s+(?=(?:ly|li|lily|lilies)\b)/i,'');
  value=value.replace(/\b(?:lilies|lily|li|ly)\b/i,'Ly').trim();
  const n=norm(value);
  if(!/^ly\b/.test(n)) return '';
  if(/son\s*xanh/.test(n)) return /dam/.test(n)?'Ly sơn xanh đậm':'Ly sơn xanh';
  if(/xanh/.test(n)&&/nhuom/.test(n)) return /dam/.test(n)?'Ly xanh nhuộm đậm':'Ly xanh nhuộm';
  const parts=value.match(/^Ly(?:\s+(.+))?$/i);
  if(!parts) return 'Ly';
  const modifier=clean(parts[1]);
  if(!modifier) return 'Ly';
  return 'Ly '+modifier.charAt(0).toLocaleLowerCase('vi')+modifier.slice(1);
}
function canonicalIngredientName(value){
  const raw=clean(value).replace(/\s+/g,' ');
  const n=norm(raw);
  if(!n) return '';
  if(/hong\s*(ecu|ecuador)|ecuador\s*rose|rose\s*ecuador/.test(n)) return 'Hồng Ecuador';
  if(/chiet\s*xa/.test(n)) return 'Chiết xạ';
  if(/^(?:hoa\s+)?(ly|li|lily|lilies)\b/.test(n)||/\b(ly|li|lily|lilies)\b/.test(n)) return normalizeLyLabel(raw)||'Ly';
  return titleCaseIngredient(raw);
}
function canonicalIngredients(values){
  const map=new Map();
  for(const v of Array.isArray(values)?values:[]){
    const name=canonicalIngredientName(v);
    if(name) map.set(flowerKey(name),name);
  }
  return [...map.values()];
}

function aiModels(){
  return [...new Set([
    'gemini-3.8-flash',
    ENV_GEMINI_MODEL,
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash'
  ].filter(Boolean))];
}

async function classifyIngredients(items){
  const models=aiModels();
  if(!items.length) return {ok:true,model:null,results:[],modelsTried:[]};
  if(!GEMINI_KEY){
    console.error('v362 material AI unavailable: GEMINI_API_KEY missing');
    return {ok:false,code:'AI_KEY_MISSING',message:'AI chưa được cấu hình API key.',modelsTried:models};
  }

  const prompt=`Bạn là AI phân tích NGUYÊN LIỆU HOA cho tiệm hoa.
Mỗi input là mô tả một đơn hàng. Hãy xác định CÁC LOẠI HOA phải chuẩn bị.

QUY TẮC:
- Sửa lỗi chính tả và tên đồng nghĩa nhưng giữ đúng giống/màu/xử lý/biến thể có ý nghĩa mua nguyên liệu.
- lily / lilies / ly / li => Ly nếu không có đặc tính.
- Có đặc tính thì giữ: Ly kép, Ly hồng, Ly tím pastel, Ly xanh mint, Ly xanh nhuộm, Ly sơn xanh...
- hồng ecu / ecuador => Hồng Ecuador.
- chiết xạ => Chiết xạ.
- Một đơn có nhiều loại hoa: trả tất cả.
- Không đếm số cành. Không trả giấy, nơ, thiệp, charm, phụ kiện, kiểu gói.
- "như mẫu", "cover mẫu" mà không có tên hoa rõ ràng => flowers=[] và needs_review=true.
- Nếu text có tên hoa đủ rõ thì needs_review=false.
- Giữ nguyên fingerprint.

Chỉ trả JSON:
{"results":[{"fingerprint":"...","flowers":["..."],"needs_review":false}]}

DỮ LIỆU:
${JSON.stringify(items)}`;

  const body={
    contents:[{role:'user',parts:[{text:prompt}]}],
    generationConfig:{temperature:0.05,responseMimeType:'application/json'}
  };
  const diagnostics=[];

  for(const model of models){
    try{
      const response=await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method:'POST',
          headers:{'Content-Type':'application/json','x-goog-api-key':GEMINI_KEY},
          body:JSON.stringify(body)
        }
      );
      const rawText=await response.text();
      if(!response.ok){
        diagnostics.push({model,status:response.status});
        console.warn('v362 material AI rejected',model,response.status,rawText.slice(0,240));
        continue;
      }
      let data={};
      try{ data=rawText?JSON.parse(rawText):{}; }catch(e){
        diagnostics.push({model,status:response.status,parse:'response-json'});
        console.warn('v362 material AI bad response JSON',model,e?.message||e);
        continue;
      }
      const raw=(data?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');
      let parsed={};
      try{ parsed=JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0]||'{}'); }catch(e){
        diagnostics.push({model,status:response.status,parse:'model-json'});
        console.warn('v362 material AI bad model JSON',model,raw.slice(0,240));
        continue;
      }
      if(Array.isArray(parsed.results)){
        console.log('v362 material AI success',model,'items',items.length,'results',parsed.results.length);
        return {ok:true,model,results:parsed.results,modelsTried:[...diagnostics.map(x=>x.model),model]};
      }
      diagnostics.push({model,status:response.status,parse:'missing-results'});
    }catch(e){
      diagnostics.push({model,error:String(e?.message||e).slice(0,160)});
      console.error('v362 material AI failed',model,e);
    }
  }

  return {
    ok:false,
    code:'AI_MODELS_FAILED',
    message:'AI chưa phản hồi được. Hệ thống không tự đẩy toàn bộ đơn sang cần rà soát.',
    modelsTried:models,
    diagnostics
  };
}

async function patchFlowers(payload){
  await requireProxyUser(payload,['ADMIN','THO_OPS']);
  const date=clean(payload.date)||dateToday();
  const orders=await all('orders',{
    select:'id,customer,order_date,order_time,flower',
    and:`(order_date.gte.${date},order_date.lte.${date})`,
    order:'order_time.asc'
  });

  if(!orders.length){
    return {
      ok:true,status:'empty',totalOrders:0,analyzedOrders:0,reviewCount:0,
      items:[],reviewOrders:[],classifierVersion:'v362-ai-fix',
      aiModel:null,aiStatus:'EMPTY'
    };
  }

  const uniqueMap=new Map();
  for(const order of orders){
    const content=clean(order.flower).slice(0,700);
    const key=flowerKey(content);
    if(key&&!uniqueMap.has(key)) uniqueMap.set(key,content);
  }

  const unique=[...uniqueMap.entries()];
  const keyed=await Promise.all(unique.map(async([key,content])=>({
    key,content,fingerprint:await sha256(`v362-ai-fix|${key}`)
  })));

  const cacheRows=await all('flower_cache',{
    select:'fingerprint,content,flowers,needs_review,updated_at',
    order:'updated_at.desc'
  });
  const cache=new Map(cacheRows.map(row=>[row.fingerprint,row]));
  const pending=keyed.filter(x=>payload.forceRefresh||!cache.has(x.fingerprint));

  let aiModel=null;
  let aiStatus='CACHE';
  let aiFailure=null;

  for(let i=0;i<pending.length;i+=35){
    const batch=pending.slice(i,i+35).map(x=>({fingerprint:x.fingerprint,note:x.content}));
    const classified=await classifyIngredients(batch);
    if(!classified.ok){
      aiStatus=classified.code||'AI_UNAVAILABLE';
      aiFailure=classified;
      break;
    }
    aiStatus='READY';
    aiModel=classified.model||aiModel;
    const byId=new Map((classified.results||[]).filter(r=>r?.fingerprint).map(r=>[r.fingerprint,r]));
    const rows=batch.map(item=>{
      const result=byId.get(item.fingerprint)||{};
      const flowers=canonicalIngredients(result.flowers);
      return {
        fingerprint:item.fingerprint,
        content:item.note,
        flowers,
        needs_review:!!result.needs_review||!flowers.length,
        updated_at:new Date().toISOString()
      };
    });
    if(rows.length){
      await db('flower_cache',{on_conflict:'fingerprint'},'POST',rows);
      rows.forEach(row=>cache.set(row.fingerprint,row));
    }
  }

  if(aiFailure){
    return {
      ok:true,
      status:'ai_unavailable',
      totalOrders:orders.length,
      analyzedOrders:0,
      reviewCount:0,
      items:[],
      reviewOrders:[],
      classifierVersion:'v362-ai-fix',
      aiStatus,
      aiModel:null,
      aiModelsTried:aiFailure.modelsTried||[],
      aiMessage:aiFailure.message||'AI nguyên liệu đang tạm thời không khả dụng.'
    };
  }

  const fingerprintByKey=new Map(keyed.map(x=>[x.key,x.fingerprint]));
  const groups=new Map();
  const reviewOrders=[];
  let analyzedOrders=0;

  for(const order of orders){
    const key=flowerKey(order.flower);
    const fp=fingerprintByKey.get(key);
    const entry=fp?cache.get(fp):null;
    const names=canonicalIngredients(entry?.flowers);
    if(entry) analyzedOrders++;
    if(!entry||entry.needs_review||!names.length){
      reviewOrders.push({
        id:order.id,
        customer:order.customer,
        flower:order.flower,
        date:order.order_date,
        time:clean(order.order_time).slice(0,5)
      });
    }
    for(const name of names){
      const gk=flowerKey(name);
      const group=groups.get(gk)||{name,orders:0,orderList:[]};
      if(!group.orderList.some(x=>x.id===order.id)){
        group.orders++;
        group.orderList.push({
          id:order.id,
          customer:order.customer,
          flower:order.flower,
          time:clean(order.order_time).slice(0,5),
          date:order.order_date
        });
      }
      groups.set(gk,group);
    }
  }

  const items=[...groups.values()].sort((a,b)=>b.orders-a.orders||a.name.localeCompare(b.name,'vi'));
  return {
    ok:true,
    status:reviewOrders.length?'needs_review':'ready',
    totalOrders:orders.length,
    analyzedOrders,
    reviewCount:reviewOrders.length,
    items,
    reviewOrders:reviewOrders.slice(0,100),
    classifierVersion:'v362-ai-fix',
    aiStatus,
    aiModel,
    aiModelsTried:aiModels()
  };
}

Deno.serve(async request=>{
  const origin=request.headers.get('origin');
  const allowOrigin=ALLOWED_ORIGINS.includes(origin)
    ? origin
    : (origin&&(origin.includes('localhost')||origin.includes('127.0.0.1'))?origin:'https://ops.meehoasg.com');
  const cors={
    'Access-Control-Allow-Origin':allowOrigin,
    'Access-Control-Allow-Methods':'POST, OPTIONS',
    'Access-Control-Allow-Headers':'content-type, authorization, apikey',
    'Content-Type':'application/json; charset=utf-8',
    'Vary':'Origin'
  };

  if(origin&&!ALLOWED_ORIGINS.includes(origin)&&!origin.includes('localhost')&&!origin.includes('127.0.0.1')){
    return new Response('Forbidden',{status:403,headers:cors});
  }
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  if(request.method!=='POST') return new Response('Method not allowed',{status:405,headers:cors});
  if(!SUPABASE_URL||!SERVICE_KEY){
    return new Response(JSON.stringify({...fail('Máy chủ chưa cấu hình.'),build:BUILD}),{status:503,headers:cors});
  }

  const started=Date.now();
  try{
    if(Number(request.headers.get('content-length')||0)>12*1024*1024){
      return new Response(JSON.stringify({...fail('Dữ liệu gửi lên quá lớn.'),build:BUILD}),{status:413,headers:cors});
    }
    const input=await request.json();
    const name=clean(input?.name);
    const payload=input?.payload&&typeof input.payload==='object'?input.payload:{};
    let result;

    if(name==='getFlowerInventory'){
      result=await patchFlowers(payload);
    }else{
      const delegated=await delegate(name,payload,request);
      result=delegated.data;
    }

    return new Response(
      JSON.stringify({...result,build:BUILD,_perf:{serverMs:Date.now()-started,proxy:'v362'}}),
      {headers:cors}
    );
  }catch(error){
    console.error('Meehoasg API v362 error:',error);
    return new Response(
      JSON.stringify({...fail(error?.message||'Máy chủ gặp lỗi. Vui lòng thử lại.','SERVER_ERROR'),build:BUILD}),
      {status:200,headers:cors}
    );
  }
});
