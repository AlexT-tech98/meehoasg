const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const migration=fs.readFileSync('supabase/migrations/20261009064825_protect_operational_archives.sql','utf8');
test('private archives deny browser roles, preserve service reads and all data',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create table deleted_orders(id text);insert into deleted_orders values ('private');
   create table orders_dup_artifact_backup_20261001(id text);insert into orders_dup_artifact_backup_20261001 values ('backup');
   create view order_card_quantity_audit as select * from deleted_orders;
   grant usage on schema public to anon,authenticated,service_role;
   grant select on all tables in schema public to anon,authenticated,service_role;
   create function normalize_order_card_qty() returns trigger language plpgsql as $$begin return new;end$$;`);
  await db.exec(migration);
  for(const role of ['anon','authenticated'])for(const name of ['deleted_orders','orders_dup_artifact_backup_20261001','order_card_quantity_audit']){
   await db.exec('set role '+role);
   await assert.rejects(()=>db.query('select * from '+name),/permission denied/);
   await db.exec('reset role');
  }
  await db.exec('set role service_role');
  for(const name of ['deleted_orders','orders_dup_artifact_backup_20261001','order_card_quantity_audit'])assert.equal((await db.query('select * from '+name)).rows.length,1);
  await db.exec('reset role');
  const flags=(await db.query("select relrowsecurity from pg_class where relname in ('deleted_orders','orders_dup_artifact_backup_20261001')")).rows;
  assert.equal(flags.length,2);assert.ok(flags.every(r=>r.relrowsecurity));
  assert.deepEqual((await db.query("select proconfig from pg_proc where proname='normalize_order_card_qty'")).rows[0].proconfig,['search_path=public, pg_temp']);
 }finally{await db.close()}
});
test('archive hardening also works when deployment-only objects are absent',async()=>{const db=new PGlite();try{await db.exec('create role anon;create role authenticated;');await db.exec(migration);}finally{await db.close()}});
