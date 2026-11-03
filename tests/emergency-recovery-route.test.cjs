const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const core = fs.readFileSync(path.join(root, 'supabase/functions/meehoasg-api-core/index.js'), 'utf8');

test('all shell API calls go directly to the existing Supabase Core', () => {
  assert.match(shell, /var API_CORE='https:\/\/zxnfhshnavbmvdthrmrd\.supabase\.co\/functions\/v1\/meehoasg-api-core'/);
  assert.doesNotMatch(shell, /meehoasg-api-gateway/);
  assert.equal(fs.existsSync(path.join(root, 'infra/cloudflare-worker/index.js')), false);
});

test('Core owns KPI authorization and delegates other existing actions', () => {
  assert.match(core, /name==='getKpi'\)result=await fastKpi\(payload\)/);
  assert.match(core, /const user=await requireUser\(payload\),month=/);
  assert.match(core, /if\(isCmui&&user\.role!=='ADMIN'&&saleKey\(user\.username\)!=='cmui'\)continue/);
  assert.match(core, /async function delegate\(request,input\)/);
});
