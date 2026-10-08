const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const src=fs.readFileSync('html','utf8');

function functionSource(name,next){
  const start=src.indexOf('function '+name);
  const end=src.indexOf(next,start);
  assert.ok(start>=0&&end>start,`${name} source must exist`);
  return src.slice(start,end).trim();
}

test('approved accessory state counts every selected extra cost in order total preview',()=>{
  const fn=functionSource('accessoryStateFromOrder','function accessoryEditor');
  const accessoryState=vm.runInNewContext('('+fn+')',{isShop:v=>String(v).toLowerCase().includes('shop')});
  const state=accessoryState({
    card:true,cardQty:2,banner:true,charmFee:15000,paperFee:20000,vat:10000,
    shipping:'Shop book ship',shipConfirmed:true,shipFee:50000
  });
  assert.equal(state.count,6);
  assert.equal(state.total,150000);
});

test('accessory editor is collapsed by default and exposes exactly the approved six menu types',()=>{
  const stateFn=functionSource('accessoryStateFromOrder','function accessoryEditor');
  const editorFn=functionSource('accessoryEditor','function toggleAccessoryPanel');
  const ctx={
    isShop:v=>String(v).toLowerCase().includes('shop'),
    vnd:v=>new Intl.NumberFormat('vi-VN').format(Number(v)||0)+' ₫',
    esc:v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
    attr:v=>String(v??'')
  };
  vm.createContext(ctx);
  vm.runInContext(stateFn+'\nthis.accessoryStateFromOrder=accessoryStateFromOrder;',ctx);
  const editor=vm.runInContext('('+editorFn+')',ctx);
  const html=editor({});
  assert.match(html,/PHỤ KIỆN/);
  assert.match(html,/class="mee-accessory-body hidden" id="accessoryBody"/);
  for(const label of ['Thiệp','Banner','Phí ship','Thay giấy','Đính charm','VAT'])assert.match(html,new RegExp(label));
  assert.equal((html.match(/data-accessory-menu=/g)||[]).length,6);
});

test('drawer separates customer note and card content from finance rows',()=>{
  const fn=functionSource('detail','function openShipFeeForm');
  const ctx={
    dateVN:v=>v,timeVN:v=>v,esc:v=>String(v??''),multiline:v=>String(v??'').replace(/\n/g,'<br>'),
    vnd:v=>new Intl.NumberFormat('vi-VN').format(Number(v)||0)+' ₫'
  };
  const detail=vm.runInNewContext('('+fn+')',ctx);
  const cardText='Dòng 1\nDòng 2';
  const note='Mặt ngửa\nMặt úp';
  const html=detail({
    id:'MEE-TEST',date:'2026-10-20',time:'09:00',sale:'Sale A',phone:'0900',flower:'Hoa',note,
    shipping:'Ghé lấy',address:'',flowerTotal:1500000,card:true,cardQty:2,cardFee:20000,cardText,
    banner:false,charmFee:0,paperFee:0,vat:0,accessoryTotal:20000,shipFeePending:false,shipFee:0,paid:750000,debt:770000
  },true);
  assert.match(html,/GHI CHÚ KHÁCH/);
  assert.match(html,/NỘI DUNG THIỆP/);
  assert.match(html,/Mặt ngửa<br>Mặt úp/);
  assert.match(html,/Dòng 1<br>Dòng 2/);
  assert.match(html,/Thiệp × 2/);
  assert.match(html,/20\.000 ₫/);
  const finance=html.slice(html.indexOf('TÀI CHÍNH & THANH TOÁN'));
  assert.doesNotMatch(finance,/Dòng 1|Dòng 2/);
});

test('KPI remains flower-only while form ship fee is persisted separately',()=>{
  const core=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8');
  assert.match(core,/item\.revenue\+=num\(r\.flower_total\)/);
  const shared=fs.readFileSync('supabase/functions/_shared/operations.js','utf8');assert.match(shared,/ship_fee:shipActive\?operationMoney\(d\.shipFee\):0/);
  assert.match(shared,/ship_confirmed:shipActive/);
  assert.doesNotMatch(core,/item\.revenue\+=.*accessory/);
});
