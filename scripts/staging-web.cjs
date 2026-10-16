// Local QA gateway: candidate UI, real local Supabase APIs, no fixture responses.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'artifacts/staging');
const settings=JSON.parse(fs.readFileSync(path.join(dir,'supabase.local.json'),'utf8'));
const anon=settings.ANON_KEY||settings.anon_key;
if(!anon)throw Error('Local anon key missing');
const api=settings.API_URL||settings.api_url;
if(api!=='http://127.0.0.1:54321')throw Error('Refusing non-loopback Supabase URL');
if(!fs.existsSync(path.join(dir,'environment.json')))throw Error('Seed and verify local QA marker first');
const production='https://zxnfhshnavbmvdthrmrd.supabase.co';
const jwt=/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
function prepare(s){const result=s.replaceAll(production,'').replace(jwt,anon);if(result.includes('zxnfhshnavbmvdthrmrd'))throw Error('Production reference leaked into QA frontend');return result;}
const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://127.0.0.1:4173');
  if(u.pathname.startsWith('/functions/v1/')){
   if(!/^\/functions\/v1\/(meehoasg-api-core|meehoasg-api|meehoasg-order-actions)$/.test(u.pathname)){res.writeHead(404);return res.end();}
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>13*1024*1024)throw Error('Body too large');chunks.push(chunk);}
   const upstream=await fetch(api+u.pathname,{method:req.method,headers:{'content-type':'application/json',apikey:anon,authorization:'Bearer '+anon},...(req.method==='GET'?{}:{body:Buffer.concat(chunks)})});
   res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json','cache-control':'no-store'});return res.end(Buffer.from(await upstream.arrayBuffer()));
  }
  if(u.pathname==='/__qa_health'){
   await Promise.all(['meehoasg-api-core','meehoasg-api','meehoasg-order-actions'].map(async name=>{const r=await fetch(api+'/functions/v1/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+anon,apikey:anon},body:JSON.stringify({name:'getCurrentUserAndBootstrap',payload:{}})});if(r.status!==200)throw Error('QA function not ready');await r.text();}));
   res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({environment:'meehoa-pr39-local-synthetic',backend:api}));
  }
  const file=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
  if(!['index.html','html','manifest.webmanifest'].includes(file)&&!file.startsWith('assets/')){res.writeHead(404);return res.end();}
  const full=path.resolve(root,file);if(!full.startsWith(root+path.sep))throw Error('Invalid path');
  let bytes=fs.readFileSync(full);if(/\.(?:js|html|webmanifest)$/.test(file)||file==='html')bytes=Buffer.from(prepare(bytes.toString('utf8')));
  const type=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':'text/html';
  res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(bytes);
 }catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,message:e.message}));}
});
server.listen(4173,'127.0.0.1',()=>console.log('MEEHOA synthetic QA: http://127.0.0.1:4173; real local Supabase backend; no production routing'));
