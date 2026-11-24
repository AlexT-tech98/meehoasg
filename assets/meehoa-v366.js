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
    ta.value=input.value||'';ta.dataset.meeMultiline='1';ta.rows=1;input.replaceWith(ta);return ta;
  }
  function patchMultiline(form){
    qsa('[maxlength]',form).forEach(function(x){x.removeAttribute('maxlength')});
    ['customer','phone','address','cardText','bannerText','charmText','paperText'].forEach(function(name){var x=qs('[name="'+name+'"]',form);if(x&&x.tagName==='INPUT')replaceTextInput(x)});
    qsa('textarea',form).forEach(function(x){x.removeAttribute('maxlength');x.style.maxHeight='none'});
    if(window.MEE_AUTOGROW&&window.MEE_AUTOGROW.bind)window.MEE_AUTOGROW.bind(form);
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
    if(String(o.tagNoteFree||'').trim())out.push('Tag note free: '+o.tagNoteFree);
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
  function invoiceQr(due){return 'https://img.vietqr.io/image/'+invoiceBank.bin+'-'+invoiceBank.account+'-compact2.svg?amount='+encodeURIComponent(due)+'&accountName='+encodeURIComponent(invoiceBank.name)}
  function invoiceData(o){var total=Number(o.totalDue)||Number(o.flowerTotal||0)+Number(o.accessoryTotal||0)+Number(o.vat||0)+(o.shipFeePending?0:Number(o.shipFee||0));return {o:o,total:total,due:Math.max(0,Number(o.debt)||0),qr:invoiceQr(Math.max(0,Number(o.debt)||0))}}
  function invoiceStyles(){
    if(qs('#meeInvoiceStyles'))return;
    var style=document.createElement('style');style.id='meeInvoiceStyles';style.textContent='#meeInvoicePreview{position:fixed;inset:0;z-index:1500;background:#12283ba8;display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px;overflow:auto;overscroll-behavior:contain}#meeInvoicePreview .mee-invoice-toolbar{width:min(100%,390px);display:flex;gap:8px;flex-wrap:wrap;justify-content:center}#meeInvoicePreview .mee-invoice-toolbar button{border:0;border-radius:9px;padding:10px 12px;font:600 13px Arial,sans-serif;cursor:pointer;background:#fff;color:#164c72}#meeInvoicePreview .mee-invoice-toolbar button.primary{background:#164c72;color:#fff}#meeInvoicePreview .mee-invoice-card{width:min(100%,390px);min-height:0;aspect-ratio:3/4;background:#fff;color:#17324a;box-shadow:0 12px 38px #07131b35;border-radius:10px;padding:16px;display:flex;flex-direction:column;font:13px/1.35 Arial,sans-serif}#meeInvoicePreview .mee-invoice-brand{font-size:22px;font-weight:800;letter-spacing:.08em;color:#164c72}#meeInvoicePreview .mee-invoice-title{font-size:11px;letter-spacing:.08em;color:#687b89;border-bottom:2px solid #164c72;padding-bottom:9px;margin-bottom:12px}#meeInvoicePreview .mee-invoice-top{display:flex;justify-content:space-between;gap:10px}#meeInvoicePreview .mee-invoice-name{font-size:17px;font-weight:700}#meeInvoicePreview .mee-invoice-muted{color:#687b89;font-size:11px}#meeInvoicePreview .mee-invoice-flower{margin:5px 0;min-height:25px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}#meeInvoicePreview .mee-invoice-line{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid #e5ebef}#meeInvoicePreview .mee-invoice-line b{text-align:right}#meeInvoicePreview .mee-invoice-due{font-size:16px;color:#164c72;font-weight:700}#meeInvoicePreview .mee-invoice-qr{text-align:center;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:120px}#meeInvoicePreview .mee-invoice-qr img{display:block;width:min(40%,140px);max-height:165px;object-fit:contain}#meeInvoicePreview .mee-invoice-bank{text-align:center;font-size:12px;font-weight:700}#meeInvoicePreview .mee-invoice-note{text-align:center;font-size:11px;margin:4px 0 2px}#meeInvoicePreview .mee-invoice-thanks{text-align:center;font-size:12px;font-weight:700;color:#164c72}@media print{@page{size:90mm 120mm;margin:0}body>*:not(#meeInvoicePreview){display:none!important}#meeInvoicePreview{position:static;display:block;background:#fff;padding:0;overflow:visible}#meeInvoicePreview .mee-invoice-toolbar{display:none!important}#meeInvoicePreview .mee-invoice-card{width:90mm;height:120mm;min-height:0;aspect-ratio:auto;box-shadow:none;border-radius:0;padding:6mm;break-inside:avoid}}';document.head.appendChild(style);
  }
  function invoiceCanvas(data){
    var canvas=document.createElement('canvas');canvas.width=900;canvas.height=1200;var c=canvas.getContext('2d');
    c.fillStyle='#fff';c.fillRect(0,0,900,1200);c.textBaseline='top';
    function label(t,x,y,size,bold,color){c.font=(bold?'bold ':'')+size+'px Arial,sans-serif';c.fillStyle=color||'#17324a';c.fillText(String(t||''),x,y)}
    function right(t,y,size,bold,color){c.font=(bold?'bold ':'')+size+'px Arial,sans-serif';c.fillStyle=color||'#17324a';c.fillText(String(t||''),830-c.measureText(String(t||'')).width,y)}
    function fit(t,max){t=String(t||'');while(c.measureText(t).width>max&&t.length>1)t=t.slice(0,-2);return t===String(arguments[0]||'')?t:t+'…'}
    function row(k,v,y,strong){label(k,70,y,strong?32:26,strong);right(v,y,strong?32:26,true,strong?'#164c72':'#17324a');c.strokeStyle='#e5ebef';c.beginPath();c.moveTo(70,y+43);c.lineTo(830,y+43);c.stroke()}
    label('MEEHOA',70,55,58,true,'#164c72');right('PHIẾU XÁC NHẬN ĐƠN HÀNG',83,20,false,'#687b89');c.fillStyle='#164c72';c.fillRect(70,135,760,4);
    label(fit(data.o.customer||'Khách hàng',700),70,165,37,true);label('Mã đơn: '+(data.o.id||''),70,222,23,false,'#687b89');right(dateVN(data.o.date),222,23,false,'#687b89');
    c.font='26px Arial,sans-serif';label(fit(data.o.flower||'Hoa theo đơn',760),70,275,26,false);
    row('Tổng đơn',vnd(data.total),340,false);row('Đã thanh toán',vnd(data.o.paid),400,false);row('Còn thanh toán',vnd(data.due),475,true);
    return {canvas:canvas,ctx:c,label:label,right:right};
  }
  function invoiceDownload(data,share){
    var image=new Image();image.crossOrigin='anonymous';image.onload=function(){
      try{var art=invoiceCanvas(data),c=art.ctx;
        if(data.due){c.drawImage(image,325,555,250,295);art.label(invoiceBank.name,70,885,28,true);art.right(invoiceBank.label+' · '+invoiceBank.account,885,26,true)}
        else art.label('Đơn hàng đã thanh toán đủ',70,715,32,true,'#164c72');
        art.label('Thanh toán xong quý khách vui lòng gửi ảnh bill',70,1020,23,false);art.label('để tiệm xác nhận giao dịch.',70,1050,23,false);art.label('Meehoa xin cảm ơn Quý khách 💕',70,1110,27,true,'#164c72');
        art.canvas.toBlob(function(blob){if(!blob){if(window.toast)toast('Không tạo được ảnh hóa đơn.',1);return}var filename='Meehoa-'+String(data.o.id||'hoa-don').replace(/[^a-zA-Z0-9-]/g,'')+'.png';if(share&&navigator.share&&navigator.canShare){var file=new File([blob],filename,{type:'image/png'});if(navigator.canShare({files:[file]})){navigator.share({files:[file],title:'Hóa đơn Meehoa'}).catch(function(){});return}}var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url)},60000)},'image/png');
      }catch(e){if(window.toast)toast('Không tạo được ảnh hóa đơn. Hãy thử In / Lưu PDF.',1)}
    };image.onerror=function(){if(window.toast)toast('Không tải được mã QR. Vui lòng kiểm tra mạng.',1)};image.src=data.qr;
  }
  function closeInvoice(){var layer=qs('#meeInvoicePreview');if(layer)layer.remove();document.body.style.overflow=''}
  function printInvoice(id){
    var o=findOrderDeep(id);if(!o){if(window.toast)toast('Không tìm thấy đơn hàng.',1);return}
    closeInvoice();invoiceStyles();var data=invoiceData(o),layer=document.createElement('div');layer.id='meeInvoicePreview';layer.setAttribute('role','dialog');layer.setAttribute('aria-label','Hóa đơn Meehoa');
    layer.innerHTML='<div class="mee-invoice-toolbar"><button type="button" data-invoice-close>← Về đơn hàng</button><button type="button" class="primary" data-invoice-download>Tải ảnh</button><button type="button" data-invoice-share>Chia sẻ</button><button type="button" data-invoice-print>In / Lưu PDF</button></div><div class="mee-invoice-card"><div class="mee-invoice-brand">MEEHOA</div><div class="mee-invoice-title">PHIẾU XÁC NHẬN ĐƠN HÀNG</div><div class="mee-invoice-top"><div class="mee-invoice-name">'+invoiceEsc(o.customer||'Khách hàng')+'</div><div class="mee-invoice-muted">'+invoiceEsc(dateVN(o.date))+'</div></div><div class="mee-invoice-muted">Mã đơn: '+invoiceEsc(o.id)+'</div><div class="mee-invoice-flower">'+invoiceEsc(o.flower||'Hoa theo đơn')+'</div><div class="mee-invoice-line"><span>Tổng đơn</span><b>'+invoiceEsc(vnd(data.total))+'</b></div><div class="mee-invoice-line"><span>Đã thanh toán</span><b>'+invoiceEsc(vnd(o.paid))+'</b></div><div class="mee-invoice-line mee-invoice-due"><span>Còn thanh toán</span><b>'+invoiceEsc(vnd(data.due))+'</b></div>'+(data.due?'<div class="mee-invoice-qr"><img crossorigin="anonymous" src="'+invoiceEsc(data.qr)+'" alt="Mã QR chuyển khoản VIB"></div><div class="mee-invoice-bank">'+invoiceEsc(invoiceBank.name)+' · '+invoiceEsc(invoiceBank.label)+' '+invoiceEsc(invoiceBank.account)+'</div>':'<div class="mee-invoice-qr">Đơn hàng đã thanh toán đủ.</div>')+'<div class="mee-invoice-note">Thanh toán xong quý khách vui lòng gửi ảnh bill<br>để tiệm xác nhận giao dịch.</div><div class="mee-invoice-thanks">Meehoa xin cảm ơn Quý khách 💕</div></div>';
    document.body.appendChild(layer);document.body.style.overflow='hidden';qs('[data-invoice-close]',layer).onclick=closeInvoice;qs('[data-invoice-download]',layer).onclick=function(){invoiceDownload(data,false)};qs('[data-invoice-share]',layer).onclick=function(){invoiceDownload(data,true)};qs('[data-invoice-print]',layer).onclick=function(){window.print()};layer.addEventListener('click',function(e){if(e.target===layer)closeInvoice()});
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
    var drawer=qs('[data-mee-order-id]',ov);if(drawer&&drawer.dataset.meeOrderId)return drawer.dataset.meeOrderId;
    var bound=qs('[data-mee-copy-order-id]',ov);if(bound)return bound.dataset.meeCopyOrderId||'';
    var copy=qs('[onclick*="copyOrderById"]',ov);if(copy){var m=(copy.getAttribute('onclick')||'').match(/copyOrderById\(['"]([^'"]+)/);if(m)return m[1]}
    var field=qs('[onclick*="copyOrderField"]',ov);if(field){var f=(field.getAttribute('onclick')||'').match(/copyOrderField\(['"]([^'"]+)/);if(f)return f[1]}
    return'';
  }
  async function executeSoftDelete(o,reasonCode,reason,btn){
    var reqId=(typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():('del-'+Date.now());
    var old=btn?btn.textContent:'';
    if(btn){btn.disabled=true;btn.textContent='Đang xóa…';}
    try{
      var j;
      if(typeof window.gas==='function'){
        j=await window.gas('deleteOrder',{orderId:o.id,expectedUpdatedAt:o.updatedAt||'',reason:reason,reasonCode:reasonCode,requestId:reqId});
      }else{
        var r=await fetch(DELETE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:S.token,orderId:o.id,expectedUpdatedAt:o.updatedAt||'',reason:reason,reasonCode:reasonCode,requestId:reqId})});
        j=await r.json();
      }
      if(!j||!j.ok)throw new Error((j&&j.message)||'Không xóa được đơn.');
      if(window.S&&S.orders&&typeof S.orders.delete==='function')S.orders.delete(o.id);
      if(window.S&&S.dirty){['getOrders','getProductionOrders','getDashboardSummary','getDebtReview','getKpi','getFlowerInventory'].forEach(function(k){S.dirty.add(k)});}
      if(window.MEEOPS7&&MEEOPS7.closeOverlay)MEEOPS7.closeOverlay();
      if(window.toast)window.toast(j.message||'Đã chuyển đơn vào Thùng rác.');
      if(window.loadPage&&S.page)window.loadPage(S.page,true);
      return true;
    }catch(e){
      if(window.toast)window.toast((e&&e.message)||'Không xóa được đơn.',1);
      if(btn){btn.disabled=false;btn.textContent=old;}
      throw e;
    }
  }
  async function requestDelete(id,btn){
    if(!id||!window.S||!S.token)return;
    var o=findOrderDeep(id);
    if(!o){if(window.toast)window.toast('Không tìm thấy đơn hàng.',1);return;}
    if(o.canDelete===false){if(window.toast)window.toast('Đơn hàng không thể xóa (không đủ quyền hoặc đã khóa tài chính).',1);return;}
    if(window.MEE_UI_V3&&typeof window.MEE_UI_V3.openDeleteDialog==='function'){
      window.MEE_UI_V3.openDeleteDialog(o,function(payload){
        return executeSoftDelete(o,payload.reasonCode,payload.reason,btn);
      });
      return;
    }
    if(window.toast)window.toast('Không thể mở hộp thoại xác nhận xóa.',1);
  }
  function patch(){patchOrderForm();patchCopyActions()}
  function init(){
    window.MEE_ORDER_FORM_ENHANCE=patchOrderForm;
    window.MEE_COPY_ACTIONS_SYNC=patchCopyActions;
    window.MEE_CLOSE_INVOICE=closeInvoice;
    window.MEE_PRINT_INVOICE=printInvoice;
    window.MEE_FIND_ORDER=findOrderDeep;
    patch();
    if(!document.documentElement.dataset.meeDeleteDelegateV2){document.documentElement.dataset.meeDeleteDelegateV2='1';document.addEventListener('click',function(event){var button=event.target.closest&&event.target.closest('[data-mee-delete-order]');if(!button)return;if(!window.S||!S.user||!['ADMIN','SALE','THO_OPS'].includes(S.user.role))return;event.preventDefault();requestDelete(button.dataset.meeDeleteOrder,button);});}
    if(!document.documentElement.dataset.meeCopyDelegate365){document.documentElement.dataset.meeCopyDelegate365='1';document.addEventListener('click',delegatedEditTap,true);document.addEventListener('click',delegatedCopyTap,true)}
    if(window.MEEOPS7)wrapCopy();
    // Drawer, creation confirmation and order form invoke their canonical render hooks directly.
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
