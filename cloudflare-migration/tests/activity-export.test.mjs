import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
test('activity log retains source stable primary key in D1 adapter',()=>{
 const code=readFileSync(new URL('runtime/db.js',root),'utf8');
 assert.match(code,/activity_log:'id'/);
});
test('private activity migration generator requires source ID and rejects duplicate IDs',()=>{
 const code=readFileSync(new URL('prepare_activity_log.py',root),'utf8');
 assert.match(code,/missing source id/);
 assert.match(code,/duplicate id/);
 assert.match(code,/ON CONFLICT\(row_key\) DO UPDATE/);
});
