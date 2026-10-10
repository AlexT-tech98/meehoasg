const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function pngSize(path) {
  const data = fs.readFileSync(path);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

test('standalone app provides sized home-screen icons', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));
  const entry = fs.readFileSync('index.html', 'utf8');
  assert.equal(manifest.display, 'standalone');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(x => x.sizes === `${size}x${size}`);
    assert.ok(icon?.purpose.includes('maskable'));
    assert.deepEqual(pngSize(`assets/meehoa-app-icon-${size}.png`), [size, size]);
  }
  assert.deepEqual(pngSize('assets/meehoa-apple-touch-icon.png'), [180, 180]);
  assert.match(entry, /apple-touch-icon\.png\?v=8/);
});
