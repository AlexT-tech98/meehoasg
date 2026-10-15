// Destructive operations are confined to fresh in-memory PostgreSQL fixtures.
// This verifies a backup round trip, not a production PITR or Supabase Storage restore.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
async function main(){
 const started=Date.now(),db=new PGlite(),restored=[];
 try{
  await db.exec('create role anon;create role authenticated;create role service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);');
  await db.exec(fs.readFileSync('supabase/schema.sql','utf8'));
  const migrations=fs.readdirSync('supabase/migrations').sort();
  for(const f of migrations.filter(f=>!f.startsWith('20261015')))await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'));
  await db.exec("insert into orders(id,customer,order_date,flower_total,banner,banner_text) values ('ROLLBACK-FIXTURE','Khách giả','2026-10-15',500000,true,'Fixture');");
  const rows=async d=>(await d.query('select to_jsonb(o) as row,public.mee_ops_total(o)::text as total from orders o order by id')).rows;
  const before=await rows(db),backup=await db.dumpDataDir();
  for(const f of migrations.filter(f=>f.startsWith('20261015')))await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'));
  assert.equal((await rows(db))[0].row.banner_qty,1);
  assert.equal((await rows(db))[0].total,before[0].total,'legacy banner financial total unchanged');
  await db.exec("update orders set banner_qty=3 where id='ROLLBACK-FIXTURE'");
  const upgraded=await rows(db);assert.equal(Number(upgraded[0].total),605000);
  const postBackup=await db.dumpDataDir();
  for(const [snapshot,expected,label] of [[backup,before,'pre-release'],[postBackup,upgraded,'post-release']]){
   const copy=new PGlite({loadDataDir:snapshot});restored.push(copy);
   assert.deepEqual(await rows(copy),expected,label+' snapshot restores exact row and total');
  }
  const output={scope:'isolated PGlite fixture backup/restore; NOT production PITR rehearsal',checks:['legacy-banner-total-preserved','quantity-three-total-605000','pre-release-backup-restored','post-release-backup-restored'],durationMs:Date.now()-started,backupSha256:crypto.createHash('sha256').update(Buffer.from(await backup.arrayBuffer())).digest('hex')};
  const out=path.resolve('artifacts/rollback');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
 }finally{for(const d of restored)await d.close();await db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
