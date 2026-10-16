// Official publishers only. Both registries resolve to the same tested amd64 config.
const cp=require('node:child_process'),assert=require('node:assert/strict');
assert.equal(process.arch,'x64','Pinned QA image identities are amd64');
const env={...process.env};for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[k];
const docker=(args,quiet=false)=>cp.execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8',stdio:quiet?['ignore','pipe','pipe']:'inherit',timeout:180000});
for(const [primary,mirror,id]of [
 ['public.ecr.aws/supabase/storage-api:v1.35.3','supabase/storage-api@sha256:ea052de7dbf086583918172f8909648e3e493ff54ba9c0c2a3e9ba19016bc9a0','sha256:d2308c7679ad90ca9445ef52612d7dfaca908776294943db175d8ead0205f3e0'],
 ['public.ecr.aws/supabase/postgrest:v14.3','postgrest/postgrest@sha256:7924f769d8b3b173b93711c90d2fc4164667cffc563551d6a13bc5c93aca2487','sha256:8fef2fc016f1e9d785424f0d1362a7dc6b53c3519e89cb965d81419137f3fb41']
]){
 let cached=false;try{cached=docker(['image','inspect',primary,'--format','{{.Id}}'],true).trim()===id;}catch{}
 if(!cached){try{docker(['pull',primary]);}catch{console.log('Primary registry unavailable; trying content-pinned official publisher mirror.');docker(['pull',mirror]);assert.equal(docker(['image','inspect',mirror,'--format','{{.Id}}'],true).trim(),id,'mirror identity');docker(['tag',mirror,primary]);}}
 assert.equal(docker(['image','inspect',primary,'--format','{{.Id}}'],true).trim(),id,'tested QA image identity');console.log('Verified '+primary+' '+id);
}
