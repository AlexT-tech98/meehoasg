// Run only after a clean, reproducible build. CI uploads this next to test evidence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const git=(...args)=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const commit=git('rev-parse','HEAD');
if(git('status','--porcelain','--untracked-files=no'))throw Error('Tracked working tree is dirty; release manifest refused');
const files=git('ls-files','-z').split('\0').filter(Boolean).sort().map(file=>{
 const bytes=fs.readFileSync(path.join(root,file));return {path:file,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
});
const out=path.join(root,'artifacts/release');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({schemaVersion:1,commit,files},null,2)+'\n');
fs.writeFileSync(path.join(out,'SHA256SUMS'),files.map(f=>f.sha256+'  '+f.path).join('\n')+'\n');
console.log(`Release manifest: ${commit}, ${files.length} tracked files`);
