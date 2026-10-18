const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('one owner per active runtime source', () => {
  const owners = JSON.parse(read('runtime-ownership.json'));
  const registered = new Map();
  for (const [feature, definition] of Object.entries(owners)) {
    for (const file of definition.files || []) {
      assert.ok(!registered.has(file), 'Duplicate owner: ' + file);
      registered.set(file, feature);
    }
  }
  const builder = read('scripts/build-runtime.cjs');
  for (const file of registered.keys()) {
    assert.ok(fs.existsSync(path.join(root, 'assets', file)), 'Missing source: ' + file);
    assert.ok(builder.includes("'" + file + "'"), 'Missing build input: ' + file);
  }
});

test('production shell references canonical frontend bundles', () => {
  const entry = read('index.html');
  assert.ok(entry.includes('meehoa-core.css'));
  assert.ok(entry.includes('meehoa-core.js'));
  assert.ok(!/<script[^>]+src=["'][^"']*meehoa-v[0-9]+/i.test(entry));
  assert.ok(!/<link[^>]+href=["'][^"']*meehoa-v[0-9]+/i.test(entry));
});

test('deterministic build retains ownership and hotfix checks', () => {
  const builder = read('scripts/build-runtime.cjs');
  for (const value of ['forbiddenRuntimeNames', 'runtime-ownership.json', 'meehoa-core.css', 'meehoa-core.js']) {
    assert.ok(builder.includes(value), 'Missing build contract: ' + value);
  }
});
