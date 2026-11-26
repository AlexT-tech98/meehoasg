import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

if(process.env.ALLOW_OVERWRITE_RUNTIME!=='1'){
  console.error('Refusing to overwrite runtime/core.js and runtime/legacy.js from live-snapshot/.');
  console.error('runtime/ is now canonical source. Set ALLOW_OVERWRITE_RUNTIME=1 only if intentionally regenerating from a local snapshot.');
  process.exit(1);
}

const root=import.meta.dirname;
for(const [name,source] of [['legacy','api'],['core','core']]){
  let code=await readFile(resolve(root,`live-snapshot/${source}/index.js`),'utf8');
  code=code.replace("import {createOperationStorage} from '../_shared/storage.js';", "import {createMediaStorage} from './media.js';\nimport {createDb} from './db.js';\nimport {createOperationRpc} from './operations.js';");
  code=code.replace("import {createOperationService} from '../_shared/operations.js';", "import {createOperationService} from './operation-service.js';");
  if(name==='core')code="import {createLegacy} from './legacy.js';\n"+code;
  const firstConst=code.indexOf('const BUILD');
  code=code.slice(0,firstConst)+`export function create${name==='core'?'Core':'Legacy'}(env){\n`+code.slice(firstConst);
  code=code.replaceAll(/Deno\.env\.get\('([A-Z_]+)'\)/g,(_,key)=>`env.${key}`);
  const dbStart=code.indexOf('async function db('),dbEnd=code.indexOf('async function all(',dbStart);
  if(dbStart<0||dbEnd<0)throw Error('Cannot locate db wrapper');
  code=code.slice(0,dbStart)+`const db=createDb(env.DB,{rpc:createOperationRpc(env.DB)});\n`+code.slice(dbEnd);
  code=code.replace('createOperationStorage({url:SUPABASE_URL,key:SERVICE_KEY})',"createMediaStorage(env,'')");
  code=code.replaceAll('ALLOWED_ORIGINS.includes(origin)', '(origin === new URL(request.url).origin)');
  code=code.replaceAll('ALLOWED.includes(origin)', '(origin === new URL(request.url).origin)');
  if(name==='legacy'){
    const start=code.indexOf('async function billDisplayUrls('),end=code.indexOf('async function visibleOrder(',start);
    if(start<0||end<0)throw Error('Cannot locate legacy image display');
    code=code.slice(0,start)+"async function billDisplayUrls(urls){return operationStorage.displayUrls(urls)}\n"+code.slice(end);
    code=code.replace('if (!SUPABASE_URL || !SERVICE_KEY)', 'if (!env.DB || !env.MEDIA || !env.MEDIA_SIGNING_KEY)');
  }else{
    const eager="const decorated=await Promise.all(rows.map(async r=>decorate({...r,image_urls:await displayUrls(r.image_urls||[])},user,sm[r.id],dir)));const filtered=q?decorated.filter(o=>norm([o.customer,o.phone,o.id,o.flower,o.sale,o.saleUsername].join(' ')).includes(q)):decorated;const items=filtered.slice((page-1)*pageSize,page*pageSize);";
    const paged="const decorated=rows.map(r=>decorate(r,user,sm[r.id],dir));const filtered=q?decorated.filter(o=>norm([o.customer,o.phone,o.id,o.flower,o.sale,o.saleUsername].join(' ')).includes(q)):decorated;const selected=filtered.slice((page-1)*pageSize,page*pageSize);const items=await Promise.all(selected.map(async o=>{const imageUrls=await displayUrls(o.imageUrls||[]);return {...o,imageUrls,driveUrls:imageUrls}}));";
    if(!code.includes(eager))throw Error('Cannot locate order pagination transform');
    code=code.replace(eager,paged);
    const start=code.indexOf('async function displayUrls('),end=code.indexOf('const operationStorage=',start);
    if(start<0||end<0)throw Error('Cannot locate core image display');
    code=code.slice(0,start)+"async function displayUrls(urls){return operationStorage.displayUrls(urls)}\n"+code.slice(end);
    code=code.replace("const LEGACY_API=`${SUPABASE_URL}/functions/v1/meehoasg-api`;", "const LEGACY_API='/api';");
    code=code.replace('fetch(LEGACY_API,{method:',"createLegacy(env)(new Request(new URL(LEGACY_API,request.url),{method:");
    code=code.replace('body:JSON.stringify(input)});const t=await r.text();','body:JSON.stringify(input)}));const t=await r.text();');
  }
  const serve=code.lastIndexOf('Deno.serve(async request');
  if(serve<0)throw Error('Cannot locate server');
  code=code.slice(0,serve)+code.slice(serve).replace('Deno.serve(async request', 'return async request');
  const end=code.lastIndexOf('});');
  if(end<0)throw Error('Cannot locate server close');
  code=code.slice(0,end)+'};\n}\n'+code.slice(end+3);
  await writeFile(resolve(root,`runtime/${name}.js`),code);
  console.log(name,code.length);
}
