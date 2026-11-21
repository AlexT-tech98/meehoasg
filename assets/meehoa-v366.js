/* Canonical latest ops runtime: order ergonomics, copy and delete flow. Dashboard hourly tracking is owned by v361. */
(function(){
  'use strict';
  var DELETE_URL='https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-delete-order';

  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function money(v){var d=String(v==null?'':v).replace(/\D/g,'');return d?new Intl.NumberFormat('vi-VN').format(Number(d)):''}
  function vnd(v){return new Intl.NumberFormat('vi-VN').format(Number(v||0))+'đ'}
  function dateVN(v){var s=String(v||'');var m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?m[3]+'/'+m[2]+'/'+m[1]:s}
  function parseId(form){var s=form&&form.getAttribute('onsubmit')||'';var m=s.match(/saveOrder\(event,'([^']*)'/);return m?m[1]:''}

  function findOrderDeep(id){
    if(!id||!window.S)return null;
    if(S.orders&&typeof S.orders.get==='function'){var remembered=S.orders.get(id);if(remembered)return remembered}
    var seen=new Set();
    function walk(v){
      if(!v||typeof v!=='object'||seen.has(v))return null;
      seen.add(v);
      if(v.id===id)return v;
      if(v instanceof Map){
        var direct=v.get(id);if(direct)return direct;
        for(var mv of v.values()){var mr=walk(mv);if(mr)return mr}
        return null;
      }
      if(Array.isArray(v)){
        for(var i=0;i<v.length;i++){var r=walk(v[i]);if(r)return r}
      }else{
        for(var k in v){if(k==='user'||k==='options')continue;var r2=walk(v[k]);if(r2)return r2}
      }
      return null;
    }
    return walk(S.data)||walk(S.cache)||walk(S.orders)||null;
  }

  function replaceTextInput(input){
    if(!input||input.tagName!=='INPUT')return input;
    var t=(input.type||'text').toLowerCase();
    if(!['text','tel'].includes(t))return input;
    var ta=document.createElement('textarea');
    Array.from(input.attributes).forEach(function(a){if(!['type','value'].includes(a.name))ta.setAttribute(a.name,a.value)});
    ta.value=input.value||'';ta.dataset.meeMultiline='1';ta.rows=2;input.replaceWith(ta);return ta;
  }
  function patchMultiline(form){
    qsa('[maxlength]',form).forEach(function(x){x.removeAttribute('maxlength')});
    ['customer','phone','address','cardText','bannerText','charmText','paperText'].forEach(function(name){var x=qs('[name="'+name+'"]',form);if(x&&x.tagName==='INPUT')replaceTextInput(x)});
    qsa('textarea',form).forEach(function(x){x.removeAttribute('maxlength');x.style.maxHeight='none'});
  }
  function patchMoney(form){
    ['flowerTotal','depositAmount','charmFee','paperFee','vat','shipFee'].forEach(function(name){
      var x=qs('[name="'+name+'"]',form);if(!x)return;
      x.type='text';x.inputMode='numeric';x.classList.add('mee-money-v365');x.removeAttribute('step');x.removeAttribute('min');
      if(x.value)x.value=money(x.value);
      if(!x.dataset.meeMoney365){x.dataset.meeMoney365='1';x.addEventListener('input',function(){if(window.MEEOPS7&&MEEOPS7.formatMoneyInput)MEEOPS7.formatMoneyInput(x);else x.value=money(x.value)})}
    })
  }
  function patchOrderForm(){var form=qs('#orderForm');if(!form)return;patchMultiline(form);patchMoney(form)}

  function buildCopyText(o){
    if(!o)return'';
    var q=Math.max(1,Number(o.cardQty||1)),accessory=[];
    if(o.card)accessory.push('Thiệp: '+(o.cardText||'')+' ('+vnd(q*10000)+')');
    if(o.banner){var bq=Math.max(1,Number(o.bannerQty||1));accessory.push('Banner ×'+bq+': '+(o.bannerText||'')+' ('+vnd(bq*35000)+')');}
    if(Number(o.charmFee))accessory.push('Charm: '+(o.charmText||'')+' ('+vnd(o.charmFee)+')');
    if(Number(o.paperFee))accessory.push('Thay giấy: '+(o.paperText||'')+' ('+vnd(o.paperFee)+')');
    var out=[
      'THÔNG TIN ĐƠN HÀNG',
      'Khách hàng: '+(o.customer||''),
      'SĐT: '+(o.phone||''),
      'Nhận: '+dateVN(o.date)+(o.time?' · '+o.time:''),
      '',
      'MẪU HOA',
      o.flower||''
    ];
    if(String(o.note||'').trim())out.push('Note: '+o.note);
    if(accessory.length)out=out.concat(['','PHỤ KIỆN']).concat(accessory);
    out=out.concat([
      '',
      'GIAO NHẬN',
      o.shipping||'',
      o.address?'Địa chỉ: '+o.address:'',
      '',
      'THANH TOÁN',
      'Tiền hoa: '+vnd(o.flowerTotal!==undefined?o.flowerTotal:o.total),
      'Thanh toán: '+(o.payment||'')
    ]);
    return out.filter(function(x,i,a){return x!==''||a[i-1]!==''}).join('\n').trim();
  }

  function textareaCopy(value){
    var ta=document.createElement('textarea');
    ta.value=value;ta.setAttribute('readonly','');
    ta.style.position='fixed';ta.style.left='0';ta.style.top='0';ta.style.width='2px';ta.style.height='2px';ta.style.opacity='0.01';ta.style.fontSize='16px';ta.style.zIndex='2147483647';
    document.body.appendChild(ta);ta.focus();ta.select();
    try{ta.setSelectionRange(0,value.length)}catch(_){ }
    var ok=false;try{ok=!!document.execCommand&&document.execCommand('copy')}catch(_){ok=false}
    ta.remove();return ok;
  }
  function copyNow(value,label){
    value=String(value||'');
    if(!value){if(window.toast)window.toast('Không có '+label+' để sao chép.',1);return Promise.resolve(false)}
    function success(){if(window.toast)window.toast('Đã sao chép '+label);return true}
    function manual(){try{window.prompt('Sao chép thủ công nội dung bên dưới:',value)}catch(_){ }return false}
    if(textareaCopy(value))return Promise.resolve(success());
    if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){
      try{return navigator.clipboard.writeText(value).then(success).catch(manual)}catch(_){ }
    }
    return Promise.resolve(manual());
  }
  function copyOrder(id){var o=findOrderDeep(id);if(!o){if(window.toast)window.toast('Không tìm thấy dữ liệu đơn để sao chép.',1);return false}return copyNow(buildCopyText(o),'thông tin đơn hàng')}
  function copyField(id,field,label){var o=findOrderDeep(id);if(!o){if(window.toast)window.toast('Không tìm thấy dữ liệu đơn để sao chép.',1);return false}return copyNow(o[field]||'',label||field)}
  var invoiceBank={bin:'970441',account:'941233979',name:'TẠ VŨ GIA KHANH',label:'VIB'};
  function invoiceEsc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function invoiceLine(k,v){return '<div class="line"><span>'+invoiceEsc(k)+'</span><b>'+invoiceEsc(v)+'</b></div>'}
  function printInvoice(id){
    var o=findOrderDeep(id);if(!o){if(window.toast)toast('Không tìm thấy đơn hàng.',1);return}
    var due=Math.max(0,Number(o.debt)||0),total=Number(o.totalDue)||Number(o.flowerTotal||0)+Number(o.accessoryTotal||0)+Number(o.vat||0)+(o.shipFeePending?0:Number(o.shipFee||0));
    var lines=invoiceLine('Hoa',vnd(o.flowerTotal));
    if(o.card)lines+=invoiceLine('Thiệp × '+Math.max(1,Number(o.cardQty||1)),vnd(o.cardFee||Math.max(1,Number(o.cardQty||1))*10000));
    if(o.banner)lines+=invoiceLine('Banner × '+Math.max(1,Number(o.bannerQty||1)),vnd(Math.max(1,Number(o.bannerQty||1))*35000));
    if(Number(o.charmFee))lines+=invoiceLine('Charm',vnd(o.charmFee));
    if(Number(o.paperFee))lines+=invoiceLine('Giấy gói',vnd(o.paperFee));
    if(Number(o.vat))lines+=invoiceLine('VAT',vnd(o.vat));
    if(o.shipFeePending)lines+=invoiceLine('Phí giao hàng','Chưa xác nhận');else if(Number(o.shipFee))lines+=invoiceLine('Phí giao hàng',vnd(o.shipFee));
    var transfer='MEEHOA '+String(o.id||'').replace(/[^a-zA-Z0-9]/g,'').slice(-24);
    var qr='https://img.vietqr.io/image/'+invoiceBank.bin+'-'+invoiceBank.account+'-compact2.png?amount='+encodeURIComponent(due)+'&addInfo='+encodeURIComponent(transfer)+'&accountName='+encodeURIComponent(invoiceBank.name);
    var w=window.open('','_blank');if(!w){if(window.toast)toast('Hãy cho phép cửa sổ bật lên để in hóa đơn.',1);return}
    var css='@page{size:A4;margin:16mm}*{box-sizing:border-box}body{font:14px/1.5 Arial,sans-serif;color:#17324a;margin:0;background:#f3f6f8}.sheet{max-width:760px;margin:24px auto;background:#fff;padding:40px;box-shadow:0 8px 30px #17324a18}.head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #164c72;padding-bottom:18px}.brand{font-size:25px;font-weight:800;letter-spacing:.08em;color:#164c72}.muted{color:#687b89}.title{font-size:22px;font-weight:700;margin:28px 0 4px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 28px;margin:20px 0 28px}.section{font-weight:700;color:#164c72;margin:24px 0 8px}.line{display:flex;justify-content:space-between;gap:20px;padding:9px 0;border-bottom:1px solid #e5ebef}.line b{text-align:right}.total{font-size:18px;border-top:2px solid #164c72;margin-top:8px}.pay{display:flex;gap:24px;align-items:center;margin-top:26px;padding:18px;border:1px solid #d8e4ec;border-radius:12px}.pay img{width:190px;height:190px;object-fit:contain}.foot{margin-top:30px;text-align:center;color:#687b89}.toolbar{text-align:center;margin:20px}.toolbar button{border:0;background:#164c72;color:#fff;border-radius:8px;padding:12px 24px;font-weight:bold;cursor:pointer}@media print{body{background:#fff}.sheet{margin:0;padding:0;box-shadow:none}.toolbar{display:none}}';
    var html='<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hóa đơn '+invoiceEsc(o.id)+'</title><style>'+css+'</style></head><body><div class="toolbar"><button onclick="window.print()">In / Lưu PDF</button></div><main class="sheet"><div class="head"><div class="brand">MEEHOA</div><div class="muted">PHIẾU XÁC NHẬN ĐƠN HÀNG</div></div><div class="title">Thông tin đơn hàng</div><div class="muted">Mã đơn: '+invoiceEsc(o.id)+'</div><div class="grid"><div><b>Khách hàng</b><br>'+invoiceEsc(o.customer||'—')+'</div><div><b>Ngày nhận</b><br>'+invoiceEsc(dateVN(o.date))+' '+invoiceEsc(o.time||'')+'</div><div><b>Hình thức giao</b><br>'+invoiceEsc(o.shipping||'—')+'</div><div><b>Địa chỉ nhận</b><br>'+invoiceEsc(o.address||'Nhận tại cửa hàng')+'</div></div><div class="section">SẢN PHẨM</div><div>'+invoiceEsc(o.flower||'Hoa theo đơn').replace(/\n/g,'<br>')+'</div><div class="section">CHI TIẾT THANH TOÁN</div>'+lines+invoiceLine('Tổng đơn',vnd(total))+invoiceLine('Đã thanh toán',vnd(o.paid))+'<div class="line total"><span>Còn thanh toán</span><b>'+invoiceEsc(vnd(due))+'</b></div>'+(due?'<div class="pay"><img src="'+invoiceEsc(qr)+'" alt="Mã QR chuyển khoản"><div><b>Quét mã để chuyển khoản</b><br>'+invoiceEsc(invoiceBank.name)+'<br>'+invoiceEsc(invoiceBank.account)+' · '+invoiceBank.label+'<br><span class="muted">Số tiền: '+invoiceEsc(vnd(due))+'<br>Nội dung: '+invoiceEsc(transfer)+'</span></div></div>':'<p class="muted">Đơn hàng đã thanh toán đủ.</p>')+'<div class="foot">Cảm ơn quý khách đã chọn Meehoa.</div></main></body></html>';
    w.document.open();w.document.write(html);w.document.close();
  }
  function patchInvoiceButton(){var ov=qs('#overlay'),id=drawerOrderId();if(!ov||!id||qs('[data-mee-print-invoice]',ov))return;var actions=qs('.order-actions',ov);if(!actions)return;var btn=document.createElement('button');btn.type='button';btn.className='btn secondary';btn.textContent='▣ In hóa đơn + QR';btn.dataset.meePrintInvoice=id;btn.addEventListener('click',function(){printInvoice(id)});actions.appendChild(btn)}
  function wrapCopy(){if(!window.MEEOPS7)return;MEEOPS7.copyOrderById=copyOrder;MEEOPS7.copyOrderField=copyField;MEEOPS7._meeCopy365=true}
  function patchCreatedCopy(){
    var btn=qs('#copyCreated'),ov=qs('#overlay');if(!btn||!ov)return;
    btn.dataset.meeCopyFixed365='1';
    btn.removeAttribute('onclick');
    btn.onclick=function(e){if(e){e.preventDefault();e.stopPropagation()}var pre=qs('pre',ov);var text=pre?pre.textContent||pre.innerText||'':'';return copyNow(text,'thông tin đơn hàng')};
  }
  function bindCopyTargets(){
    var ov=qs('#overlay');if(!ov)return;
    qsa('[onclick*="copyOrderById"]',ov).forEach(function(el){
      if(el.dataset.meeCopyBound365==='1')return;
      var code=el.getAttribute('onclick')||'',m=code.match(/copyOrderById\(['"]([^'"]+)['"]\)/);if(!m)return;
      el.dataset.meeCopyBound365='1';el.dataset.meeCopyOrderId=m[1];el.removeAttribute('onclick');el.style.cursor='pointer';
      el.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();copyOrder(m[1])});
    });
    qsa('[onclick*="copyOrderField"]',ov).forEach(function(el){
      if(el.dataset.meeCopyBound365==='1')return;
      var code=el.getAttribute('onclick')||'',m=code.match(/copyOrderField\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]*)['"])?\)/);if(!m)return;
      el.dataset.meeCopyBound365='1';el.dataset.meeCopyOrderId=m[1];el.removeAttribute('onclick');el.setAttribute('role','button');el.setAttribute('tabindex','0');el.style.cursor='pointer';
      var run=function(e){if(e){e.preventDefault();e.stopPropagation()}copyField(m[1],m[2],m[3]||m[2])};
      el.addEventListener('click',run);el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' ')run(e)});
    });
  }
  function patchCopyActions(){patchCreatedCopy();wrapCopy();bindCopyTargets();patchInvoiceButton()}
  // An edit tap has one owner. Consume it before any copy handlers can run.
  function delegatedEditTap(e){
    var edit=e.target&&e.target.closest?e.target.closest('#overlay [data-mee-order-action="edit"]'):null;
    if(!edit||!window.MEEOPS7||typeof MEEOPS7.openOrderForm!=='function')return;
    var code=edit.getAttribute('onclick')||'',match=code.match(/openOrderForm\(['"]([^'"]+)['"]\)/);
    if(!match)return;
    e.preventDefault();e.stopImmediatePropagation();
    MEEOPS7.openOrderForm(match[1]);
  }
  function delegatedCopyTap(e){
    var target=e.target&&e.target.closest?e.target.closest('#copyCreated,[onclick*="copyOrderById"],[onclick*="copyOrderField"]'):null;if(!target)return;
    if(target.id==='copyCreated'){e.preventDefault();e.stopImmediatePropagation();var pre=qs('#overlay pre');return copyNow(pre?pre.textContent||pre.innerText||'':'','thông tin đơn hàng')}
    var code=target.getAttribute('onclick')||'',m=code.match(/copyOrderById\(['"]([^'"]+)['"]\)/);if(m){e.preventDefault();e.stopImmediatePropagation();return copyOrder(m[1])}
    var f=code.match(/copyOrderField\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]*)['"])?\)/);if(f){e.preventDefault();e.stopImmediatePropagation();return copyField(f[1],f[2],f[3]||f[2])}
  }

  function drawerOrderId(){
    var ov=qs('#overlay');if(!ov)return'';
    var bound=qs('[data-mee-copy-order-id]',ov);if(bound)return bound.dataset.meeCopyOrderId||'';
    var copy=qs('[onclick*="copyOrderById"]',ov);if(copy){var m=(copy.getAttribute('onclick')||'').match(/copyOrderById\(['"]([^'"]+)/);if(m)return m[1]}
    var field=qs('[onclick*="copyOrderField"]',ov);if(field){var f=(field.getAttribute('onclick')||'').match(/copyOrderField\(['"]([^'"]+)/);if(f)return f[1]}
    return'';
  }
  async function requestDelete(id,btn){
    if(!id||!window.S||!S.token)return;
    var o=findOrderDeep(id),name=o&&o.customer?o.customer:id;
    if(!window.confirm('Xóa đơn của '+name+'?\n\nĐơn sẽ được đánh dấu xóa trên Sheet trước, sau đó gỡ khỏi hệ thống.'))return;
    var old=btn.textContent;btn.disabled=true;btn.textContent='Đang xóa…';
    try{
      var r=await fetch(DELETE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:S.token,orderId:id})}),j=await r.json();
      if(!j.ok)throw new Error(j.message||'Không xóa được đơn.');
      if(window.MEEOPS7&&MEEOPS7.closeOverlay)MEEOPS7.closeOverlay();
      if(window.toast)window.toast(j.message||'Đã gửi yêu cầu xóa.');
      if(window.loadPage&&S.page)window.loadPage(S.page,true);
    }catch(e){if(window.toast)window.toast(e.message||'Không xóa được đơn.',1);btn.disabled=false;btn.textContent=old}
  }
  function patch(){patchOrderForm();patchCopyActions()}
  function init(){
    window.MEE_ORDER_FORM_ENHANCE=patchOrderForm;
    window.MEE_COPY_ACTIONS_SYNC=patchCopyActions;
    patch();
    if(!document.documentElement.dataset.meeDeleteDelegateV2){document.documentElement.dataset.meeDeleteDelegateV2='1';document.addEventListener('click',function(event){var button=event.target.closest&&event.target.closest('[data-mee-delete-order]');if(!button)return;if(!window.S||!S.user||S.user.role!=='ADMIN')return;event.preventDefault();requestDelete(button.dataset.meeDeleteOrder,button);});}
    if(!document.documentElement.dataset.meeCopyDelegate365){document.documentElement.dataset.meeCopyDelegate365='1';document.addEventListener('click',delegatedEditTap,true);document.addEventListener('click',delegatedCopyTap,true)}
    if(window.MEEOPS7)wrapCopy();
    // Drawer, creation confirmation and order form invoke their canonical render hooks directly.
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
