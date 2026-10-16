const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/release'),dest=path.join(out,'package');
const git=(...a)=>cp.execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
if(git('status','--porcelain','--untracked-files=no'))throw Error('Refusing dirty tracked release');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),commit=git('rev-parse','HEAD');
fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(dest,{recursive:true});
const files=git('ls-files','-z').split('\0').filter(f=>f&&(['index.html','html','manifest.webmanifest','supabase/config.toml'].includes(f)||f.startsWith('assets/')||f.startsWith('supabase/functions/')||f.startsWith('docs/release-39')||f==='scripts/release-migrations.json'));
for(const name of require('./release-migrations.json'))files.push('supabase/migrations/'+name);
const manifest=[];for(const file of files){const bytes=fs.readFileSync(path.join(root,file)),target=path.join(dest,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);manifest.push({path:file,bytes:bytes.length,sha256:sha(bytes)});}
const delta=require('./release-migrations.json').map(f=>'-- '+f+'\n'+fs.readFileSync(path.join(root,'supabase/migrations',f),'utf8')).join('\n');fs.writeFileSync(path.join(dest,'reviewed-schema-delta.sql'),delta);
const anchor='52718b2cd9311891297e4666dfeba4a72629b463',rollback=['assets/meehoa-core.js','assets/meehoa-core.css'];
const compatible=[];for(const file of rollback){const bytes=cp.execFileSync('git',['show',anchor+':'+file],{cwd:root,maxBuffer:8*1024*1024}),target=path.join(dest,'compatible-fallback',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);compatible.push({path:file,sha256:sha(bytes)});}
fs.writeFileSync(path.join(dest,'package-manifest.json'),JSON.stringify({commit,files:manifest,schemaDeltaSha256:sha(delta),compatibleFallback:{commit:anchor,files:compatible,note:'ASSETS ONLY: retain current index.html/html debt membership logic, owner-scoped core/legacy/order-actions/shared code, database and feed/ingest. Never restore older HTML or debt readers. Older all-shop debt readers must never be restored. This is an incident fallback with known older search behavior, not permission to redeploy production baseline.'}},null,2)+'\n');
const tar=cp.execFileSync('tar',['--sort=name','--format=gnu','--mode=u=rwX,go=rX','--mtime=@'+git('show','-s','--format=%ct','HEAD'),'--owner=0','--group=0','--numeric-owner','-cf','-','-C',dest,'.'],{maxBuffer:32*1024*1024});
const archive=cp.execFileSync('gzip',['-n'],{input:tar,maxBuffer:32*1024*1024}),file='meehoa-'+commit.slice(0,12)+'.tar.gz';fs.writeFileSync(path.join(out,file),archive);fs.writeFileSync(path.join(out,file+'.sha256'),sha(archive)+'  '+file+'\n');console.log('Built '+file+' SHA256 '+sha(archive));
