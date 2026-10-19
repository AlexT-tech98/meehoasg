const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const html=fs.readFileSync('html','utf8');
const begin=html.indexOf('function ordersDebtNotes(o)'),end=html.indexOf('function shipFeeAction(o)',begin);
assert.ok(begin>=0&&end>begin,'canonical Orders debt note owner exists');
const note=new Function('vnd','isShop','esc',html.slice(begin,end)+';return ordersDebtNotes;')(n=>n.toLocaleString('vi-VN')+'đ',s=>/shop/i.test(s),s=>String(s));
test('Orders debt breakdown shows the full multi-banner charge and quantity',()=>{
 const result=note({banner:true,bannerQty:3,shipping:'Ghé lấy'});
 assert.match(result,/\+105\.000đ banner \(×3\)/);
 assert.doesNotMatch(result,/\+35\.000đ banner/);
});
test('legacy missing quantity remains one banner and no-banner records add no charge',()=>{
 assert.match(note({banner:true,shipping:'Ghé lấy'}),/\+35\.000đ banner/);
 assert.doesNotMatch(note({banner:false,bannerQty:3,shipping:'Ghé lấy'}),/banner/);
});
