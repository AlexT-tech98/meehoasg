const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const html=fs.readFileSync('html','utf8');
const begin=html.indexOf('    var signedImageCache = new Map();'),end=html.indexOf('    function imageSrc(',begin);
assert.ok(begin>=0&&end>begin);
const context={URL,Date,Map,atob};vm.createContext(context);vm.runInContext(html.slice(begin,end)+';this.check=stableSignedImageUrl;',context);
function jwt(exp){const payload=Buffer.from(JSON.stringify({exp})).toString('base64url');return 'a.'+payload+'.b'}
const path='https://example.supabase.co/storage/v1/object/sign/order-images/test.jpg?token=';
test('reuse still-valid original token across calls',()=>{const now=Math.floor(Date.now()/1000),a=path+jwt(now+3600),b=path+jwt(now+3900);assert.equal(context.check(a),a);assert.equal(context.check(b),a)});
test('expired old token never wins over fresh URL',()=>{const now=Math.floor(Date.now()/1000),a=path.replace('test.jpg','new.jpg')+jwt(now+120),b=path.replace('test.jpg','new.jpg')+jwt(now+3600);assert.equal(context.check(a),a);assert.equal(context.check(b),b)});
test('malformed expiry never cached',()=>{const a=path.replace('test.jpg','bad.jpg')+'not-jwt';assert.equal(context.check(a),a);assert.equal(context.check(a+'x'),a+'x')});
test('ready shipping changes blocked before file upload and API mutation',()=>{const save=html.slice(html.indexOf('function saveOrder('),html.indexOf('async function submitSettlement('));assert.ok(save.includes("['Chờ lấy','Chờ giao'].includes(oldOrder.status)"));assert.ok(save.includes('Đơn đã ở trạng thái Chờ lấy/Chờ giao'));assert.ok(save.indexOf('Đơn đã ở trạng thái Chờ lấy/Chờ giao')<save.indexOf("stage='files'"));});
