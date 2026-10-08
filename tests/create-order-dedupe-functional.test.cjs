const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('request-id receipts replace approximate customer/product deduplication',()=>{
 const core=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');
 const sql=fs.readFileSync('supabase/migrations/20261008150000_atomic_operations.sql','utf8');
 assert.doesNotMatch(core,/operationalDuplicateCandidate|forceDuplicate/);
 assert.match(sql,/primary key \(actor, request_id\)/);
 assert.match(sql,/r\.fingerprint<>p_fingerprint/);
 assert.match(sql,/pg_advisory_xact_lock/);
});
// Distinct bouquets, retries, actor ownership, changed payloads and concurrency
// versions are exercised against PostgreSQL in atomic-operations.test.cjs.
