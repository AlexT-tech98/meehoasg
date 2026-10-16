const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/staging');fs.mkdirSync(out,{recursive:true});
const file=path.join(out,'supabase.local.json');
if(fs.existsSync(file))throw Error('Local QA config exists; refusing to rotate keys over persisted database');
const secret=crypto.randomBytes(48).toString('hex'),password=crypto.randomBytes(24).toString('hex');
function token(role){const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const p=Buffer.from(JSON.stringify({iss:'meehoa-local-qa',ref:'meehoa-local-qa',role,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+30*86400})).toString('base64url');return h+'.'+p+'.'+crypto.createHmac('sha256',secret).update(h+'.'+p).digest('base64url');}
const anon=token('anon'),service=token('service_role');
fs.writeFileSync(file,JSON.stringify({API_URL:'http://127.0.0.1:54321',ANON_KEY:anon,SERVICE_ROLE_KEY:service,DB_PASSWORD:password},null,2)+'\n',{mode:0o600,flag:'wx'});
fs.writeFileSync(path.join(out,'docker.local.env'),[`QA_DB_PASSWORD=${password}`,`QA_JWT_SECRET=${secret}`,`QA_ANON_KEY=${anon}`,`QA_SERVICE_KEY=${service}`].join('\n')+'\n',{mode:0o600,flag:'wx'});
console.log('Created local-only QA keys; saved privately under artifacts/staging (gitignored).');
