const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const ui=fs.readFileSync('html','utf8');
const core=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');
const migration=fs.readFileSync('supabase/migrations/20261007154500_full_paid_auto_settle.sql','utf8');

function fnSource(src,name,next){
  const start=src.indexOf('function '+name);
  const end=src.indexOf(next,start);
  assert.ok(start>=0&&end>start,name+' must exist');
  return src.slice(start,end).trim();
}

test('Full Paid is a separate payment option with evidence requirements',()=>{
  assert.match(ui,/value="full_order"/);
  assert.match(ui,/Đã thanh toán toàn bộ đơn/);
  assert.match(ui,/id="fullPaidBillFiles"/);
  assert.match(ui,/Full Paid bắt buộc có ảnh mẫu hoa/);
  assert.match(ui,/Full Paid bắt buộc có ảnh bill thanh toán/);
  assert.match(ui,/Full Paid với Shop book ship bắt buộc nhập phí ship/);
});

test('order total includes flower, all accessories, VAT and confirmed shop shipping',()=>{
  const card=vm.runInNewContext('('+fnSource(core,'cardQty','function accessoryTotal')+')',{num:Number});
  const acc=vm.runInNewContext('('+fnSource(core,'accessoryTotal','function orderTotal')+')',{cardQty:card,num:v=>Number(v)||0});
  const total=vm.runInNewContext('('+fnSource(core,'orderTotal','function paidAmount')+')',{
    norm:v=>String(v||'').toLowerCase(),num:v=>Number(v)||0,accessoryTotal:acc
  });
  const row={flower_total:500000,card:true,card_qty:2,banner:true,charm_fee:15000,paper_fee:20000,vat:10000,shipping:'Shop book ship',ship_confirmed:true,ship_fee:45000};
  assert.equal(total(row),645000);
});

test('Full Paid is excluded from debt and included in KPI verification',()=>{
  assert.match(core,/if\(o\.status!=='Đã giao'\|\|o\.paymentVerified\|\|o\.debt<=0\)return false/);
  assert.match(core,/if\(!\(r\.settled\|\|r\.full_paid\)\)continue/);
  assert.match(core,/canSubmitSettlement:!locked&&!fullPaid/);
  assert.match(core,/settlementStatus:ss/);
  assert.match(core,/AUTO_FULL_PAID/);
});

test('financial increase invalidates Full Paid but preserves prior paid amount',()=>{
  assert.match(migration,/new_total > coalesce\(old\.full_paid_total,0\)/);
  assert.match(migration,/new\.full_paid := false/);
  assert.match(migration,/ORDER_TOTAL_INCREASED/);
  assert.match(migration,/new\.payment := 'Đã thanh toán '/);
});

test('Full Paid report supports evidence audit and CSV export',()=>{
  assert.match(core,/async function fullPaidReport/);
  assert.match(core,/billUrls:bills,imageUrls:samples,exception/);
  assert.match(ui,/Báo cáo Full Paid/);
  assert.match(ui,/exportFullPaidCsv/);
  assert.match(ui,/Số bill/);
  assert.match(ui,/Số ảnh mẫu/);
});
