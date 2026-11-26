const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const core=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');
const legacyApi=fs.readFileSync('supabase/functions/meehoasg-api/index.js','utf8');
const reader=fs.readFileSync('supabase/functions/_shared/r2-image-reader.js','utf8');
const operations=fs.readFileSync('supabase/functions/_shared/operations.js','utf8');
const ui=fs.readFileSync('html','utf8');
const r2=fs.readFileSync('supabase/functions/_shared/r2-media.js','utf8');
const configToml=fs.readFileSync('supabase/config.toml','utf8');

test('Permanent R2 reads and writes are enabled by default and never depend on 72h trial',()=>{
  assert.match(core,/const R2_READS_ENABLED=true;/);
  assert.match(core,/const R2_UPLOADS_ENABLED=true;/);
  assert.match(core,/function r2BackupEnabled\(\)\{return false\}/);
  assert.doesNotMatch(core,/R2_TRIAL_END_MS/);
  assert.doesNotMatch(core,/function r2TrialActive/);
  assert.match(legacyApi,/function r2BackupEnabled\(\)\{return false\}/);
});

test('shared R2 image reader resolves both R2 and legacy private Supabase references',()=>{
  assert.match(core,/import \{createR2ImageReader\} from '\.\.\/_shared\/r2-image-reader\.js';/);
  assert.match(legacyApi,/import \{createR2ImageReader\} from '\.\.\/_shared\/r2-image-reader\.js';/);
  assert.match(legacyApi,/import \{createR2Media\} from '\.\.\/_shared\/r2-media\.js';/);
  assert.match(reader,/media\.signedUrl\('GET',r2Key,\{expiresSeconds:3600\}\)/);
  assert.match(reader,/\/storage\/v1\/object\/sign\//);
  assert.match(reader,/resolve\.invalidate=/);
});

test('upload uses Permanent R2 on Production and fails closed if R2 credentials are absent',()=>{
  assert.match(core,/if\(r2WriteEnabled\(\)\)/);
  assert.match(core,/if\(!r2Media\)throw Error\('R2_NOT_CONFIGURED'\)/);
  assert.match(core,/storage:'r2'/);
  assert.match(core,/evidenceSignature\(user\.username,requestId,bucket,path,r2ExpiresAt,backup\?'r2-backup':'r2'\)/);
  assert.match(legacyApi,/if\(!r2Media\)throw Error\('R2_NOT_CONFIGURED'\)/);
});

test('sample and bill claims pass storage destination through the browser',()=>{
  assert.match(ui,/storage:t\.storage\|\|'supabase'/);
  assert.match(ui,/preview:t\.preview\?claim\(t\.preview\)/);
  assert.match(ui,/storage==='r2'\?\{'Content-Type':'image\/jpeg'\}/);
  assert.match(core,/const r2Length=await r2Media\.verifyUpload\(objectKey\)/);
});

test('R2 private media uses expiring signed URLs and rejects invalid paths',()=>{
  assert.match(r2,/const PATH = \/\^\(order-images\|settlement-bills\)/);
  assert.match(r2,/signQuery:true/);
  assert.match(r2,/expiresSeconds<1 \|\| expiresSeconds>3600/);
  assert.match(r2,/verifyUpload\(objectKey\)/);
});

test('existing order service preserves R2 preview retention and ownership check',()=>{
  assert.match(operations,/createOperationService/);
  assert.match(operations,/supabase:\\\/\\\/order-images\|r2:\\\/\\\/\[a-z0-9-\]\+\\\/order-images/);
});

test('supabase/config.toml preserves live Production verify_jwt settings for all four functions',()=>{
  assert.match(configToml,/\[functions\.meehoasg-api-core\][\s\S]*?verify_jwt = true/);
  assert.match(configToml,/\[functions\.meehoasg-api\][\s\S]*?verify_jwt = true/);
  assert.match(configToml,/\[functions\.meehoasg-delete-order\][\s\S]*?verify_jwt = false/);
  assert.match(configToml,/\[functions\.meehoasg-order-actions\][\s\S]*?verify_jwt = false/);
});

test('unauthorized mirrored Supabase/R2 dual-write helper is absent',()=>{
  assert.equal(fs.existsSync('supabase/functions/_shared/r2-bridge.js'),false);
});
