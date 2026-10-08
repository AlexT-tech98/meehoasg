const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const src=fs.readFileSync('html','utf8');
const save=src.slice(src.indexOf('async function saveOrder(e,id){'),src.indexOf('async function submitSettlement'));
function harness(values={},options={}){
  const messages=[],requests=[],window={_orderRequestId:'request-1',_pasted:[],_editExistingUrls:[]};
  const btn={disabled:false,textContent:'Tạo đơn',dataset:{}};
  const form={dataset:{detailReady:'1'},isConnected:true};
  const fields={imageFiles:{files:options.samples||[]},fullPaidBillFiles:{files:options.bills||[]},orderSubmit:btn};
  const input={customer:'Khách',date:'2026-10-08',time:'16:00',flower:'Hoa tươi',flowerTotal:'700.000',paymentType:'unpaid',sale:'C Mụi',shipping:'Ghé lấy',...values};
  const context={window,document:{getElementById:k=>fields[k]},S:{user:{role:'ADMIN'},page:'orders',dirty:new Set()},
    FormData:class{entries(){return Object.entries(input)}has(k){return k in input}},
    validateOrderForm:()=>options.valid!==false,orderFormFeedback:(_,m)=>{messages.push(m);return false},toast:m=>messages.push(m),
    moneyDigits:v=>Number(String(v).replace(/\D/g,'')),isShop:v=>/shop/i.test(v),safeUuid:()=> 'fallback-1',orderById:()=>({}),
    fileData:async f=>{if(options.fileError)throw Error('Không đọc được ảnh');return f},
    actionRun:fn=>fn(),gas:async(name,p)=>{requests.push({name,p});return options.response?options.response():{ok:true,orderId:'MEE-1',order:{id:'MEE-1'}}},
    orderMutationDirty(){},applyCanonicalOrder(){},refreshOrderEntity:async()=>{},closeOverlay(){},showCreatedOrderCopy(){if(options.displayError)throw Error('render failed');form.isConnected=false}
  };
  vm.createContext(context);vm.runInContext(save,context);
  return {run:id=>context.saveOrder({target:form,preventDefault(){}},id||''),form,btn,window,messages,requests};
}
test('invalid required fields never send an order',async()=>{const h=harness({}, {valid:false});await h.run();assert.equal(h.requests.length,0);});
test('full payment without sample or bill is visible in form and sends nothing',async()=>{
  const a=harness({paymentType:'full_order'});await a.run();assert.match(a.messages[0],/ảnh mẫu/);assert.equal(a.requests.length,0);
  const b=harness({paymentType:'full_order'},{samples:[{}]});await b.run();assert.match(b.messages[0],/ảnh bill/);assert.equal(b.requests.length,0);
});
test('full payment with shop delivery requires shipping confirmation',async()=>{const h=harness({paymentType:'full_order',shipping:'Shop book ship'},{samples:[{}],bills:[{}]});await h.run();assert.match(h.messages[0],/phí ship/);assert.equal(h.requests.length,0);});
test('reading image failure keeps form and restores submit',async()=>{const h=harness({}, {samples:[{}],fileError:true});await h.run();assert.equal(h.requests.length,0);assert.equal(h.btn.disabled,false);assert.equal(h.form.dataset.saving,'0');assert.match(h.messages.at(-1),/Không đọc được ảnh/);});
test('double click sends once and success clears identity',async()=>{
  let release;const h=harness({}, {response:()=>new Promise(r=>release=r)});const first=h.run();await new Promise(r=>setImmediate(r));await h.run();assert.equal(h.requests.length,1);release({ok:true,orderId:'MEE-1',order:{id:'MEE-1'}});await first;assert.equal(h.window._orderRequestId,'');
});
test('lost response preserves same identity on manual retry',async()=>{
  let calls=0;const h=harness({}, {response:()=>{if(++calls===1)throw Error('NetworkError');return {ok:true,orderId:'MEE-1',order:{id:'MEE-1'}}}});await h.run();assert.equal(h.btn.disabled,false);assert.equal(h.window._orderRequestId,'request-1');assert.match(h.messages.at(-1),/Chưa xác nhận/);await h.run();assert.equal(h.requests[0].p.requestId,h.requests[1].p.requestId);
});
test('server partial-write failure never asserts that no order exists',async()=>{const h=harness({}, {response:()=>({ok:false,code:'SERVER_ERROR',message:'Máy chủ gặp lỗi'})});await h.run();assert.match(h.messages.at(-1),/Chưa xác nhận/);assert.equal(h.form.isConnected,true);});
test('display failure after save blocks a second creation',async()=>{const h=harness({}, {displayError:true});await h.run();assert.match(h.messages.at(-1),/Đơn đã được lưu/);assert.equal(h.btn.disabled,true);await h.run();assert.equal(h.requests.length,1);});
test('API validation rejection is displayed and form stays editable',async()=>{const h=harness({}, {response:()=>({ok:false,message:'Phiên đăng nhập đã hết hạn',code:'AUTH_REQUIRED'})});await h.run();assert.match(h.messages.at(-1),/Phiên đăng nhập/);assert.equal(h.btn.disabled,false);});

test('required whitespace is rejected and focused by the actual validator',()=>{
  const start=src.indexOf('function validateOrderForm(form){'),end=src.indexOf('async function saveOrder',start);
  let reported,focused;
  const field={disabled:false,willValidate:true,required:true,value:'   ',name:'customer',checkValidity:()=>true,parentElement:{querySelector:()=>({textContent:'TÊN KHÁCH HÀNG'})},focus:()=>focused=true};
  const validate=vm.runInNewContext('('+src.slice(start,end).trim()+')',{orderFormFeedback:(form,message,error,target)=>{reported=message;target.focus();return false}});
  assert.equal(validate({querySelectorAll:()=>[field]}),false);assert.match(reported,/TÊN KHÁCH HÀNG/);assert.equal(focused,true);
  field.value='Khách';assert.equal(validate({querySelectorAll:()=>[field]}),true);
});
test('form controls native validation and feedback layers sit above overlay',()=>{
  assert.match(src,/orderForm\\" novalidate/);
  const css=fs.readFileSync('assets/meehoa-core.css','utf8');
  assert.match(css,/#overlay\{position:relative;z-index:1000!important\}/);
  assert.match(src,/\.toast\s*\{[^}]*z-index: 1100/s);assert.match(src,/\.loading\s*\{[^}]*z-index: 1090/s);
});
