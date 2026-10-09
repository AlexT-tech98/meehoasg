/* Canonical write service. Business data commits only through one SQL RPC. */
export function operationFailure(message, code='ORDER_INPUT_INVALID') { return {ok:false,code,message}; }
const clean=v=>String(v??'').trim();
const bool=v=>v===true||v===1||v==='1'||v==='true'||v==='on';
export function operationMoney(value, optional=false) {
  if(optional&&(value===undefined||value===null||value===''))return 0;
  if(typeof value==='number'){if(Number.isFinite(value)&&value>=0&&value<=999999999999)return value;throw Error('Số tiền không hợp lệ.');}
  let s=clean(value);
  if(!/^\d+(?:[.,]\d+)*$/.test(s))throw Error('Số tiền không hợp lệ.');
  if(/^\d{1,3}(?:[.,]\d{3})+$/.test(s))s=s.replace(/[.,]/g,'');
  else if(s.includes('.')&&s.includes(',')){
    if(!/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(s))throw Error('Số tiền không hợp lệ.');
    s=s.replaceAll('.','').replace(',','.');
  }else if((s.match(/[.,]/g)||[]).length<=1)s=s.replace(',','.');
  else throw Error('Số tiền không hợp lệ.');
  const n=Number(s);if(!Number.isFinite(n)||n<0||n>999999999999)throw Error('Số tiền không hợp lệ.');return n;
}
export function normalizeOperationOrder(input,user,current={}) {
  const d=input||{},date=clean(d.date),time=clean(d.time);
  const t=time.match(/^(\d{1,2}):(\d{2})$/);
  if(!clean(d.customer)||!clean(d.flower))throw Error('Thiếu tên khách hoặc mẫu hoa.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('Ngày nhận không hợp lệ.');
  if(!t||Number(t[1])>23||Number(t[2])>59)throw Error('Giờ nhận không hợp lệ.');
  if(!['Shop book ship','Khách tự book','Ghé lấy'].includes(clean(d.shipping)))throw Error('Hình thức vận chuyển không hợp lệ.');
  const card=bool(d.card),banner=bool(d.banner),qty=card?Number(d.cardQty??current.card_qty??1):0;
  if(card&&(!Number.isInteger(qty)||qty<1||qty>99||!clean(d.cardText)))throw Error('Thiệp cần số lượng 1–99 và nội dung.');
  if(banner&&!clean(d.bannerText))throw Error('Banner cần nội dung.');
  const shipping=clean(d.shipping),shipActive=clean(d.shipFeeActive)==='1';
  if(shipActive&&shipping!=='Shop book ship')throw Error('Phí ship chỉ dùng cho đơn Shop book ship.');
  return {customer:clean(d.customer),phone:clean(d.phone),order_date:date,order_time:t[1].padStart(2,'0')+':'+t[2],
    flower:clean(d.flower),note:clean(d.note),shipping,address:clean(d.address),flower_total:operationMoney(d.flowerTotal),payment:clean(d.payment),
    sale:user.role==='SALE'?user.username:clean(d.sale||current.sale||user.username),
    card,card_qty:qty,card_text:clean(d.cardText),banner,banner_text:clean(d.bannerText),
    charm_fee:operationMoney(d.charmFee,true),charm_text:clean(d.charmText),paper_fee:operationMoney(d.paperFee,true),paper_text:clean(d.paperText),vat:operationMoney(d.vat,true),
    ship_fee:shipActive?operationMoney(d.shipFee):0,ship_confirmed:shipActive,image_urls:[]};
}
export function privateImageIdentity(value){
  const s=clean(value);let m=s.match(/^supabase:\/\/(order-images|settlement-bills)\/(.+)$/);
  if(!m)m=s.match(/\/storage\/v1\/object\/(?:sign|public)\/(order-images|settlement-bills)\/([^?]+)/);
  return m?`supabase://${m[1]}/${decodeURIComponent(m[2])}`:s;
}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
export function createOperationService({db,one,uploadImages,sha256,newId,discardImages=async()=>{}}) {
  async function rpc(name,body){return db('rpc/'+name,{},'POST',body);}
  async function run(action,payload,user){
    const p=payload||{},requestId=clean(p.requestId);
    if(!requestId||requestId.length>128)return operationFailure('Thiếu mã yêu cầu hợp lệ.','REQUEST_ID_REQUIRED');
    const fingerprint=await sha256(JSON.stringify(stable({action,orderId:p.orderId||'',expectedUpdatedAt:p.expectedUpdatedAt||'',
      order:p.order||null,shipFee:p.shipFee??null,status:p.status||'',settlementId:p.settlementId||'',decision:p.decision||'',reason:p.reason||'',note:p.note||'',billFiles:p.billFiles||[]})));
    // Read a completed receipt before uploading; retries never mutate an order.
    const args={p_actor:user.username,p_request_id:requestId,p_action:action,p_fingerprint:fingerprint};
    const receipt=await rpc('mee_ops_lookup',args);if(receipt)return receipt;
    const input={orderId:clean(p.orderId),expectedUpdatedAt:clean(p.expectedUpdatedAt)};
    const staged=[];let submitted=false;
    const upload=async(files,bucket)=>{const urls=await uploadImages(files,bucket);staged.push(...urls);return urls;};
    const discard=async(urls)=>{try{await discardImages(urls);}catch(e){console.error('Unused upload cleanup failed',e);}};
    try{
    if(action==='createOrder'||action==='updateOrder'){
      let current={};
      if(action==='updateOrder'){
        current=await one('orders',{id:'eq.'+input.orderId});if(!current)return operationFailure('Không tìm thấy đơn.','NOT_FOUND');
        if(user.role==='SALE'&&![clean(user.username).toLowerCase(),clean(user.display_name).toLowerCase()].includes(clean(current.sale).toLowerCase()))return operationFailure('Sale chỉ được sửa đơn do mình phụ trách.','NOT_OWNER');
      }
      try{input.order=normalizeOperationOrder(p.order,user,current);}catch(e){return operationFailure(e.message);}
      input.newOrderId=newId('MEE');input.fullPaidRequested=bool(p.order?.fullPaidRequested);
      const retained=action==='updateOrder'?(Array.isArray(p.order?.imageUrls)?p.order.imageUrls:current.image_urls||[]):[];
      const currentIds=new Map((current.image_urls||[]).map(u=>[privateImageIdentity(u),u]));
      if(retained.some(u=>!currentIds.has(privateImageIdentity(u))))return operationFailure('Ảnh không thuộc đơn này.','IMAGE_INVALID');
      const imageFiles=Array.isArray(p.order?.imageFiles)?p.order.imageFiles:[],billFiles=Array.isArray(p.order?.fullPaidBillFiles)?p.order.fullPaidBillFiles:[];
      if(imageFiles.length>10||billFiles.length>10)return operationFailure('Tối đa 10 ảnh trong mỗi nhóm.','IMAGE_INVALID');
      if(input.fullPaidRequested&&(!retained.length&&!imageFiles.length))return operationFailure('Full Paid cần ảnh mẫu hoa.','FULL_PAID_EVIDENCE_REQUIRED');
      if(input.fullPaidRequested&&(!current.full_paid&&!billFiles.length))return operationFailure('Full Paid cần ảnh bill mới.','FULL_PAID_EVIDENCE_REQUIRED');
      if(input.fullPaidRequested&&input.order.shipping==='Shop book ship'&&!input.order.ship_confirmed)return operationFailure('Full Paid cần phí ship đã xác nhận.','FULL_PAID_EVIDENCE_REQUIRED');
      input.newImageUrls=await upload(imageFiles,'order-images');input.newBillUrls=await upload(billFiles,'settlement-bills');
      input.order.image_urls=[...new Set([...retained.map(u=>currentIds.get(privateImageIdentity(u))),...input.newImageUrls])];
    }else if(action==='saveShipFee'){
      try{input.shipFee=operationMoney(p.shipFee);}catch(e){return operationFailure(e.message,'SHIP_INVALID');}
    }else if(action==='submitSettlement'){
      if(Array.isArray(p.billUrls)&&p.billUrls.length)return operationFailure('Vui lòng tải ảnh bill lên từ thiết bị.','BILL_INVALID');
      if(!Array.isArray(p.billFiles)||!p.billFiles.length||p.billFiles.length>10)return operationFailure('Cần 1–10 ảnh bill.','BILL_REQUIRED');
      input.newBillUrls=await upload(p.billFiles,'settlement-bills');input.newSettlementId=newId('SET');input.note=clean(p.note);
    }else if(action==='reviewSettlement'){
      input.settlementId=clean(p.settlementId);input.decision=clean(p.decision).toUpperCase();input.reason=clean(p.reason);
    }else if(action==='updateStatus'){input.status=clean(p.status);}
    submitted=true;
    const result=await rpc('mee_ops_mutate',{...args,p_input:input});
    if(result?.ok===false)await discard(staged);
    else if(result?.idempotent){const used=new Set([...(result.row?.image_urls||[]),...(result.row?.full_paid_bill_urls||[])]);await discard(staged.filter(u=>!used.has(u)));}
    return result;
    }catch(e){
      // Once the SQL request is sent its result is unknown: retain evidence for receipt recovery.
      if(!submitted)await discard(staged);
      throw e;
    }
  }
  return {run};
}
