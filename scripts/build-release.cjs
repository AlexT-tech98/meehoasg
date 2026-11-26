const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/release'),dest=path.join(out,'package');
const git=(...a)=>cp.execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
if(git('status','--porcelain','--untracked-files=no'))throw Error('Refusing dirty tracked release');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),commit=git('rev-parse','HEAD');
fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(dest,{recursive:true});
const files=git('ls-files','-z').split('\0').filter(f=>f&&(['index.html','html','manifest.webmanifest','supabase/config.toml','docs/UI_V3_GO_LIVE_RUNBOOK.md','scripts/legacy-deleted-orders-dry-run.sql','scripts/legacy-deleted-orders-backfill.sql','scripts/legacy-deleted-orders-rollback.sql','scripts/legacy-note-to-tag-note-free-dry-run.sql','scripts/legacy-note-to-tag-note-free-backfill.sql','scripts/legacy-note-to-tag-note-free-rollback.sql','scripts/legacy-settlement-bills-inventory.sql','scripts/legacy-settlement-bills-r2-switch.sql','scripts/legacy-settlement-bills-r2-rollback.sql','scripts/migrate-settlement-bills-to-r2.cjs','scripts/r2-cleanup-golive-test-objects.cjs'].includes(f)||f.startsWith('assets/')||f.startsWith('supabase/functions/')||f.startsWith('docs/release-39')||f==='scripts/release-migrations.json'));
for(const name of require('./release-migrations.json'))files.push('supabase/migrations/'+name);
// UI V2 is a separate, production-pending migration; never replay already-applied PR39 deltas.
const uiV2Migration='supabase/migrations/20261018120000_ui_v2_fulfillment_states.sql';
files.push(uiV2Migration);
const packedReadinessMigration='supabase/migrations/20261019061153_packed_action_routes_to_readiness.sql';
files.push(packedReadinessMigration);
const fourStateMigration='supabase/migrations/20261019064413_four_state_production_flow.sql';
files.push(fourStateMigration);
const uiV3Migrations=[
  'supabase/migrations/20261125010000_ui_v3_tag_note_soft_delete_server_filter.sql',
  'supabase/migrations/20261125020000_ui_v3_rc3_order_source_and_walkin.sql',
  'supabase/migrations/20261126010000_ui_v3_final_deletion_policy_override.sql',
  'supabase/migrations/20261126020000_ui_v3_guard_queued_order_trash_compat.sql',
  'supabase/migrations/20261126030000_ui_v3_1_username_uniqueness.sql'
];
for(const m of uiV3Migrations)files.push(m);
const manifest=[];for(const file of files){const bytes=fs.readFileSync(path.join(root,file)),target=path.join(dest,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);manifest.push({path:file,bytes:bytes.length,sha256:sha(bytes)});}
const delta=require('./release-migrations.json').map(f=>'-- '+f+'\n'+fs.readFileSync(path.join(root,'supabase/migrations',f),'utf8')).join('\n');fs.writeFileSync(path.join(dest,'reviewed-schema-delta.sql'),delta);
const uiV2Delta=fs.readFileSync(path.join(root,uiV2Migration),'utf8');
fs.writeFileSync(path.join(dest,'ui-v2-schema-delta.sql'),uiV2Delta);
const packedReadinessDelta=fs.readFileSync(path.join(root,packedReadinessMigration),'utf8');
fs.writeFileSync(path.join(dest,'packed-readiness-schema-delta.sql'),packedReadinessDelta);
const fourStateDelta=fs.readFileSync(path.join(root,fourStateMigration),'utf8');
fs.writeFileSync(path.join(dest,'four-state-schema-delta.sql'),fourStateDelta);
const uiV3Delta=uiV3Migrations.map(f=>'-- '+path.basename(f)+'\n'+fs.readFileSync(path.join(root,f),'utf8')).join('\n');
fs.writeFileSync(path.join(dest,'ui-v3-schema-delta.sql'),uiV3Delta);
const uiV3MigrationMeta=uiV3Migrations.map(source=>{const b=fs.readFileSync(path.join(root,source));return {source,sha256:sha(b),bytes:b.length};});
const anchor='6d41af509775d33350a2c29e15bd0cbec84cee29',rollback=['index.html','html','assets/meehoa-core.js','assets/meehoa-core.css','manifest.webmanifest'];
const compatible=[];for(const file of rollback){const bytes=cp.execFileSync('git',['show',anchor+':'+file],{cwd:root,maxBuffer:8*1024*1024}),target=path.join(dest,'compatible-fallback',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);compatible.push({path:file,sha256:sha(bytes)});}
fs.writeFileSync(path.join(dest,'package-manifest.json'),JSON.stringify({commit,files:manifest,schemaDeltaSha256:sha(delta),uiV2SchemaDelta:{path:'ui-v2-schema-delta.sql',source:uiV2Migration,sha256:sha(uiV2Delta),applyOnlyIfMissing:true,note:'REQUIRED for five-stage frontend/API; never apply PR39 schema delta again when migrations already exist'},packedReadinessSchemaDelta:{path:'packed-readiness-schema-delta.sql',source:packedReadinessMigration,sha256:sha(packedReadinessDelta),applyOnlyIfMissing:true,note:'Forward RPC correction after UI V2; apply only this delta when UI V2 already exists'},fourStateSchemaDelta:{path:'four-state-schema-delta.sql',source:fourStateMigration,sha256:sha(fourStateDelta),applyOnlyIfMissing:true,note:'Current four-state workflow; preserve historical rows and financial locks'},uiV3SchemaDelta:{path:'ui-v3-schema-delta.sql',migrations:uiV3MigrationMeta,sha256:sha(uiV3Delta),applyOnlyIfMissing:true,backfillScript:'scripts/legacy-deleted-orders-backfill.sql',rollbackScript:'scripts/legacy-deleted-orders-rollback.sql',note:'REQUIRED for UI V3 + Permanent R2 + Final Order Deletion Policy Override. Apply the 3 UI V3 migrations in order; never replay reviewed-schema-delta.sql.'},permanentR2:{enabled:true,trialBackupEnabled:false,reconciledFromProduction:'2026-11-26-v3.1',sharedReader:'supabase/functions/_shared/r2-image-reader.js',functions:['meehoasg-api-core','meehoasg-api','meehoasg-order-actions','meehoasg-r2-copy']},compatibleFallback:{commit:anchor,files:compatible,workflowCompatible:false,packedActionBulkCompatible:false,limitation:'Historical five-state frontend archive only. Incompatible with the current four-state workflow; do not deploy it as recovery.',note:'Historical reference only. Retain upgraded production SQL, core/legacy/order-actions/shared backend, ingest, feed and Storage. Recovery requires a frontend compatible with the current four-state workflow; this archive is not a deployable recovery target.'}},null,2)+'\n');
const tar=cp.execFileSync('tar',['--sort=name','--format=gnu','--mode=u=rwX,go=rX','--mtime=@'+git('show','-s','--format=%ct','HEAD'),'--owner=0','--group=0','--numeric-owner','-cf','-','-C',dest,'.'],{maxBuffer:32*1024*1024});
const archive=cp.execFileSync('gzip',['-n'],{input:tar,maxBuffer:32*1024*1024}),file='meehoa-'+commit.slice(0,12)+'.tar.gz';fs.writeFileSync(path.join(out,file),archive);fs.writeFileSync(path.join(out,file+'.sha256'),sha(archive)+'  '+file+'\n');console.log('Built '+file+' SHA256 '+sha(archive));
