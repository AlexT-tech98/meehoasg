import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../runtime/operations.js',import.meta.url),'utf8');
test('stale D1 order writes abort atomic batch rather than saving invalid JSON',()=>{
  assert.match(source,/SET data=CASE WHEN json_extract\(data,'\$\.updated_at'\)=\? THEN \? ELSE json\('MEEHOA_STALE_VERSION'\) END WHERE row_key=\?/);
  assert.doesNotMatch(source,/ELSE 'invalid' END WHERE row_key/);
});
test('all business order mutations record receipt and audit in same batch',()=>{
  assert.match(source,/statements\.push\(put\(db,'orders'/);
  assert.match(source,/statements\.push\(audit\(/);
  assert.match(source,/statements\.push\(receipt\(/);
  assert.match(source,/await db\.batch\(statements\)/);
});
