const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'..','supabase','functions','meehoasg-api-core','index.js');
let s=fs.readFileSync(file,'utf8');
if(s.includes("const BUILD='2026.10.04-core2'")){
  console.log('Core bootstrap already flattened.');
  process.exit(0);
}

s=s.replace("const BUILD='2026.10.03-core1';","const BUILD='2026.10.04-core2';");
s=s.replace("const ENV_GEMINI_MODEL=Deno.env.get('GEMINI_MODEL')||'';","const ENV_GEMINI_MODEL=Deno.env.get('GEMINI_MODEL')||'';\nconst PASSWORD_SALT=Deno.env.get('LEGACY_PASSWORD_SALT')||'MEE-FLOWER-V4';\nconst SESSION_MS=30*24*60*60*1000;");
s=s.replace("async function sha256(text){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('')}","async function sha256(text){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('')}\nfunction same(a,b){a=String(a);b=String(b);if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0}\nfunction sessionToken(){return [...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('')}\nfunction usernameNorm(v){return norm(v).replace(/\\s+/g,'')}\nfunction publicUser(user){return {username:user.username,name:user.display_name,role:user.role,active:user.active}}");

const authAnchor="async function requireUser(payload,roles){const raw=clean(payload?.token);if(!raw||!/^[0-9a-f]{64}$/i.test(raw))throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');const session=await one('app_sessions',{token_hash:`eq.${await sha256(raw)}`,select:'username,expires_at'});if(!session||Date.parse(session.expires_at)<=Date.now())throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');const user=await one('app_users',{username:`eq.${session.username}`,select:'username,display_name,role,active'});if(!user||!user.active)throw new Error('Tài khoản đã bị khóa.');if(roles&&!roles.includes(user.role))throw new Error('Không có quyền thực hiện.');return user}";
if(!s.includes(authAnchor))throw new Error('requireUser anchor not found');
const directAuth=`${authAnchor}\nasync function loginCore(payload){const username=usernameNorm(payload?.username),password=String(payload?.password||'');if(!username||!password)return fail('Sai tài khoản hoặc mật khẩu.');const attempt=await one('login_attempts',{username:\`eq.\${username}\`});if(attempt?.blocked_until&&Date.parse(attempt.blocked_until)>Date.now())return fail('Đăng nhập quá nhiều lần. Vui lòng thử lại sau.');const user=await one('app_users',{username:\`eq.\${username}\`,select:'username,display_name,role,active,password_hash'});const expected=await sha256(PASSWORD_SALT+'|'+password),valid=user&&user.active&&same(user.password_hash,expected);if(!valid){const count=(attempt?.attempts||0)+1;await db('login_attempts',{on_conflict:'username'},'POST',{username,attempts:count,blocked_until:count>=5?new Date(Date.now()+15*60*1000).toISOString():null,updated_at:new Date().toISOString()});return fail('Sai tài khoản hoặc mật khẩu.')}if(attempt)await db('login_attempts',{username:\`eq.\${username}\`},'DELETE');const raw=sessionToken();await db('app_sessions',{},'POST',{token_hash:await sha256(raw),username,expires_at:new Date(Date.now()+SESSION_MS).toISOString()});return {ok:true,token:raw,user:publicUser(user)}}`;
s=s.replace(authAnchor,directAuth);

const fastOrdersAnchor="async function fastOrders(payload){";
const idx=s.indexOf(fastOrdersAnchor);
if(idx<0)throw new Error('fastOrders anchor not found');
const prodFn="async function fastProduction(payload){const user=await requireUser(payload),dir=await saleDirectory(),date=clean(payload.date)||dateToday(),rows=await all('orders',{and:`(order_date.gte.${date},order_date.lte.${date})`,order:'order_time.asc'}),sm=await settlementMap(rows.map(r=>r.id));const orders=await Promise.all(rows.map(async r=>decorate({...r,image_urls:await displayUrls(r.image_urls||[])},user,sm[r.id],dir)));return {ok:true,date,orders,visibilityRule:'SALE_READ_ALL_EDIT_OWN'}}\n\n";
s=s.slice(0,idx)+prodFn+s.slice(idx);

const bootstrapAnchor="async function bootstrapPatch(name,payload,result){";
const bidx=s.indexOf(bootstrapAnchor);
if(bidx<0)throw new Error('bootstrapPatch anchor not found');
const directBoot="async function initialCore(user,token){const day=dateToday();if(user.role==='ADMIN')return {page:'dashboard',data:await fastDashboard({token,start:day,end:day}),at:Date.now()};if(user.role==='THO_OPS')return {page:'production',data:await fastProduction({token,date:day}),at:Date.now()};return {page:'orders',data:await fastOrders({token,start:day,end:day,page:1,pageSize:80}),at:Date.now()}}\nasync function loginAndBootstrapCore(payload){const result=await loginCore(payload);if(!result.ok)return result;return {...result,options:{shipping:['Shop book ship','Khách tự book','Ghé lấy'],statuses:['Chờ bó','Đã bó','Đã giao']},initial:await initialCore(result.user,result.token)}}\nasync function currentBootstrapCore(payload){const user=await requireUser(payload);return {ok:true,user:publicUser(user),initial:await initialCore(user,payload.token)}}\n\n";
s=s.slice(0,bidx)+directBoot+s.slice(bidx);

const dispatchOld="if(name==='getOrders')result=await fastOrders(payload);else if(name==='getDashboardSummary')result=await fastDashboard(payload);else if(name==='getKpi')result=await fastKpi(payload);else if(name==='getFlowerInventory')result=await flowerInventory(payload);else if(name==='updateOrder')";
const dispatchNew="if(name==='loginAndBootstrap')result=await loginAndBootstrapCore(payload);else if(name==='getCurrentUserAndBootstrap')result=await currentBootstrapCore(payload);else if(name==='getProductionOrders')result=await fastProduction(payload);else if(name==='getOrders')result=await fastOrders(payload);else if(name==='getDashboardSummary')result=await fastDashboard(payload);else if(name==='getKpi')result=await fastKpi(payload);else if(name==='getFlowerInventory')result=await flowerInventory(payload);else if(name==='updateOrder')";
if(!s.includes(dispatchOld))throw new Error('dispatch anchor not found');
s=s.replace(dispatchOld,dispatchNew);
s=s.replace("legacyFallback:!['getOrders','getDashboardSummary','getKpi','getFlowerInventory'].includes(name)","legacyFallback:!['loginAndBootstrap','getCurrentUserAndBootstrap','getProductionOrders','getOrders','getDashboardSummary','getKpi','getFlowerInventory'].includes(name)");

fs.writeFileSync(file,s);
console.log('Flattened login/session bootstrap + production into API core2.');
