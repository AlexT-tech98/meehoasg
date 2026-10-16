// Only the dedicated loopback Supabase stack is accepted. Never accepts a remote DB URL.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/staging');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function main(){
 const config=JSON.parse(fs.readFileSync(path.join(out,'supabase.local.json'),'utf8'));
 if(config.API_URL!=='http://127.0.0.1:54321')throw Error('Wrong QA API boundary');
 const db=new Client({host:'127.0.0.1',port:54322,user:'postgres',password:config.DB_PASSWORD,database:'postgres'});await db.connect();
 try{
  const exists=(await db.query("select to_regclass('public.app_users') as users,to_regclass('meehoa_qa.environment') as marker")).rows[0];
  if(exists.users&&!exists.marker)throw Error('Refusing to modify an existing unmarked database');
  if(!exists.users){
   await db.query('begin');
   try{
    await db.query(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
    for(const f of fs.readdirSync(path.join(root,'supabase/migrations')).sort())await db.query(fs.readFileSync(path.join(root,'supabase/migrations',f),'utf8'));
    await db.query("create schema meehoa_qa;revoke all on schema meehoa_qa from public,anon,authenticated;create table meehoa_qa.environment(name text primary key);insert into meehoa_qa.environment values ('meehoa-pr39-local-synthetic');");
    await db.query("notify pgrst,'reload schema';commit;");
   }catch(e){await db.query('rollback');throw e;}
  }
  const marker=(await db.query('select name from meehoa_qa.environment')).rows;
  if(marker.length!==1||marker[0].name!=='meehoa-pr39-local-synthetic')throw Error('Wrong environment marker');
  await db.query('grant usage on schema storage to service_role;grant all on all tables in schema storage to service_role;grant all on all sequences in schema storage to service_role;');
  fs.mkdirSync(out,{recursive:true});
  const credentialsPath=path.join(out,'credentials.local.json');
  let accounts=fs.existsSync(credentialsPath)?JSON.parse(fs.readFileSync(credentialsPath)).accounts:null;
  if(!accounts){
   if(Number((await db.query('select count(*) from app_users')).rows[0].count))throw Error('Credentials file missing for populated staging; no automatic password reset');
   accounts=[['qa_admin','QA Admin','ADMIN',true],['qa_sale','QA Sale','SALE',true],['qa_tho','QA Tiên','THO_OPS',true],['qa_sale_other','QA Sale Khác','SALE',true],['qa_disabled','QA Disabled','SALE',false]].map(([username,name,role,active])=>({username,name,role,active,password:crypto.randomBytes(24).toString('base64url')}));
   fs.writeFileSync(credentialsPath,JSON.stringify({scope:'local synthetic QA only',accounts},null,2)+'\n',{mode:0o600,flag:'wx'});
  }
  await db.query('begin');
  try{
   for(const a of accounts)await db.query('insert into app_users(username,password_hash,display_name,role,active) values ($1,$2,$3,$4,$5) on conflict(username) do nothing',[a.username,hash('MEE-FLOWER-V4|'+a.password),a.name,a.role,a.active]);
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   for(let i=0;i<240;i++){
    const date=i<40?today:i<140?'2025-01-01':'2026-09-01',sale=i%3===0?'qa_tho':i%3===1?'qa_sale':'QA Tiên';
    await db.query("insert into orders(id,customer,phone,order_date,order_time,flower,note,shipping,flower_total,payment,sale,status,banner,banner_qty,banner_text,card,card_qty,card_text) values ($1,$2,'0000000000',$3,'10:00',$4,'DỮ LIỆU GIẢ QA — KHÔNG GIAO HÀNG','Ghé lấy',500000,$5,$6,$7,true,3,'QA banner',true,2,'QA card') on conflict(id) do nothing",['QA-SEED-'+String(i).padStart(3,'0'),'QA Khách Tiên '+i,date,i%2?'Tulip':'Ly hồng + Hồng Ecuador',i%4===0?'Đã thanh toán tiền hoa':'Chưa thanh toán',sale,i%5===0?'Đã giao':i%5===1?'Đã bó':'Chờ bó']);
   }
   // Controlled classifier cache avoids external AI calls and gives exact distinct-count expectations.
   for(const [content,flowers] of [['Tulip',['Tulip']],['Ly hồng + Hồng Ecuador',['Ly hồng','Hồng Ecuador','Ly hồng']]]){
    const key=content.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase().replace(/\s+/g,' ');
    await db.query('insert into flower_cache(fingerprint,content,flowers,needs_review,updated_at) values ($1,$2,$3,false,now()) on conflict(fingerprint) do nothing',[hash('core6|'+key),content,JSON.stringify(flowers)]);
   }
   await db.query('commit');
   const counts=(await db.query('select (select count(*)::int from orders) as orders,(select count(*)::int from app_users) as users')).rows[0];
   fs.writeFileSync(path.join(out,'environment.json'),JSON.stringify({scope:'local PostgreSQL17 + real PostgREST/Supabase Storage + candidate functions on Deno; synthetic data only; not managed cloud parity',api:'http://127.0.0.1:54321',web:'http://127.0.0.1:4173',today,...counts,accounts:accounts.map(({password,...a})=>a)},null,2)+'\n');
   console.log(JSON.stringify({environment:'meehoa-pr39-local-synthetic',...counts,credentialsFile:credentialsPath}));
  }catch(e){await db.query('rollback');throw e;}
 }finally{await db.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
