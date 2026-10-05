const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const ui=fs.readFileSync('assets/meehoa-order-actions.js','utf8');
const edge=fs.readFileSync('supabase/functions/meehoasg-order-actions/index.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/202610060110_enforce_canonical_shipping_and_settlement_amounts.sql','utf8');
const build=fs.readFileSync('scripts/build-runtime.cjs','utf8');
const ownership=JSON.parse(fs.readFileSync('runtime-ownership.json','utf8'));

test('shipping and settlement have a declared canonical runtime owner',()=>{
  assert.deepEqual(ownership.shippingAndSettlement.files,['meehoa-order-actions.js']);
  assert.match(build,/meehoa-order-actions\.js/);
});

test('sale settlement cannot edit ship fee and florist/admin owns ship fee entry',()=>{
  assert.match(ui,/\['ADMIN','THO_OPS'\]\.includes\(S\.user\.role\)/);
  assert.match(ui,/Sale không nhập\/sửa phí ship/);
  assert.match(ui,/Thợ cần nhập phí ship trước khi gửi tất toán/);
  assert.doesNotMatch(ui,/submitSettlement[\s\S]{0,1200}shipFee:moneyDigits/);
  assert.match(edge,/\['ADMIN','THO_OPS'\]\.includes\(user\.role\)/);
  assert.match(edge,/shop&&!o\.ship_confirmed/);
  assert.match(edge,/ship=shop\?num\(o\.ship_fee\):0/);
});

test('settlement amount uses card quantity and database canonicalization',()=>{
  assert.match(edge,/Math\.max\(1,Math\.min\(99,Math\.floor\(num\(o\.card_qty\)\|\|1\)\)\)/);
  assert.match(migration,/greatest\(1,coalesce\(o\.card_qty,1\)\)\*10000/);
  assert.match(migration,/new\.required_amount := coalesce\(o\.flower_total,0\) \+ accessory/);
});

test('legacy unauthorized ship fee writes are blocked at database boundary',()=>{
  assert.match(migration,/SHIP_FEE_ROLE_REQUIRED/);
  assert.match(migration,/ship_fee_updated_role/);
  assert.match(migration,/in \('ADMIN','THO_OPS'\)/);
});

test('locked production orders cannot enter bulk selection',()=>{
  assert.match(ui,/if\(o&&!o\.canOperate\)\{cb\.checked=false;cb\.disabled=true/);
  assert.match(ui,/if\(v&&o&&!o\.canOperate\)/);
});

test('multi-card amount is repaired in debt and drawer display',()=>{
  assert.match(ui,/function patchCardFinance/);
  assert.match(ui,/Number\(o\.cardFee\)\|\|qty\*10000/);
  assert.match(ui,/\+10\\\.000đ thiệp/);
  assert.match(ui,/\+ Thiệp × /);
  assert.match(ui,/b\.textContent=money\(amount\)/);
});
