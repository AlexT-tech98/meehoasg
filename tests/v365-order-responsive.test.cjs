const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('v365 shell points to new API and cached shell',()=>{
  const s=fs.readFileSync('index.html','utf8');
  assert.match(s,/meehoasg-api-v365/);
  assert.match(s,/meehoa-v365\.css/);
  assert.match(s,/meehoa-v365\.js/);
  assert.match(s,/localStorage\.getItem\(SHELL_KEY\)/);
  assert.match(s,/meehoa-scroll-contract\.css/);
});

test('order patch adds card quantity and multiline fields',()=>{
  const s=fs.readFileSync('assets/meehoa-v365.js','utf8');
  assert.match(s,/name=\"cardQty\"/);
  assert.match(s,/10\.000đ × số lượng/);
  assert.match(s,/replaceTextInput/);
  assert.match(s,/flowerTotal','depositAmount','charmFee','paperFee','vat/);
  assert.match(s,/dataset\.meeHideCreateV365/);
});

test('responsive CSS provides desktop left rail without overriding the login theme',()=>{
  const s=fs.readFileSync('assets/meehoa-v365.css','utf8');
  assert.match(s,/@media \(min-width: 901px\)/);
  assert.match(s,/width:164px!important/);
  assert.match(s,/Login intentionally inherits the pre-v3\.6\.5 production styling/);
  assert.doesNotMatch(s,/content:\"🐶  🐱\"/);
  assert.doesNotMatch(s,/HÔM NAY MÌNH LÀM HOA GÌ NÈ/);
  assert.match(s,/mee-card-qty-v365/);
});

test('launch splash uses illustrated dog and cat elements instead of emoji icons',()=>{
  const s=fs.readFileSync('index.html','utf8');
  assert.match(s,/MEEHOA · VẬN HÀNH MỖI NGÀY/);
  assert.match(s,/class=\"pet pet-cat\"/);
  assert.match(s,/class=\"pet pet-dog\"/);
  assert.match(s,/class=\"flower-doodle flower-a\"/);
  assert.match(s,/Đang mở Meehoa Ops…/);
  assert.doesNotMatch(s,/🐶|🐱|🌷|🌼/);
});

test('API wrapper prices cards by quantity',()=>{
  const s=fs.readFileSync('supabase/functions/meehoasg-api-v365/index.js','utf8');
  assert.match(s,/card_qty/);
  assert.match(s,/Math\.max\(1,num\(r\.card_qty\)\)\*10000/);
  assert.match(s,/required_amount:required/);
});
