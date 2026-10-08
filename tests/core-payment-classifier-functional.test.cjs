const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8').replace(/^import .*\n/gm,'');
const context={console,TextEncoder,URL,Date,Intl,createOperationService:()=>({}),createOperationStorage:()=>({uploadImages:async()=>[],discard:async()=>{}}),Deno:{env:{get:()=>''},serve(){} }};vm.createContext(context);vm.runInContext(source,context);
test('core shows the original collected amount and remaining debt after a price increase',()=>{
 assert.equal(vm.runInContext("paidAmount('Đã thanh toán 500000 đ',600000,0)",context),500000);
 assert.equal(vm.runInContext("paidAmount('Đã cọc 500 đ',1000,0)",context),500);
 assert.equal(vm.runInContext("paidAmount('Cọc 62k',100000,0)",context),62000);
 context.row={id:'ONE',flower_total:600000,payment:'Đã thanh toán 500000 đ',shipping:'Ghé lấy',image_urls:[],sale:'sale1'};
 const order=vm.runInContext("decorate(row,{username:'sale1',role:'SALE'},null,{map:new Map()})",context);assert.equal(order.paid,500000);assert.equal(order.debt,100000);assert.equal(order.paymentVerified,false);
});
test('local mixed bouquet fallback retains lily variants alongside Ecuador roses',()=>{
 for(const description of ['Ly hồng + Hồng Ecuador','Ly hồng và Hồng Ecuador','Ly hồng Hồng Ecuador']){const names=vm.runInContext('localFlowers('+JSON.stringify(description)+')',context);assert.ok(names.includes('Ly hồng'),description);assert.ok(names.includes('Hồng Ecuador'),description);}
 const names=vm.runInContext("localFlowers('Ly sơn xanh đậm, Tulip')",context);assert.ok(names.includes('Ly sơn xanh đậm'));assert.ok(names.includes('Tulip'));
});
