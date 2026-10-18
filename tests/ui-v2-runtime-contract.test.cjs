const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('every canonical runtime source belongs to exactly one feature owner', () => {
  const owners = JSON.parse(read('runtime-ownership.json'));
  const registry = new Map();
  for (const [feature, definition] of Object.entries(owners)) {
    for (const file of definition.files || []) {
      assert.ok(!registry.has(file), `Duplicate runtime owner: ${file} (${registry.get(file)} / ${feature})`);
      registry.set(file, feature);
    }
  }
  const builder = read('scripts/build-runtime.cjs');
  for (const file of registry.keys()) {
    assert.ok(fs.existsSync(path.join(root, 'assets', file)), `Missing owned runtime file: ${file}`);
    assert.ok(builder.includes("'" + file + "'"), `Owned source not declared by deterministic build: ${file}`);
  }
});

test('frontend shell loads only canonical compiled CSS and JS', () => {
  const entry = read('index.html');
  assert.ok(entry.includes('meehoa-core.css'));
  assert.ok(entry.includes('meehoa-core.js'));
  assert.ok(entry.includes('meehoa-core.css'));
  assert.ok(entry.includes('meehoa-core.js'));
  assert.ok(!/<script[^>]+src=["'][^"']*meehoa-v[0-9]+/i.test(entry));
  assert.ok(!/<script[^>]+src=["'][^"']*meehoa-v[0-9]+/i.test(entry));
});

test('canonical build prohibits fix/hotfix layers and keeps deterministic ownership', () => {
  const builder = read('scripts/build-runtime.cjs');
  assert.ok(builder.includes('forbiddenRuntimeNames'));
  assert.ok(builder.includes('runtime-ownership.json'));
  assert.ok(builder.includes('meehoa-core.css'));
  assert.ok(builder.includes('meehoa-core.js'));
  assert.ok(builder.includes('forbiddenRuntimeNames'));
  assert.ok(builder.includes('runtime-ownership.json'));
  assert.ok(builder.includes('meehoa-core.css'));
  assert.ok(builder.includes('meehoa-core.js'));
  assert.ok(builder.includes('forbiddenRuntimeNames'));
  assert.ok(builder.includes('runtime-ownership.json'));
  assert.ok(builder.includes('meehoa-core.css'));
  assert.ok(builder.includes('meehoa-core.js'));
  assert.ok(builder.includes('forbiddenRuntimeNames'));
  assert.ok(builder.includes('runtime-ownership.json'));
  assert.ok(builder.includes('meehoa-core.css'));
  assert.ok(builder.includes('meehoa-core.js'));
});
