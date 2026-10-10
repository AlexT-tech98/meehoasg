const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('refactor shell points to consolidated API and frontend cores',()=>{
  const s=fs.readFileSync('index.html','utf8');
  assert.match(s,/meehoasg-api-core/);
  assert.match(s,/meehoa-core\.css\?v=[A-Za-z0-9._-]+/);
  assert.match(s,/meehoa-core\.js\?v=[A-Za-z0-9._-]+/);
  assert.match(s,/localStorage\.getItem\(SHELL_KEY\)/);
  assert.doesNotMatch(s,/meehoa-scroll-contract\.css\?v=/);
});

test('canonical base form owns card quantity and latest runtime only enhances fields',()=>{
  const base=fs.readFileSync('html','utf8');
  const latest=fs.readFileSync('assets/meehoa-v366.js','utf8');
  assert.match(base,/name="cardQty"/);
  assert.match(base,/10\.000đ \/ thiệp/);
  assert.match(base,/function accessoryEditor/);
  assert.match(latest,/replaceTextInput/);
  assert.match(latest,/flowerTotal','depositAmount','charmFee','paperFee','vat','shipFee/);
  assert.doesNotMatch(latest,/function patchCardQty/);
  assert.doesNotMatch(latest,/meeHideCreateV365/);
});

test('canonical responsive CSS owns desktop left rail, login and order ergonomics',()=>{
  const s=fs.readFileSync('assets/meehoa-v365.css','utf8');
  assert.match(s,/@media \(min-width: 901px\)/);
  assert.match(s,/width:164px!important/);
  assert.match(s,/\.login:not\(\.hidden\)/);
  assert.doesNotMatch(s,/content:\"🐶  🐱\"/);
  assert.doesNotMatch(s,/HÔM NAY MÌNH LÀM HOA GÌ NÈ/);
  assert.match(s,/mee-card-qty-v365/);
});

test('the real bootSplash is replaced and styled; no transient loading card remains in index body',()=>{
  const entry=fs.readFileSync('index.html','utf8');
  const css=fs.readFileSync('assets/meehoa-v365.css','utf8');
  assert.match(entry,/OLD_SPLASH/);
  assert.match(entry,/NEW_SPLASH/);
  assert.match(entry,/html=html\.replace\(OLD_SPLASH,NEW_SPLASH\)/);
  assert.match(entry,/mee-splash-cat/);
  assert.match(entry,/mee-splash-dog/);
  assert.match(entry,/MEEHOA · VẬN HÀNH MỖI NGÀY/);
  assert.match(entry,/Đang mở Meehoa Ops…/);
  assert.match(entry,/<div id=\"meeBoot\"><\/div>/);
  assert.doesNotMatch(entry,/<div class=\"boot-card\">/);
  assert.match(css,/#bootSplash\.boot-splash:not\(\.hidden\)/);
  assert.match(css,/mee-splash-card/);
  assert.doesNotMatch(entry,/🐶|🐱|🌷|🌼/);
});

test('API wrapper prices cards by quantity',()=>{
  const s=fs.readFileSync('supabase/functions/meehoasg-api-v365/index.js','utf8');
  assert.match(s,/card_qty/);
  assert.match(s,/Math\.max\(1,num\(r\.card_qty\)\)\*10000/);
  assert.match(s,/required_amount:required/);
});
