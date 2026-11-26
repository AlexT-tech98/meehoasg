import {createR2Media} from '../_shared/r2-media.js';

const source=Deno.env.get('SUPABASE_URL');
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const consoleKey=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
const media=createR2Media({
  accountId:Deno.env.get('R2_ACCOUNT_ID'),
  accessKeyId:Deno.env.get('R2_ACCESS_KEY_ID'),
  secretAccessKey:Deno.env.get('R2_SECRET_ACCESS_KEY'),
  bucket:Deno.env.get('R2_MEDIA_BUCKET'),
  endpointUrl:Deno.env.get('R2_ENDPOINT_URL')||'',
});
const headers={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};
const validPath=/^[0-9a-f-]{36}(?:\.preview)?\.(?:jpg|png|webp)$/;
const validMonth=/^\d{4}-(?:0[1-9]|1[0-2])$/;
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
function same(a,b){a=String(a||'');b=String(b||'');if(!a||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}

function monthBounds(month){
  const [y,m]=month.split('-').map(Number);
  const nextY=m===12?y+1:y;
  const nextM=m===12?1:m+1;
  const start=Date.parse(`${month}-01T00:00:00+07:00`);
  const end=Date.parse(`${String(nextY).padStart(4,'0')}-${String(nextM).padStart(2,'0')}-01T00:00:00+07:00`);
  return {start,end};
}

async function inventory(bucket,offset,limit,month){
  const response=await fetch(`${source}/storage/v1/object/list/${bucket}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prefix:'',limit,offset,sortBy:{column:'name',order:'asc'}})});
  if(!response.ok)throw Error(`SOURCE_LIST_${response.status}`);
  const objects=await response.json();
  if(!Array.isArray(objects))throw Error('SOURCE_LIST_INVALID');
  for(const object of objects)if(object.id&&!validPath.test(object.name))throw Error('SOURCE_PATH_INVALID');
  if(objects.some(object=>object.id&&!Number.isFinite(Date.parse(object.created_at))))throw Error('SOURCE_DATE_INVALID');
  if(month==='all'){
    return {selected:objects.filter(object=>object.id).map(object=>object.name),scanned:objects.length};
  }
  const {start,end}=monthBounds(month);
  const selected=objects.filter(object=>object.id&&Date.parse(object.created_at)>=start&&Date.parse(object.created_at)<end).map(object=>object.name);
  return {selected,scanned:objects.length};
}

async function checkOne(bucket,name,mode){
  const key=`${bucket}/${name}`;
  const original=await fetch(`${source}/storage/v1/object/authenticated/${key}`,{headers});
  if(!original.ok)throw Error(`SOURCE_GET_${original.status}`);
  const bytes=await original.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>5*1024*1024)throw Error('SOURCE_SIZE_INVALID');
  const expected=await sha(bytes);
  const read=async()=>fetch(await media.signedUrl('GET',key,{expiresSeconds:300}));
  let destination=await read();
  let copied=false;
  if(destination.status===404&&mode==='copy'){
    const contentType=name.endsWith('.png')?'image/png':name.endsWith('.webp')?'image/webp':'image/jpeg';
    const put=await fetch(await media.signedUrl('PUT',key,{expiresSeconds:300,contentType}),{method:'PUT',headers:{'Content-Type':contentType},body:bytes});
    if(!put.ok)throw Error(`R2_PUT_${put.status}`);
    copied=true;
    destination=await read();
  }
  if(!destination.ok)throw Error(`R2_GET_${destination.status}`);
  const received=await destination.arrayBuffer();
  if(received.byteLength!==bytes.byteLength||await sha(received)!==expected)throw Error('R2_HASH_MISMATCH');
  return {name,size:bytes.byteLength,sha256:expected,copied};
}

export async function runCopyBatch(input){
  const bucket=input?.bucket,mode=input?.mode;
  if(!['order-images','settlement-bills'].includes(bucket)||!['copy','verify'].includes(mode))throw Error('INPUT_INVALID');
  let names=[],scanned=0,offset=0,limit=0,month=input?.month||'';
  if(Array.isArray(input?.keys)){
    if(!input.keys.length||input.keys.length>50)throw Error('KEYS_BATCH_INVALID');
    names=[...new Set(input.keys.map(k=>String(k||'').trim()))];
    if(names.some(name=>!validPath.test(name)))throw Error('KEY_PATH_INVALID');
    scanned=names.length;
    month='explicit-keys';
  }else{
    offset=Number(input?.offset);limit=Number(input?.limit);
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw Error('INPUT_INVALID');
    if(month!=='all'&&!validMonth.test(month))throw Error('INPUT_INVALID');
    const listed=await inventory(bucket,offset,limit,month);
    names=listed.selected;
    scanned=listed.scanned;
  }
  const results=[];
  for(let i=0;i<names.length;i+=8){
    const group=await Promise.allSettled(names.slice(i,i+8).map(name=>checkOne(bucket,name,mode)));
    results.push(...group);
    if(group.some(row=>row.status==='rejected'))break;
  }
  const failed=results.map((row,i)=>row.status==='rejected'?{name:names[i],reason:String(row.reason?.message||row.reason)}:null).filter(Boolean);
  const checked=results.filter(row=>row.status==='fulfilled').map(row=>row.value);
  return {
    ok:failed.length===0,
    bucket,offset,limit,mode,month,scanned,
    listed:names.length,
    checked:checked.length,
    copied:checked.filter(row=>row.copied).length,
    bytes:checked.reduce((sum,row)=>sum+row.size,0),
    verifiedKeys:checked.map(row=>row.name),
    failed,
    nextOffset:offset+limit,
    done:Array.isArray(input?.keys)?true:scanned<limit,
  };
}

Deno.serve(async request=>{
  if(request.method!=='POST'||!same(request.headers.get('apikey'),consoleKey))return new Response('Forbidden',{status:403});
  try{return Response.json(await runCopyBatch(await request.json()));}
  catch(error){return Response.json({ok:false,error:String(error?.message||error)},{status:400});}
});
