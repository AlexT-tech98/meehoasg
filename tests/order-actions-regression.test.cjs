const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const ui=fs.readFileSync('assets/meehoa-order-actions.js','utf8');
const edge=fs.readFileSync('supabase/functions/meehoasg-order-actions/index.ts','utf8');
const settlementMigration=fs.readFileSync('supabase/migrations/202610060110_enforce_canonical_shipping_and_settlement_amounts.sql','utf8');
const shippingMigration=fs.readFileSync('supabase/migrations/202610060240_allow_sale_own_order_ship_fee.sql','utf8');
const build=fs.readFileSync('scripts/build-runtime.cjs','utf8');
const ownership=JSON.parse(fs.readFileSync('runtime-ownership.json','utf8'));

test('shipping and settlement have a declared canonical runtime owner',()=>{
  assert.deepEqual(ownership.shippingAndSettlement.files,['meehoa-order-actions.js']);
  assert.match(build,/meehoa-order-actions\.js/);
});

test('sale can edit shipping on own order while other-sale orders stay blocked',()=>{
  assert.match(ui,/function ownsOrder\(o\)/);
  assert.match(ui,/S\.user\.role==='SALE'&&ownsOrder\(o\)/);
  assert.match(ui,/Sale chỉ được nhập phí ship đơn của mình/);
  assert.match(edge,/\['ADMIN','THO_OPS','SALE'\]\.includes\(user\.role\)/);
  assert.match(edge,/user\.role==='SALE'&&!ownsOrder\(o,user\)/);
  assert.match(edge,/Sale chỉ được nhập phí ship đơn do mình phụ trách/);
  assert.doesNotMatch(ui,/Sale không nhập\/sửa phí ship/);
});

test('settlement still locks canonical shipping before request submission',()=>{
  assert.match(ui,/Phí ship phải được xác nhận trước khi gửi tất toán/);
  assert.match(ui,/Cần nhập phí ship trước khi gửi tất toán/);
  assert.doesNotMatch(ui,/submitSettlement[\s\S]{0,1200}shipFee:moneyDigits/);
  assert.match(edge,/shop&&!o\.ship_confirmed/);
  assert.match(edge,/ship=shop\?num\(o\.ship_fee\):0/);
});

test('settlement amount uses card quantity and database canonicalization',()=>{
  assert.match(edge,/Math\.max\(1,Math\.min\(99,Math\.floor\(num\(o\.card_qty\)\|\|1\)\)\)/);
  assert.match(settlementMigration,/greatest\(1,coalesce\(o\.card_qty,1\)\)\*10000/);
  assert.match(settlementMigration,/new\.required_amount := coalesce\(o\.flower_total,0\) \+ accessory/);
});

test('database boundary permits own-sale shipping but blocks non-owner sale',()=>{
  assert.match(shippingMigration,/ship_fee_updated_role,'?\)'? = 'SALE'|ship_fee_updated_role,''\) = 'SALE'/);
  assert.match(shippingMigration,/u\.username = new\.ship_fee_updated_by/);
  assert.match(shippingMigration,/old\.sale/);
  assert.match(shippingMigration,/SHIP_FEE_OWNER_REQUIRED/);
  assert.match(shippingMigration,/in \('ADMIN','THO_OPS'\)/);
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
