const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const entry=fs.readFileSync('index.html','utf8');
const releaseMatch=entry.match(/var RELEASE='([^']+)'/);
const release=releaseMatch&&releaseMatch[1];

test('shell cache is release-bound and browser HTTP cache cannot resurrect an old form',()=>{
  assert.ok(release);
  assert.match(release,/^\d{8}[-\w]*$/);
  assert.match(entry,/var SHELL_KEY='meehoa-shell-core-'\+RELEASE/);
  assert.match(entry,/var SHELL_URL='\/html\?prod-base='\+RELEASE/);
  assert.match(entry,/fetch\(SHELL_URL,\{cache:'no-store'\}\)/);
  assert.doesNotMatch(entry,/fetch\(SHELL_URL,\{cache:'force-cache'\}\)/);
});

test('preloaded shell and consolidated assets use the same release token',()=>{
  assert.ok(entry.includes('/html?prod-base='+release));
  assert.ok(entry.includes('meehoa-core.css?v='+release));
  assert.ok(entry.includes('meehoa-core.js?v='+release));
});
