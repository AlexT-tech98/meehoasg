const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('supabase/functions/meehoasg-api-core/index.js','utf8').replace(/^import .*\n/gm,'');
function fixture(){const logs=[];const c={TextEncoder,URL,Date,Intl,console:{warn:(...a)=>logs.push(a)},createOperationService:()=>({}),createOperationStorage:()=>({}),Deno:{env:{get:()=>''},serve(){}}};vm.createContext(c);vm.runInContext(source,c);return {c,logs};}
test('diagnostics use authenticated actor and discard arbitrary fields and raw errors',async()=>{
 const {c,logs}=fixture();vm.runInContext("requireUser=async()=>({username:'pu',role:'SALE'})",c);
 c.input={diagnosticId:'save-abc-123',orderId:'MEE-TEST',stage:'serialize',build:'fixture',errorName:'InvalidStateError',errorCode:'CLIENT_ERROR',sourceLocation:'html:850:9',browser:'ios-webkit',token:'secret',username:'admin',message:'customer data',order:{customer:'private'},stack:'private'};
 assert.equal((await vm.runInContext('logOrderSaveFailure(input)',c)).ok,true);
 const log=JSON.parse(logs[0][1]);assert.equal(log.username,'pu');assert.equal(log.role,'SALE');assert.equal(log.stage,'serialize');assert.equal(log.sourceLocation,'html:850:9');
 assert.equal(JSON.stringify(log).includes('secret'),false);assert.equal(JSON.stringify(log).includes('private'),false);assert.equal(log.message,undefined);assert.equal(log.stack,undefined);
});
test('diagnostics reject missing authentication and invalid stages before logging',async()=>{
 const {c,logs}=fixture();c.input={diagnosticId:'save-abc-123',stage:'serialize'};
 vm.runInContext("requireUser=async()=>{throw Error('AUTH_REQUIRED')}",c);
 await assert.rejects(vm.runInContext('logOrderSaveFailure(input)',c),/AUTH_REQUIRED/);assert.equal(logs.length,0);
 vm.runInContext("requireUser=async()=>({username:'pu',role:'SALE'})",c);c.input.stage='anything';
 assert.equal((await vm.runInContext('logOrderSaveFailure(input)',c)).code,'INVALID_DIAGNOSTIC');assert.equal(logs.length,0);
});
