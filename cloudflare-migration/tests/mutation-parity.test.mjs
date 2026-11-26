import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const worker=readFileSync(new URL('../runtime/operations.js',import.meta.url),'utf8');
const production=readFileSync(new URL('../../supabase/migrations/20261008150000_atomic_operations.sql',import.meta.url),'utf8');
test('sale identity selects username match before duplicate display name, matching SQL',()=>{
  assert.match(production,/order by \(lower\(trim\(username\)\)=lower\(trim\(v_sale\)\)\) desc limit 1/i);
  assert.match(worker,/ORDER BY \(lower\(trim\(json_extract\(data,'\$\.username'\)\)\)=lower\(trim\(\?\)\)\) DESC LIMIT 1/);
  assert.match(worker,/bind\(saleName,saleName,saleName\)/);
});
test('review settlement cannot overwrite a concurrently changed order',()=>{
  assert.match(production,/select \* into o from public\.orders where id=v_id for update/i);
  assert.match(worker,/\(versioned\|\|action==='reviewSettlement'\)\?before\?\.updated_at/);
  assert.match(worker,/ELSE json\('MEEHOA_STALE_VERSION'\)/);
});
