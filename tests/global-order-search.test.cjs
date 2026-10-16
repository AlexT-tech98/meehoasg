const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {PGlite}=require('@electric-sql/pglite');
const sql=fs.readFileSync('supabase/migrations/20261016080719_global_paginated_order_search.sql','utf8');
test('global search ignores date, matches Vietnamese accents, and paginates without duplication',async()=>{const db=new PGlite();try{
await db.exec("create role anon; create role authenticated; create role service_role; create table public.orders(id text primary key,customer text,phone text,flower text,sale text,order_date date,order_time text);");
await db.exec(sql);
await db.exec("insert into public.orders values ('id1','Khách Tiên','0901','Hồng Ecuador','tien','2025-01-01','11:00'),('id2','Tiên','0902','Tulip','tien','2026-10-15','10:00'),('id3','Khách khác','0903','Cúc','ngoc','2026-10-15','12:00');");
const query=async(limit,offset)=>JSON.parse((await db.query('select public.mee_search_orders_global($1,$2,$3) as result',['tien',limit,offset])).rows[0].result instanceof Object?JSON.stringify((await db.query('select public.mee_search_orders_global($1,$2,$3) as result',['tien',limit,offset])).rows[0].result):(await db.query('select public.mee_search_orders_global($1,$2,$3) as result',['tien',limit,offset])).rows[0].result);
const one=await query(1,0),two=await query(1,1);assert.equal(one.total,2);assert.equal(two.total,2);assert.equal(one.rows.length,1);assert.equal(two.rows.length,1);assert.notEqual(one.rows[0].id,two.rows[0].id);
}finally{await db.close()}});
test('global search SQL denies public execution and bounds page inputs',()=>{assert.match(sql,/REVOKE ALL ON FUNCTION public.mee_search_orders_global/);assert.match(sql,/p_limit > 200/);assert.match(sql,/length\(v_query\) < 2/)});

test('bounded RPC combines literal keyword/date filters, stable pages and role denials',async()=>{const db=new PGlite();try{
await db.exec("create role anon;create role authenticated;create role service_role;create table public.orders(id text primary key,customer text,phone text,flower text,sale text,order_date date,order_time text);");await db.exec(sql);await db.exec(fs.readFileSync('supabase/migrations/20261016080722_bounded_order_pages.sql','utf8'));
await db.exec("insert into orders values ('a','Tiên 100%','0','Tulip','sale','2025-01-01','10:00'),('b','Tiên','0','Tulip','sale','2026-10-15','10:00'),('c','Tiên','0','Tulip','sale','2026-10-15','10:00');");
const query=async(q,start,end,offset=0)=>(await db.query('select mee_search_orders_page($1,$2,$3,1,$4) as r',[q,start,end,offset])).rows[0].r;
assert.equal((await query('tien',null,null)).total,3);const one=await query('tien','2026-10-15','2026-10-15'),two=await query('tien','2026-10-15','2026-10-15',1);assert.equal(one.total,2);assert.notEqual(one.rows[0].id,two.rows[0].id);assert.equal((await query('100%',null,null)).total,1);
await db.exec('set role anon');await assert.rejects(query('tien',null,null),/permission denied/);await db.exec('reset role');await assert.rejects(query('x',null,null),/SEARCH_QUERY_INVALID/);
}finally{await db.close()}});
