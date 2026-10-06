const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const entry=fs.readFileSync('index.html','utf8');

test('shell cache is release-bound and browser HTTP cache cannot resurrect an old form',()=>{
  assert.match(entry,/var RELEASE='20261006-ops7'/);
  assert.match(entry,/var SHELL_KEY='meehoa-shell-core-'\+RELEASE/);
  assert.match(entry,/var SHELL_URL='\/html\?prod-base='\+RELEASE/);
  assert.match(entry,/fetch\(SHELL_URL,\{cache:'no-store'\}\)/);
  assert.doesNotMatch(entry,/fetch\(SHELL_URL,\{cache:'force-cache'\}\)/);
});

test('preloaded shell and consolidated assets use the same release token',()=>{
  assert.match(entry,/\/html\?prod-base=20261006-ops7/);
  assert.match(entry,/meehoa-core\.css\?v=20261006-ops7/);
  assert.match(entry,/meehoa-core\.js\?v=20261006-ops7/);
});
