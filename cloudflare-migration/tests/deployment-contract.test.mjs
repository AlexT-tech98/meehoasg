import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const entry=await readFile(new URL('../runtime/entry.js',import.meta.url),'utf8');
const frontend=await readFile(new URL('../dist/assets/meehoa-core.js',import.meta.url),'utf8');
const endpoints=[...frontend.matchAll(/(?:DELETE_URL|ENDPOINT)\s*=\s*['"](\/[^'"]+)['"]/g)].map(m=>m[1]);
for(const endpoint of endpoints){
  test(`frontend route ${endpoint} must be handled by Cloudflare entry`,()=>{
    assert.ok(entry.includes(`path==='${endpoint}'`)||entry.includes(`path.startsWith('${endpoint}')`),`Missing Worker handler for ${endpoint}`);
  });
}

test('default build script only builds frontend and never overwrites runtime/',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.scripts.build,'node build-frontend.mjs');
  assert.ok(!pkg.scripts.build.includes('build-backend.mjs'),'build must never invoke build-backend.mjs');
  const backendBuilder=await readFile(new URL('../build-backend.mjs',import.meta.url),'utf8');
  assert.ok(backendBuilder.includes('ALLOW_OVERWRITE_RUNTIME'),'build-backend.mjs must require explicit opt-in guard');
});
