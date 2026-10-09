const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let nextId=1;
class Sheet{
 constructor(name){this.name=name;this.id=nextId++;this.rows=[Array(25).fill('Header')];this.failMeta=false;this.failDelete=false;this.loseAppend=false;}
 getName(){return this.name}getSheetId(){return this.id}getLastRow(){return this.rows.length}setFrozenRows(){}
 appendRow(values){this.rows.push([...values]);if(this.loseAppend){this.loseAppend=false;throw Error('APPEND_RESPONSE_LOST')}}
 deleteRow(row){if(this.failDelete)throw Error('DELETE_FAILED');this.rows.splice(row-1,1)}
 getRange(row,col,height=1,width=1){const sh=this;return{
   getValues(){return Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>sh.rows[row-1+i]?.[col-1+j]??''));},
   getDisplayValue(){return String(sh.rows[row-1]?.[col-1]??'');},
   setValues(values){if(sh.failMeta)throw Error('META_FAILED');values.forEach((v,i)=>{sh.rows[row-1+i]??=[];v.forEach((x,j)=>sh.rows[row-1+i][col-1+j]=x)});},
   copyTo(){},createTextFinder(id){return {matchEntireCell(){return this},findAll(){const out=[];for(let i=row-1;i<Math.min(row-1+height,sh.rows.length);i++)if(String(sh.rows[i][col-1])===id)out.push({getRow:()=>i+1});return out}};}
 };}
}
function harness(){
 const old=new Sheet('Tháng 09/2026'),target=new Sheet('Tháng 10/2026'),meta=new Sheet('ORDER_META');let sheets=[old,target],records=[],log=[];
 const ss={getSheetByName:name=>sheets.find(s=>s.name===name),getSheets:()=>sheets,insertSheet:name=>{const s=new Sheet(name);sheets.push(s);return s}};
 const props={values:new Map(),getProperty(key){return this.values.get(key)||null},setProperty(key,value){this.values.set(key,value)},deleteProperty(key){this.values.delete(key)}};
 const ctx={console,SpreadsheetApp:{openById:()=>ss},UrlFetchApp:{fetch(url,args){records.push(JSON.parse(args.payload));return {getResponseCode:()=>200,getContentText:()=>'{"ok":true}'}}}};
 vm.createContext(ctx);for(const name of ['apps-script-production-cutover-v9.1.gs','apps-script-production-sync-v9.2-fast.gs'])vm.runInContext(fs.readFileSync('supabase/functions/meehoasg-ingest/'+name,'utf8'),ctx);
 ctx._p91MetaSheet=()=>meta;ctx._p91Log=(level,message)=>log.push({level,message});
 const order={id:'A',customer:'Test',order_date:'2026-10-08',order_time:'10:00',flower:'Tulip',flower_total:500000,shipping:'Ghé lấy',sale:'sale1',image_urls:[]};
 old.appendRow(ctx._p91OrderRow({...order,order_date:'2026-09-30'},order.id));
 return {old,target,meta,props,records,log,ctx,order,ss,run:orders=>ctx._p92ApplyChangedOrders(orders||[order],props,'TEST_ONLY')};
}
function count(h,id){return h.ss.getSheets().reduce((n,s)=>n+s.rows.slice(1).filter(r=>r[14]===id).length,0)}
test('cross-month move leaves one order and records its final identity-based position',()=>{const h=harness();assert.equal(h.run().ok,true);assert.equal(count(h,'A'),1);assert.equal(h.old.rows.length,1);assert.equal(h.target.rows[1][14],'A');assert.equal(h.records[0].updates[0].source_sheet,h.target.name);assert.equal(h.props.values.size,0);});
test('metadata failure keeps source; retry resumes the journal without an extra append',()=>{const h=harness();h.meta.failMeta=true;assert.equal(h.run().ok,false);assert.equal(count(h,'A'),2);assert.equal(h.old.rows[1][14],'A');assert.equal(h.records.length,0);h.meta.failMeta=false;assert.equal(h.run().ok,true);assert.equal(count(h,'A'),1);assert.equal(h.target.rows.length,2);assert.equal(h.props.values.size,0);});
test('append response lost and failed deletion both recover without duplicate creation',()=>{for(const failure of ['loseAppend','failDelete']){const h=harness();(failure==='loseAppend'?h.target:h.old)[failure]=true;assert.equal(h.run().ok,false);assert.equal(count(h,'A'),2);h.old.failDelete=false;assert.equal(h.run().ok,true);assert.equal(count(h,'A'),1);}});
test('manual source changes after a partial move block deletion and preserve both versions',()=>{const h=harness();h.meta.failMeta=true;h.run();h.meta.failMeta=false;h.old.rows[1][5]='Human changed note';const result=h.run();assert.equal(result.ok,false);assert.match(result.message,/được sửa/);assert.equal(count(h,'A'),2);assert.equal(h.old.rows[1][5],'Human changed note');});
test('untracked duplicate ID blocks all writes rather than guessing which row is genuine',()=>{const h=harness();h.target.appendRow(h.ctx._p91OrderRow(h.order,'A'));const before=JSON.stringify(h.target.rows);assert.equal(h.run().ok,false);assert.equal(JSON.stringify(h.target.rows),before);assert.equal(h.records.length,0);});
test('final positions are recalculated after another move shifts rows in the same sheet',()=>{
 const h=harness(),b={...h.order,id:'B',order_date:'2026-09-30'},c={...h.order,id:'C',order_date:'2026-09-30'};
 h.old.appendRow(h.ctx._p91OrderRow(b,'B'));h.old.appendRow(h.ctx._p91OrderRow(c,'C'));
 assert.equal(h.run([b,h.order]).ok,true);const positions=h.records[0].updates;assert.equal(positions.find(p=>p.id==='B').source_row,2);assert.equal(h.old.rows[1][14],'B');assert.equal(h.old.rows[2][14],'C');
});
test('metadata exports card quantity and all Full Paid evidence without shifting original 17 columns',()=>{
 const h=harness();Object.assign(h.order,{card:true,card_qty:2,full_paid:true,full_paid_total:520000,full_paid_bill_urls:['supabase://settlement-bills/bill.jpg'],full_paid_by:'sale1',full_paid_at:'2026-10-08T00:00:00Z'});
 assert.equal(h.run().ok,true);const row=h.meta.rows[1];assert.equal(row.length,25);assert.equal(row[0],'A');assert.equal(row[17],2);assert.equal(row[18],true);assert.equal(row[19],520000);assert.equal(JSON.parse(row[20])[0],'supabase://settlement-bills/bill.jpg');
});
test('new month is added to an explicit sheet list so retry can rediscover it',()=>{
 const h=harness();h.props.setProperty('ORDER_SHEET_NAMES',h.old.name);h.order.order_date='2026-11-01';assert.equal(h.run().ok,true);assert.match(h.props.getProperty('ORDER_SHEET_NAMES'),/Tháng 11\/2026/);assert.equal(count(h,'A'),1);assert.equal(h.run().ok,true);assert.equal(count(h,'A'),1);
});
