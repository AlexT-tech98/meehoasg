const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/release'),dest=path.join(out,'package');
const git=(...a)=>cp.execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
if(git('status','--porcelain','--untracked-files=no'))throw Error('Refusing dirty tracked release');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),commit=git('rev-parse','HEAD');
fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(dest,{recursive:true});
const files=git('ls-files','-z').split('\0').filter(f=>f&&(['index.html','html','manifest.webmanifest','supabase/config.toml'].includes(f)||f.startsWith('assets/')||f.startsWith('supabase/functions/')||f.startsWith('docs/release-39')||f==='scripts/release-migrations.json'));
for(const name of require('./release-migrations.json'))files.push('supabase/migrations/'+name);
// UI V2 is a separate, production-pending migration; never replay already-applied PR39 deltas.
const uiV2Migration='supabase/migrations/20261018120000_ui_v2_fulfillment_states.sql';
files.push(uiV2Migration);
const manifest=[];for(const file of files){const bytes=fs.readFileSync(path.join(root,file)),target=path.join(dest,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);manifest.push({path:file,bytes:bytes.length,sha256:sha(bytes)});}
const delta=require('./release-migrations.json').map(f=>'-- '+f+'\n'+fs.readFileSync(path.join(root,'supabase/migrations',f),'utf8')).join('\n');fs.writeFileSync(path.join(dest,'reviewed-schema-delta.sql'),delta);
const uiV2Delta=fs.readFileSync(path.join(root,uiV2Migration),'utf8');
fs.writeFileSync(path.join(dest,'ui-v2-schema-delta.sql'),uiV2Delta);
const anchor='4bb73ffb594118e5b14463772d423ec5320973bc',rollback=['index.html','html','assets/meehoa-core.js','assets/meehoa-core.css','manifest.webmanifest'];
const compatible=[];for(const file of rollback){const bytes=cp.execFileSync('git',['show',anchor+':'+file],{cwd:root,maxBuffer:8*1024*1024}),target=path.join(dest,'compatible-fallback',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);compatible.push({path:file,sha256:sha(bytes)});}
fs.writeFileSync(path.join(dest,'package-manifest.json'),JSON.stringify({commit,files:manifest,schemaDeltaSha256:sha(delta),uiV2SchemaDelta:{path:'ui-v2-schema-delta.sql',source:uiV2Migration,sha256:sha(uiV2Delta),applyOnlyIfMissing:true,note:'REQUIRED for five-stage frontend/API; never apply PR39 schema delta again when migrations already exist'},compatibleFallback:{commit:anchor,files:compatible,note:'V2 FIVE-STATE FRONTEND ONLY, from prior exact-green SHA. Retain upgraded production SQL, core/legacy/order-actions/shared backend, ingest, feed and Storage. Restore index.html + html + bundled CSS/JS + manifest together. Never downgrade SQL to three statuses, overwrite customer writes, or deploy this fallback without verified served hashes and an authorized write freeze.'}},null,2)+'\n');
const tar=cp.execFileSync('tar',['--sort=name','--format=gnu','--mode=u=rwX,go=rX','--mtime=@'+git('show','-s','--format=%ct','HEAD'),'--owner=0','--group=0','--numeric-owner','-cf','-','-C',dest,'.'],{maxBuffer:32*1024*1024});
const archive=cp.execFileSync('gzip',['-n'],{input:tar,maxBuffer:32*1024*1024}),file='meehoa-'+commit.slice(0,12)+'.tar.gz';fs.writeFileSync(path.join(out,file),archive);fs.writeFileSync(path.join(out,file+'.sha256'),sha(archive)+'  '+file+'\n');console.log('Built '+file+' SHA256 '+sha(archive));
