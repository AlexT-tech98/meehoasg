const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const core=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');
const operations=fs.readFileSync('supabase/functions/_shared/operations.js','utf8');
const ui=fs.readFileSync('html','utf8');
const r2=fs.readFileSync('supabase/functions/_shared/r2-media.js','utf8');

test('R2 reads and writes have independent OFF-by-default configuration',()=>{
  assert.match(core,/const R2_READS_ENABLED=Deno\.env\.get\('R2_READS_ENABLED'\)==='true'/);
  assert.match(core,/const R2_UPLOADS_ENABLED=Deno\.env\.get\('R2_UPLOADS_ENABLED'\)==='true'/);
});

test('old private Supabase references retain original signed-read fallback',()=>{
  assert.match(core,/if\(m&&R2_READS_ENABLED&&r2Media\)/);
  assert.match(core,/if\(await r2Media\.exists\(objectKey\)\)/);
  assert.match(core,/\/storage\/v1\/object\/sign\/\$\{m\[1\]\}\/\$\{m\[2\]\}/);
});

test('upload uses R2 only when writes flag is on, otherwise Supabase tickets',()=>{
  assert.match(core,/if\(R2_UPLOADS_ENABLED\)/);
  assert.match(core,/storage:'r2'/);
  assert.match(core,/storage\/v1\/object\/upload\/sign\/\$\{bucket\}\/\$\{path\}/);
  assert.match(core,/evidenceSignature\(user\.username,requestId,bucket,path,r2ExpiresAt,'r2'\)/);
});

test('sample and bill claims pass storage destination through the browser',()=>{
  assert.match(ui,/storage:t\.storage\|\|'supabase'/);
  assert.match(ui,/storage:t\.preview\.storage\|\|t\.storage\|\|'supabase'/);
  assert.match(ui,/ticket\.storage==='r2'\?\{'Content-Type':'image\/jpeg'\}/);
  assert.match(core,/if\(storage==='r2'\)\{await r2Media\.verifyUpload\(objectKey\);return ref;\}/);
});

test('R2 private media uses expiring signed URLs and rejects invalid paths',()=>{
  assert.match(r2,/const PATH = \/\^\(order-images\|settlement-bills\)/);
  assert.match(r2,/signQuery:true/);
  assert.match(r2,/expiresSeconds<1 \|\| expiresSeconds>3600/);
  assert.match(r2,/verifyUpload\(objectKey\)/);
});

test('existing order service is unchanged aside from supporting R2 preview retention',()=>{
  assert.match(operations,/createOperationService/);
  assert.match(operations,/supabase:\\\/\\\/order-images\|r2:\\\/\\\/\[a-z0-9-\]\+\\\/order-images/);
});

test('unauthorized mirrored Supabase/R2 dual-write helper is absent',()=>{
  assert.equal(fs.existsSync('supabase/functions/_shared/r2-bridge.js'),false);
});
