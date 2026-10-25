// Runs candidate business code unchanged except the Deno listener's local port.
// Database, REST and Storage are real local services, not response fixtures.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'artifacts/staging');
const cfg=JSON.parse(fs.readFileSync(path.join(dir,'supabase.local.json'),'utf8'));
if(cfg.API_URL!=='http://127.0.0.1:54321')throw Error('Local QA URL required');
const deno=process.env.MEEHOA_DENO;if(!deno)throw Error('Set MEEHOA_DENO to the installed Deno binary');
const runtime=path.join(dir,'runtime/functions');fs.mkdirSync(runtime,{recursive:true});
fs.cpSync(path.join(root,'supabase/functions/_shared'),path.join(runtime,'_shared'),{recursive:true});
const children=[];
for(const [name,extension,port] of [['meehoasg-api-core','js',4181],['meehoasg-api','js',4182],['meehoasg-order-actions','ts',4183]]){
 const source=fs.readFileSync(path.join(root,'supabase/functions',name,'index.'+extension),'utf8');
 if((source.match(/Deno\.serve\(/g)||[]).length!==1)throw Error('Expected one Deno entrypoint');
 const target=path.join(runtime,name,'index.'+extension);fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(target,source.replace('Deno.serve(',`Deno.serve({hostname:'127.0.0.1',port:${port}},`));
 const log=fs.openSync(path.join(dir,name+'.local.log'),'a',0o600);
 const child=spawn(deno,['run','--no-prompt','--allow-net=127.0.0.1','--allow-env',target],{env:{...process.env,SUPABASE_URL:cfg.API_URL,SUPABASE_SERVICE_ROLE_KEY:cfg.SERVICE_ROLE_KEY,SUPABASE_ANON_KEY:cfg.ANON_KEY,GEMINI_API_KEY:'',GEMINI_MODEL:'',LEGACY_PASSWORD_SALT:'MEE-FLOWER-V4'},stdio:['ignore',log,log]});
 child.on('error',e=>console.error('QA runtime startup failed',name,e.message));children.push(child);
}
const gateway=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,cfg.API_URL);let target;
  if(url.pathname.startsWith('/rest/v1/'))target='http://127.0.0.1:54323/'+url.pathname.slice('/rest/v1/'.length)+url.search;
  else if(url.pathname.startsWith('/storage/v1/'))target='http://127.0.0.1:54324/'+url.pathname.slice('/storage/v1/'.length)+url.search;
  else if(url.pathname.startsWith('/functions/v1/')){
   const port={'meehoasg-api-core':4181,'meehoasg-api':4182,'meehoasg-order-actions':4183}[url.pathname.slice('/functions/v1/'.length)];
   if(!port){res.writeHead(404);return res.end();}
   if(![cfg.ANON_KEY,cfg.SERVICE_ROLE_KEY].includes((req.headers.authorization||'').replace(/^Bearer /,''))){res.writeHead(401);return res.end('{"ok":false,"code":"QA_GATEWAY_AUTH_REQUIRED"}');}
   target='http://127.0.0.1:'+port+'/';
  }else {res.writeHead(404);return res.end();}
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>13*1024*1024)throw Error('Request too large');chunks.push(chunk);}
  const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];
  const upstream=await fetch(target,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
  const responseHeaders={'cache-control':'no-store','access-control-allow-origin':'http://127.0.0.1:4173','access-control-allow-methods':'GET,HEAD,POST,PUT,OPTIONS','access-control-allow-headers':'content-type,authorization,apikey,x-upsert','vary':'Origin'};
  for(const key of ['content-type','content-length','content-range','range-unit'])if(upstream.headers.has(key))responseHeaders[key]=upstream.headers.get(key);
  res.writeHead(upstream.status,responseHeaders);res.end(Buffer.from(await upstream.arrayBuffer()));
 }catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,message:'Local QA upstream unavailable: '+e.message}));}
});
gateway.listen(54321,'127.0.0.1',()=>{
 const child=spawn(process.execPath,[path.join(__dirname,'staging-web.cjs')],{cwd:root,stdio:'inherit'});children.push(child);
 console.log('Local QA gateway ready; network restricted to loopback for candidate functions.');
});
function stop(){for(const c of children)c.kill('SIGTERM');gateway.close(()=>process.exit(0));}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
