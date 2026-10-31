#!/usr/bin/env node
// Non-destructive, resumable backfill. Dry run unless --apply is supplied.
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the local environment.
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';

const run=promisify(execFile);
const base=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');
const apply=process.argv.includes('--apply');
const bucket='order-images';
const canonical=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;
if(!base||!key)throw Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base))throw Error('Unexpected Supabase URL');
const headers={apikey:key,Authorization:`Bearer ${key}`};
async function json(response,label){
  if(!response.ok)throw Error(`${label} failed (${response.status})`);
  return response.json();
}
async function listObjects(){
  const names=[];
  for(let offset=0;;offset+=1000){
    const result=await json(await fetch(`${base}/storage/v1/object/list/${bucket}`,{
      method:'POST',headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify({prefix:'',limit:1000,offset,sortBy:{column:'name',order:'asc'}})
    }),'list');
    names.push(...result.map(item=>String(item.name||'')));
    if(result.length<1000)break;
  }
  return new Set(names);
}
async function processOne(name){
  const preview=name.replace(/\.jpg$/i,'.preview.jpg');
  const signed=await json(await fetch(`${base}/storage/v1/object/sign/${bucket}/${name}`,{
    method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({expiresIn:600})
  }),'sign');
  if(!String(signed.signedURL||'').startsWith(`/object/sign/${bucket}/${name}?`))throw Error('Unexpected signed URL');
  const image=await fetch(`${base}/storage/v1${signed.signedURL}`);
  if(!image.ok)throw Error(`download failed (${image.status})`);
  const dir=await mkdtemp(join(tmpdir(),'meehoa-preview-'));
  try{
    const input=join(dir,'original.jpg'),output=join(dir,'preview.jpg');
    await writeFile(input,Buffer.from(await image.arrayBuffer()),{mode:0o600});
    await run('sips',['-s','format','jpeg','-s','formatOptions','55','-Z','360',input,'--out',output],{timeout:30000});
    const bytes=await readFile(output);
    if(bytes.length<100||bytes.length>100*1024)throw Error(`preview size ${bytes.length} outside 100 B–100 KiB`);
    const response=await fetch(`${base}/storage/v1/object/${bucket}/${preview}`,{
      method:'POST',headers:{...headers,'Content-Type':'image/jpeg','x-upsert':'false','cache-control':'3600'},body:bytes
    });
    if(!response.ok){
      const message=await response.text();
      if(!/already exists/i.test(message))throw Error(`upload failed (${response.status})`);
    }
    return bytes.length;
  }finally{await rm(dir,{recursive:true,force:true});}
}
const names=await listObjects();
const originals=[...names].filter(name=>canonical.test(name));
const missing=originals.filter(name=>!names.has(name.replace(/\.jpg$/i,'.preview.jpg')));
console.log(JSON.stringify({mode:apply?'apply':'dry-run',originals:originals.length,previews:originals.length-missing.length,missing:missing.length}));
if(apply){
  let completed=0,totalBytes=0;
  for(let i=0;i<missing.length;i+=3){
    const batch=await Promise.allSettled(missing.slice(i,i+3).map(processOne));
    for(const result of batch){
      if(result.status==='rejected')throw result.reason;
      completed++;totalBytes+=result.value;
    }
    if(completed%60===0||completed===missing.length)console.log(JSON.stringify({completed,total:missing.length,previewMiB:Number((totalBytes/1048576).toFixed(2))}));
  }
  const after=await listObjects();
  const remaining=originals.filter(name=>!after.has(name.replace(/\.jpg$/i,'.preview.jpg')));
  console.log(JSON.stringify({verified:remaining.length===0,remaining:remaining.length,previewMiB:Number((totalBytes/1048576).toFixed(2))}));
  if(remaining.length)process.exitCode=1;
}
