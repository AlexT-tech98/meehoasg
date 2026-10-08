const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const ui=fs.readFileSync('assets/meehoa-order-actions.js','utf8');
const edge=fs.readFileSync('supabase/functions/meehoasg-order-actions/index.ts','utf8');
const settlementMigration=fs.readFileSync('supabase/migrations/202610060110_enforce_canonical_shipping_and_settlement_amounts.sql','utf8');
const shippingMigration=fs.readFileSync('supabase/migrations/202610060240_allow_sale_own_order_ship_fee.sql','utf8');
const atomic=fs.readFileSync('supabase/migrations/20261008150000_atomic_operations.sql','utf8');
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
  assert.match(atomic,/u\.role not in \('ADMIN','THO_OPS','SALE'\)/);
  assert.match(atomic,/u\.role='SALE' and not public\.mee_ops_owner\(o\.sale,u\)/);
  assert.match(atomic,/Sale chỉ được cập nhật đơn do mình phụ trách/);
  assert.doesNotMatch(ui,/Sale không nhập\/sửa phí ship/);
});

test('settlement still locks canonical shipping before request submission',()=>{
  assert.match(ui,/Phí ship phải được xác nhận trước khi gửi tất toán/);
  assert.match(ui,/Cần nhập phí ship trước khi gửi tất toán/);
  assert.doesNotMatch(ui,/submitSettlement[\s\S]{0,1200}shipFee:moneyDigits/);
  assert.match(atomic,/not o\.ship_confirmed/);
  assert.match(atomic,/then o\.ship_fee else 0 end/);
});

test('settlement amount uses card quantity and database canonicalization',()=>{
  assert.match(atomic,/greatest\(1,coalesce\(o\.card_qty,1\)\)\*10000/);
  assert.match(settlementMigration,/greatest\(1,coalesce\(o\.card_qty,1\)\)\*10000/);
  assert.match(settlementMigration,/new\.required_amount := coalesce\(o\.flower_total,0\) \+ accessory/);
});

test('database boundary permits own-sale shipping but blocks non-owner sale',()=>{
  assert.match(shippingMigration,/coalesce\(new\.ship_fee_updated_role,''\) = 'SALE'/);
  assert.match(shippingMigration,/u\.username = new\.ship_fee_updated_by/);
  assert.match(shippingMigration,/old\.sale/);
  assert.match(shippingMigration,/SHIP_FEE_OWNER_REQUIRED/);
  assert.match(shippingMigration,/in \('ADMIN','THO_OPS'\)/);
});

test('locked production orders cannot enter bulk selection',()=>{
  assert.match(ui,/if\(o&&!o\.canOperate\)\{cb\.checked=false;cb\.disabled=true/);
  assert.match(ui,/if\(v&&o&&!o\.canOperate\)/);
});

test('multi-card finance is canonical in base drawer without a DOM repair patch',()=>{
  const base=fs.readFileSync('html','utf8');
  assert.doesNotMatch(ui,/function patchCardFinance/);
  assert.match(base,/cardFee=Number\(o\.cardFee\)\|\|cardQty\*10000/);
  assert.match(base,/Thiệp × '\+cardQty/);
  assert.match(base,/GHI CHÚ KHÁCH/);
  assert.match(base,/NỘI DUNG THIỆP/);
});
