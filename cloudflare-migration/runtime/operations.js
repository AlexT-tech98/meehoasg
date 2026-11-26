import { BASE_ORDER_VALIDATION_RULES, validateOrderRulesServer } from './order-rules.js';
const clean=v=>String(v??'').trim();
const amount=v=>Number(v)||0;
const validMoney=v=>(typeof v==='number'||typeof v==='string')&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=999999999999;
const validDate=v=>{const s=clean(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return !Number.isNaN(d.valueOf())&&d.toISOString().slice(0,10)===s};
const timestampMicros=v=>{const s=clean(v),ms=Date.parse(s);if(!Number.isFinite(ms))return null;const f=s.match(/\.(\d{1,6})/);return BigInt(ms)*1000n+BigInt((f?.[1]||'').padEnd(6,'0').slice(3,6)||'0')};
const fail=(code,message)=>({ok:false,code,message});
const nowAfter=old=>{const time=Math.max(Date.now(),(Date.parse(old)||0)+1);return new Date(time).toISOString()};
const row=x=>x?JSON.parse(x.data):null;
async function get(db,table,key){return row(await db.prepare(`SELECT data FROM ${table} WHERE row_key=?`).bind(key).first())}
async function find(db,table,column,value){return row(await db.prepare(`SELECT data FROM ${table} WHERE json_extract(data,'$.${column}')=? LIMIT 1`).bind(value).first())}
async function many(db,table,column,value){const r=await db.prepare(`SELECT data FROM ${table} WHERE json_extract(data,'$.${column}')=?`).bind(value).all();return r.results.map(row)}
function put(db,table,key,value,existing=false,version){
  if(existing&&version)return db.prepare(`UPDATE ${table} SET data=CASE WHEN json_extract(data,'$.updated_at')=? THEN ? ELSE json('MEEHOA_STALE_VERSION') END WHERE row_key=?`).bind(version,JSON.stringify(value),key);
  if(existing)return db.prepare(`UPDATE ${table} SET data=? WHERE row_key=?`).bind(JSON.stringify(value),key);
  return db.prepare(`INSERT INTO ${table}(row_key,data) VALUES(?,?)`).bind(key,JSON.stringify(value));
}
function audit(db,user,id,action,before,after){const value={occurred_at:new Date().toISOString(),username:user.username,display_name:user.display_name,role:user.role,order_id:id||null,action,before_data:before||null,after_data:after||null};return db.prepare("WITH next(id) AS (SELECT coalesce(max(cast(row_key AS integer)),0)+1 FROM activity_log) INSERT INTO activity_log(row_key,data) SELECT cast(id AS text),json_set(?,'$.id',id) FROM next").bind(JSON.stringify(value))}
function owner(order,user){return [clean(user.username).toLowerCase(),clean(user.display_name).toLowerCase()].includes(clean(order.sale).toLowerCase())}
function total(order){const card=order.card?Math.max(1,Math.floor(amount(order.card_qty)||1))*10000:0;return amount(order.flower_total)+card+(order.banner?35000:0)+amount(order.charm_fee)+amount(order.paper_fee)+amount(order.vat)+(clean(order.shipping).toLowerCase().includes('shop')&&order.ship_confirmed?amount(order.ship_fee):0)}
function receipt(db,args,result){const value={actor:args.p_actor,request_id:args.p_request_id,action:args.p_action,fingerprint:args.p_fingerprint,result,created_at:new Date().toISOString()};return put(db,'operation_receipts',`${args.p_actor}:${args.p_request_id}`,value)}
async function lookup(db,args){const user=await get(db,'app_users',args.p_actor);if(!user?.active)return fail('AUTH_REQUIRED','Tài khoản đã bị khóa.');const r=await db.prepare("SELECT data FROM operation_receipts WHERE json_extract(data,'$.actor')=? AND json_extract(data,'$.request_id')=? LIMIT 1").bind(args.p_actor,args.p_request_id).first();const old=row(r);if(!old)return null;if(old.action!==args.p_action||old.fingerprint!==args.p_fingerprint)return fail('REQUEST_CHANGED','Nội dung đã thay đổi sau lần gửi trước. Kiểm tra kết quả trước khi gửi yêu cầu mới.');return old.result||{idempotent:true}}
export function createOperationRpc(db){return async function rpc(name,args){
  if(name==='mee_ops_lookup')return lookup(db,args);
  if(name!=='mee_ops_mutate')throw Error('Unknown operation');
  const user=await get(db,'app_users',args.p_actor);if(!user?.active)return fail('AUTH_REQUIRED','Tài khoản đã bị khóa.');
  if(!args.p_request_id||args.p_request_id.length>128||args.p_fingerprint?.length!==64)return fail('REQUEST_ID_REQUIRED','Thiếu mã yêu cầu hợp lệ.');
  const prior=await lookup(db,args);if(prior)return prior;
  const action=args.p_action,input=args.p_input||{};
  if(!['createOrder','updateOrder','saveShipFee','submitSettlement','reviewSettlement','updateStatus','deleteOrder'].includes(action))return fail('ACTION_INVALID','Thao tác không được hỗ trợ.');
  if(action==='deleteOrder'&&user.role!=='ADMIN')return fail('NOT_OWNER','Chỉ Admin được xóa đơn.');
  let request=null,id=clean(input.orderId);
  if(action==='reviewSettlement'){if(user.role!=='ADMIN')return fail('NOT_OWNER','Không có quyền duyệt tất toán.');request=await get(db,'settlement_requests',clean(input.settlementId));if(!request)return fail('NOT_FOUND','Không tìm thấy yêu cầu.');id=request.order_id}
  const before=action==='createOrder'?null:await get(db,'orders',id);
  if(action!=='createOrder'&&!before)return fail('NOT_FOUND','Không tìm thấy đơn.');
  if(before?.delete_after_sheet_sync){if(action==='deleteOrder')return{ok:true,idempotent:true,orderId:id,message:'Đơn đã được xếp hàng xóa, đang chờ Sheet xác nhận.'};return fail('ORDER_DELETING','Đơn đang chờ xóa; không thể sửa hoặc tất toán.')}
  if(before&&['updateOrder','saveShipFee','submitSettlement'].includes(action)&&user.role==='SALE'&&!owner(before,user))return fail('NOT_OWNER','Sale chỉ được cập nhật đơn do mình phụ trách.');
  const settlements=before?await many(db,'settlement_requests','order_id',id):[];
  if(before&&['updateOrder','saveShipFee','updateStatus','deleteOrder'].includes(action)&&(before.settled||settlements.some(x=>['PENDING','APPROVED'].includes(x.status))))return fail('ORDER_LOCKED','Đơn đã khóa bởi yêu cầu tất toán.');
  const versioned=['updateOrder','saveShipFee','updateStatus','submitSettlement','deleteOrder'].includes(action);
  if(versioned){const expected=timestampMicros(input.expectedUpdatedAt),current=timestampMicros(before.updated_at);if(expected===null)return fail('VERSION_REQUIRED','Tải lại chi tiết đơn trước khi lưu.');if(current!==expected)return fail('ORDER_CONFLICT','Đơn vừa được người khác cập nhật. Tải lại chi tiết để đối chiếu trước khi lưu.')}
  const now=nowAfter(before?.updated_at),statements=[];let next,result;
  if(action==='createOrder'||action==='updateOrder'){
    const data=input.order||{};
    if(!clean(data.customer)||!clean(data.flower)||!validDate(data.order_date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(data.order_time))||!['Shop book ship','Khách tự book','Ghé lấy'].includes(data.shipping)||
      !['flower_total','charm_fee','paper_fee','vat','ship_fee'].every(k=>validMoney(data[k]))||
      typeof data.card!=='boolean'||typeof data.banner!=='boolean'||typeof data.ship_confirmed!=='boolean'||
      (data.card&&(!Number.isInteger(Number(data.card_qty))||Number(data.card_qty)<1||Number(data.card_qty)>99||!clean(data.card_text)))||
      (data.banner&&!clean(data.banner_text)))return fail('ORDER_INPUT_INVALID','Thông tin đơn, thời gian hoặc số tiền không hợp lệ.');
    try{validateOrderRulesServer(data,input.orderRules||BASE_ORDER_VALIDATION_RULES);}catch(e){return fail(e.code||'ORDER_INPUT_INVALID',e.message);}
    // Match production SQL: normalize whitespace and prefer exact username over display name.
    const saleName=clean(user.role==='SALE'?user.username:data.sale);
    const sale=(await db.prepare("SELECT data FROM app_users WHERE json_extract(data,'$.active')=1 AND (lower(trim(json_extract(data,'$.username')))=lower(trim(?)) OR lower(trim(json_extract(data,'$.display_name')))=lower(trim(?))) ORDER BY (lower(trim(json_extract(data,'$.username')))=lower(trim(?))) DESC LIMIT 1").bind(saleName,saleName,saleName).first())?.data;
    if(!sale)return fail('SALE_REQUIRED','Cần chọn người phụ trách hợp lệ.');
    const canonical=JSON.parse(sale).username;
    if(action==='createOrder'){
      if(await find(db,'orders','request_id',args.p_request_id))return fail('LEGACY_REQUEST_EXISTS','Mã yêu cầu đã có đơn từ phiên bản trước. Kiểm tra danh sách đơn trước khi tạo tiếp.');
      id=clean(input.newOrderId);if(!id)return fail('ORDER_INPUT_INVALID','Thiếu mã đơn.');
    }
    const images=data.image_urls??[],newBills=input.newBillUrls??[],newUnverifiedBills=input.newUnverifiedBillUrls??[];
    if(!Array.isArray(images)||!Array.isArray(newBills)||!Array.isArray(newUnverifiedBills)||!Array.isArray(before?.full_paid_bill_urls??[]))return fail('IMAGE_INVALID','Danh sách ảnh không hợp lệ.');
    const bills=[...(before?.full_paid_bill_urls||[]),...newBills];
    const unverifiedBills=newUnverifiedBills.length?[...(before?.unverified_bill_urls||[]),...newUnverifiedBills]:(before?.unverified_bill_urls||[]);
    if(action==='updateOrder'&&images.some(x=>!(before.image_urls||[]).includes(x)&&!(input.newImageUrls||[]).includes(x)))return fail('IMAGE_INVALID','Ảnh không thuộc đơn này.');
    const defaults={source_sheet:null,source_row:null,settled:false,status:'Chờ bó',created_at:now,
      sync_hash:null,synced_at:null,needs_sheet_sync:false,sheet_synced_at:null,delete_after_sheet_sync:false,
      delete_requested_by:null,delete_requested_at:null,full_paid:false,full_paid_total:0,
      full_paid_bill_urls:[],unverified_bill_urls:[],full_paid_by:null,full_paid_at:null,full_paid_invalidated_at:null,
      full_paid_invalidated_reason:''};
    next={...defaults,...(before||{}),id,request_id:before?.request_id||args.p_request_id,
      customer:data.customer,phone:data.phone??'',order_date:data.order_date,order_time:data.order_time,
      flower:data.flower,note:data.note??'',shipping:data.shipping,address:data.address??'',
      flower_total:Number(data.flower_total),payment:data.payment??'',sale:canonical,
      card:data.card,card_qty:data.card?Number(data.card_qty):0,card_text:data.card_text??'',
      banner:data.banner,banner_text:data.banner_text??'',charm_fee:Number(data.charm_fee),
      charm_text:data.charm_text??'',paper_fee:Number(data.paper_fee),paper_text:data.paper_text??'',
      vat:Number(data.vat),image_urls:images,unverified_bill_urls:unverifiedBills,ship_fee:data.shipping==='Shop book ship'?Number(data.ship_fee):0,
      ship_confirmed:data.shipping==='Shop book ship'?data.ship_confirmed:false,
      ship_fee_updated_by:user.username,ship_fee_updated_role:user.role,ship_fee_updated_at:now,
      full_paid:false,updated_at:now};
    const newTotal=total(next);let full=!!input.fullPaidRequested;
    if(full&&(!images.length||!bills.length||(next.shipping==='Shop book ship'&&!next.ship_confirmed)))return fail('FULL_PAID_EVIDENCE_REQUIRED','Full Paid cần ảnh mẫu, bill và phí ship đã xác nhận.');
    if(full&&before&&!before.full_paid&&!(input.newBillUrls||[]).length)return fail('FULL_PAID_EVIDENCE_REQUIRED','Bật Full Paid cần ảnh bill mới.');
    if(full&&before?.full_paid&&newTotal>amount(before.full_paid_total)&&!(input.newBillUrls||[]).length){full=false;next.payment=`Đã thanh toán ${before.full_paid_total} đ`}
    next.full_paid=full;
    if(full){next.full_paid_total=before?.full_paid&&!(input.newBillUrls||[]).length?before.full_paid_total:newTotal;next.full_paid_bill_urls=bills;next.full_paid_by=user.username;next.full_paid_at=now;next.full_paid_invalidated_at=null;next.full_paid_invalidated_reason='';next.payment='Đã thanh toán toàn bộ đơn'}
    else if(before?.full_paid){next.full_paid_invalidated_at=now;next.full_paid_invalidated_reason=newTotal>amount(before.full_paid_total)?'ORDER_TOTAL_INCREASED':'PAYMENT_STATUS_CHANGED'}
    result={ok:true,orderId:id,row:next,fullPaidApplied:full,imageRetentionApplied:true,fullPaidInvalidated:!!before?.full_paid&&!full,message:before?.full_paid&&!full&&newTotal>amount(before.full_paid_total)?'Đã lưu. Tổng đơn tăng, Full Paid được gỡ và giữ nguyên số tiền đã thu.':action==='createOrder'?'Đã tạo đơn.':'Đã lưu thay đổi.'};
  }else if(action==='saveShipFee'){
    if(!['ADMIN','THO_OPS','SALE'].includes(user.role)||!clean(before.shipping).toLowerCase().includes('shop'))return fail('SHIP_INVALID','Chỉ nhập phí ship cho đơn Shop book ship.');
    if(!validMoney(input.shipFee))return fail('SHIP_INVALID','Phí ship không hợp lệ.');
    next={...before,ship_fee:amount(input.shipFee),ship_confirmed:true,ship_fee_updated_by:user.username,ship_fee_updated_role:user.role,ship_fee_updated_at:now,updated_at:now};
    result={ok:true,orderId:id,row:next,shipFee:next.ship_fee,shipConfirmed:true,message:'Đã cập nhật phí ship.'};
  }else if(action==='updateStatus'){
    if(!['ADMIN','THO_OPS'].includes(user.role))return fail('NOT_OWNER','Không có quyền cập nhật sản xuất.');
    const statuses=['Chờ bó','Đã bó','Đã giao'];if(Math.abs(statuses.indexOf(input.status)-statuses.indexOf(before.status))!==1||!statuses.includes(input.status))return fail('STATUS_INVALID','Chỉ được chuyển trạng thái từng bước.');
    next={...before,status:input.status,updated_at:now};result={ok:true,orderId:id,row:next,status:input.status};
  }else if(action==='submitSettlement'){
    if(!['ADMIN','SALE'].includes(user.role)||before.settled||before.full_paid||before.status!=='Đã giao')return fail('SETTLEMENT_INVALID','Đơn chưa thể gửi tất toán hoặc bạn không có quyền.');
    if(settlements.some(x=>['PENDING','APPROVED'].includes(x.status)))return fail('SETTLEMENT_EXISTS','Đơn đã có yêu cầu tất toán.');
    if(clean(before.shipping).toLowerCase().includes('shop')&&!before.ship_confirmed)return fail('SHIP_FEE_REQUIRED','Cần nhập phí ship thực tế trước khi gửi tất toán.');
    const bills=input.newBillUrls;if(!Array.isArray(bills)||!bills.length)return fail('BILL_REQUIRED','Cần ít nhất một ảnh bill.');
    if(!clean(input.newSettlementId))return fail('SETTLEMENT_INVALID','Thiếu mã yêu cầu tất toán.');
    const grand=total(before),ship=clean(before.shipping).toLowerCase().includes('shop')?amount(before.ship_fee):0;
    request={id:input.newSettlementId,order_id:id,sale_username:user.username,sale_name:user.display_name,flower_total:before.flower_total,accessory_total:grand-amount(before.flower_total)-amount(before.vat)-ship,vat:before.vat,ship_fee:ship,required_amount:grand,bill_urls:bills,note:input.note||'',status:'PENDING',submitted_at:now,rejection_reason:''};
    statements.push(put(db,'settlement_requests',request.id,request));next={...before,updated_at:now};result={ok:true,orderId:id,row:next,requestId:request.id,requiredAmount:grand,settlementStatus:'PENDING',message:'Đã gửi tất toán.'};
  }else if(action==='reviewSettlement'){
    if(!['APPROVED','REJECTED'].includes(input.decision))return fail('DECISION_INVALID','Quyết định không hợp lệ.');
    if(request.status===input.decision){next=input.decision==='APPROVED'&&!before.settled?{...before,settled:true,updated_at:now}:before;result={ok:true,idempotent:true,orderId:id,row:next,processedRequests:0,message:'Yêu cầu đã được xử lý.'}}
    else if(request.status!=='PENDING')return fail('REVIEW_CONFLICT','Yêu cầu đã được xử lý với kết quả khác.');
    else{let count=0;for(const req of settlements.filter(x=>x.status==='PENDING')){count++;statements.push(put(db,'settlement_requests',req.id,{...req,status:input.decision,admin_username:user.username,admin_name:user.display_name,reviewed_at:now,rejection_reason:input.reason||''},true))}next={...before,settled:input.decision==='APPROVED'?true:before.settled,updated_at:now};result={ok:true,orderId:id,row:next,processedRequests:count,message:input.decision==='APPROVED'?'Đã duyệt tất toán.':'Đã trả đơn cho Sale chỉnh sửa.'}}
  }else if(action==='deleteOrder'){
    next={...before,customer:'[ĐÃ XÓA] '+clean(before.customer).replace(/^\[ĐÃ XÓA\]\s*/,''),flower:'[ĐÃ XÓA] '+clean(before.flower).replace(/^\[ĐÃ XÓA\]\s*/,''),note:[clean(before.note),`[ĐÃ XÓA TRÊN OPS] ${user.display_name||user.username} · ${now}`].filter(Boolean).join('\n'),delete_after_sheet_sync:true,delete_requested_by:user.username,delete_requested_at:now,needs_sheet_sync:true,updated_at:now};
    result={ok:true,orderId:id,row:next,message:'Đã gửi yêu cầu xóa. Đơn sẽ được gỡ khỏi OPS sau khi Sheet nhận dấu xóa.'};
  }
  // Review has no client-supplied version by design. Still serialize it against
  // concurrent order edits/reviews using the version read at the start of RPC.
  statements.push(put(db,'orders',id,next,!!before,(versioned||action==='reviewSettlement')?before?.updated_at:undefined));
  statements.push(audit(db,user,id,action,before,next));
  statements.push(receipt(db,args,result));
  try{await db.batch(statements)}catch(error){
    const replay=await lookup(db,args);if(replay)return replay;
    if(before){const latest=await get(db,'orders',id);if(latest&&latest.updated_at!==before.updated_at)return fail('ORDER_CONFLICT','Đơn vừa được người khác cập nhật. Tải lại chi tiết để đối chiếu trước khi lưu.')}
    throw error;
  }
  return result;
}}
