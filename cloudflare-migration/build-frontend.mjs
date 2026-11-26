import {readFile,writeFile,mkdir,rm,cp} from 'node:fs/promises';
import {resolve} from 'node:path';

const source=resolve(import.meta.dirname,'public');
const target=resolve(import.meta.dirname,'dist');
await rm(target,{recursive:true,force:true});
await cp(source,target,{recursive:true});
const replacements={
  'meehoasg-api-core':'/api-core',
  'meehoasg-api':'/api',
  'meehoasg-delete-order':'/delete-order',
  'meehoasg-order-actions':'/order-actions'
};
for(const file of ['index.html','html','assets/meehoa-core.js']){
  const path=resolve(target,file);
  let content=await readFile(path,'utf8');
  for(const [slug,url] of Object.entries(replacements))
    content=content.replaceAll(`https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/${slug}`,url);
  content=content.replaceAll('<link rel="preconnect" href="https://zxnfhshnavbmvdthrmrd.supabase.co" crossorigin>','');
  content=content.replace(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'cloudflare-same-origin');
  if(content.includes('zxnfhshnavbmvdthrmrd.supabase.co'))throw Error(`Production URL remains in ${file}`);
  await writeFile(path,content);
}
await writeFile(resolve(target,'_headers'),'/html\n  Cache-Control: no-store\n/index.html\n  Cache-Control: no-store\n');
console.log('Current production frontend copied and API routes isolated in',target);
