import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDb} from '../runtime/db.js';

function binding(){
 const rows=new Map();
 return {rows,prepare(sql){return {bind(...args){return {async run(){
   if(sql.startsWith('INSERT INTO')){
     const table=sql.match(/^INSERT INTO (\w+)/)[1], [key,serialized]=args;
     const k=`${table}:${key}`;
     if(rows.has(k) && !sql.includes('ON CONFLICT'))throw Error('UNIQUE constraint failed');
     const incoming=JSON.parse(serialized);
     const old=rows.get(k);
     rows.set(k,sql.includes('json_patch')?{...old,...incoming}:incoming);
     return {success:true};
   }
   throw Error('Unsupported mock SQL: '+sql);
 },async all(){
   const table=sql.match(/^SELECT row_key,data FROM (\w+)/)[1];
   const list=[...rows].filter(([key])=>key.startsWith(table+':')).map(([key,row])=>({row_key:key.slice(table.length+1),data:JSON.stringify(row)}));
   return {results:list};
 }};}}}};
}

test('upsert maintains fields not included in partial login-attempt update',async()=>{
 const fake=binding(),db=createDb(fake);
 await db('login_attempts',{},'POST',{username:'sale',attempts:1,created_at:'original',active:true});
 await db('login_attempts',{on_conflict:'username'},'POST',{username:'sale',attempts:2});
 assert.deepEqual(fake.rows.get('login_attempts:sale'),{username:'sale',attempts:2,created_at:'original',active:true});
});
test('upsert is idempotent by primary key',async()=>{
 const fake=binding(),db=createDb(fake);
 await db('flower_cache',{on_conflict:'fingerprint'},'POST',{fingerprint:'abc',flowers:['Hồng']});
 await db('flower_cache',{on_conflict:'fingerprint'},'POST',{fingerprint:'abc',flowers:['Ly']});
 assert.equal(fake.rows.size,1);
 assert.deepEqual(fake.rows.get('flower_cache:abc').flowers,['Ly']);
});
test('insert without conflict option refuses replacement',async()=>{
 const db=createDb(binding());
 await db('app_users',{},'POST',{username:'admin'});
 await assert.rejects(()=>db('app_users',{},'POST',{username:'admin'}),/UNIQUE/);
});
