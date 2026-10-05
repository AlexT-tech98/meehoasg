/* Canonical owner: shipping fee and settlement submission business flow. */
(function(){
  'use strict';
  var ENDPOINT='https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-order-actions';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function attr(s){return esc(s).replace(/`/g,'&#96;')}
  function norm(v){return String(v==null?'':v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase().replace(/\s+/g,' ').trim()}
  function isShop(v){return /shop/i.test(String(v||''))}
  function moneyDigits(v){return Number(String(v||'').replace(/\D/g,''))||0}
  function money(v){return new Intl.NumberFormat('vi-VN').format(Number(v)||0)+'đ'}
  function orderById(id){
    if(!window.S)return null;
    if(S.orders&&typeof S.orders.get==='function'){var direct=S.orders.get(id);if(direct)return direct}
    var seen=new Set();
    function walk(v){if(!v||typeof v!=='object'||seen.has(v))return null;seen.add(v);if(v.id===id)return v;if(v instanceof Map){var d=v.get(id);if(d)return d;for(var mv of v.values()){var mr=walk(mv);if(mr)return mr}return null}if(Array.isArray(v)){for(var i=0;i<v.length;i++){var a=walk(v[i]);if(a)return a}}else{for(var k in v){if(k==='user'||k==='options')continue;var r=walk(v[k]);if(r)return r}}return null}
    return walk(S.data)||walk(S.cache)||walk(S.orders)||null;
  }
  function userIdentities(){
    if(!window.S||!S.user)return[];
    return [S.user.username,S.user.displayName,S.user.display_name,S.user.name].map(norm).filter(Boolean);
  }
  function ownsOrder(o){var sale=norm(o&&o.sale);return !!sale&&userIdentities().includes(sale)}
  function canEditShip(o){
    if(!window.S||!S.user)return false;
    if(['ADMIN','THO_OPS'].includes(S.user.role))return true;
    return S.user.role==='SALE'&&ownsOrder(o);
  }
  function idFromAction(el){
    if(!el)return'';var node=el.closest&&el.closest('[onclick*="openDrawer"],[onclick*="openOrderForm"],[onclick*="copyOrderById"],[onclick*="openShipFeeForm"]');
    if(!node)return'';var code=node.getAttribute('onclick')||'',m=code.match(/(?:openDrawer|openOrderForm|copyOrderById|openShipFeeForm)\(['"]([^'"]+)/);return m?m[1]:'';
  }
  function overlayOrderId(root){
    var nodes=qsa('[data-mee-copy-order-id],[onclick*="openDrawer"],[onclick*="openOrderForm"],[onclick*="copyOrderById"],[onclick*="openShipFeeForm"]',root||document);
    for(var i=0;i<nodes.length;i++){var direct=nodes[i].dataset&&nodes[i].dataset.meeCopyOrderId;if(direct)return direct;var id=idFromAction(nodes[i]);if(id)return id}
    return'';
  }
  async function call(action,payload){
    if(!window.S||!S.token)throw new Error('Phiên đăng nhập không hợp lệ.');
    var r=await fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:action,token:S.token},payload||{}))});
    var j=await r.json();if(!j.ok)throw new Error(j.message||'Không thực hiện được thao tác.');return j;
  }
  async function refresh(id,o){
    if(window.gas&&window.applyCanonicalOrder){var r=await gas('getOrder',{orderId:id,sourceSheet:o&&o.sourceSheet||'',sourceRow:o&&o.sourceRow||0});if(r&&r.ok&&r.order){applyCanonicalOrder(r.order,o);return r.order}}
    if(window.loadPage&&window.S&&S.page)await loadPage(S.page,true);
    return orderById(id);
  }
  function patchShipButtons(root){
    root=root||document;
    qsa('[onclick*="openShipFeeForm"]',root).forEach(function(btn){
      var code=btn.getAttribute('onclick')||'',m=code.match(/openShipFeeForm\(['"]([^'"]+)/),o=m?orderById(m[1]):null;
      if(!canEditShip(o))btn.remove();
    });
  }
  function patchProductionSelection(root){
    if(!window.S||S.page!=='production')return;
    qsa('input[type="checkbox"][onchange*="togglePick"]',root||document).forEach(function(cb){
      var code=cb.getAttribute('onchange')||'',m=code.match(/togglePick\(['"]([^'"]+)/),o=m?orderById(m[1]):null;
      if(o&&!o.canOperate){cb.checked=false;cb.disabled=true;cb.title='Đơn đã khóa hoặc tài khoản không có quyền thao tác';if(S.selected)S.selected.delete(o.id)}
    });
  }
  function patchCardFinance(root){
    root=root||document;
    qsa('.debt-breakdown',root).forEach(function(box){
      var id=idFromAction(box),o=orderById(id);if(!o||!o.card)return;var qty=Math.max(1,Number(o.cardQty)||1),fee=Number(o.cardFee)||qty*10000;
      var walker=document.createTreeWalker(box,NodeFilter.SHOW_TEXT),node;
      while((node=walker.nextNode()))if(/\+10\.000đ thiệp/.test(node.nodeValue||''))node.nodeValue=(node.nodeValue||'').replace(/\+10\.000đ thiệp/, '+'+money(fee)+' thiệp'+(qty>1?' (×'+qty+')':''));
    });
    var ov=root.id==='overlay'?root:qs('#overlay');if(!ov)return;var oid=overlayOrderId(ov),order=orderById(oid);if(!order||!order.card)return;
    var q=Math.max(1,Number(order.cardQty)||1),amount=Number(order.cardFee)||q*10000;
    qsa('span',ov).forEach(function(label){
      var text=(label.textContent||'').trim();if(text.indexOf('+ Thiệp')!==0)return;var row=label.parentElement,b=row&&qs('b',row);if(b)b.textContent=money(amount);if(q>1&&!/×\s*\d+/.test(text))label.textContent=text.replace(/^\+ Thiệp/,'+ Thiệp × '+q);
    });
  }
  function install(){
    if(!window.MEEOPS7)return false;
    MEEOPS7.openShipFeeForm=function(id){
      var o=orderById(id);
      if(!o||!canEditShip(o))return window.toast&&toast('Sale chỉ được nhập phí ship đơn của mình; Thợ/OPS và Admin được thao tác đơn vận hành.',1);
      if(!isShop(o.shipping))return window.toast&&toast('Đơn này không thể nhập phí ship.',1);
      if(o.locked)return window.toast&&toast('Đơn đang khóa, không thể đổi phí ship.',1);
      var ov=qs('#overlay');if(!ov)return;var val=o.shipConfirmed?new Intl.NumberFormat('vi-VN').format(o.shipFee):'';
      ov.innerHTML='<div class="modal-bg" onclick="if(event.target===this)MEEOPS7.closeOverlay()"><form action="javascript:void(0)" class="modal" style="max-width:460px" onsubmit="MEEOPS7.submitShipFee(event,\''+attr(o.id)+'\')"><div class="modal-head"><div><h3 style="margin:0">'+(o.shipConfirmed?'Cập nhật phí ship':'Nhập phí ship')+'</h3><div class="sub">'+esc(o.customer)+' · '+esc(o.shipping)+'</div></div><button type="button" class="close" onclick="MEEOPS7.closeOverlay()">×</button></div><label>PHÍ SHIP THỰC TẾ</label><input name="shipFee" inputmode="numeric" value="'+attr(val)+'" oninput="MEEOPS7.formatMoneyInput(this)" required autofocus><div class="notice">Sale phụ trách đơn này, Thợ/OPS hoặc Admin đều có thể xác nhận phí ship. Phí sẽ khóa khi gửi tất toán.</div><button class="btn primary full" style="margin-top:16px">Lưu phí ship</button></form></div>';
    };
    MEEOPS7.submitShipFee=async function(e,id){
      e.preventDefault();var o=orderById(id),f=e.target;if(!o||!f)return;
      try{var r=await call('saveShipFee',{orderId:id,shipFee:moneyDigits(f.shipFee.value)});if(window.orderMutationDirty)orderMutationDirty();await refresh(id,o);if(window.MEEOPS7&&MEEOPS7.closeOverlay)MEEOPS7.closeOverlay();if(window.toast)toast(r.message||'Đã cập nhật phí ship.')}catch(err){if(window.toast)toast(err.message||'Không cập nhật được phí ship.',1)}
    };
    MEEOPS7.settlementForm=function(id){
      var o=orderById(id);if(!o)return;var ov=qs('#overlay');if(!ov)return;var shop=isShop(o.shipping),ready=!shop||!!o.shipConfirmed;
      var shipBlock=shop?('<label>PHÍ SHIP THỰC TẾ</label><div class="mee-readonly-ship '+(ready?'':'missing')+'">'+(ready?money(o.shipFee):'CHƯA CÓ · nhập phí ship trước khi tất toán')+'</div>'):'';
      ov.innerHTML='<div class="modal-bg"><form action="javascript:void(0)" class="modal" id="settlementForm" onsubmit="MEEOPS7.submitSettlement(event,\''+attr(id)+'\')"><div class="modal-head"><div><h3 style="margin:0">Gửi yêu cầu tất toán</h3><div class="sub">'+esc(o.customer)+'</div></div><button type="button" class="close" onclick="MEEOPS7.closeOverlay()">×</button></div>'+(shop?'<div class="notice">Phí ship phải được xác nhận trước khi gửi tất toán. Sale phụ trách đơn có thể nhập ở phần phí ship của đơn.</div>':'')+shipBlock+'<label>ẢNH BILL / CHUYỂN KHOẢN</label><input id="billFiles" type="file" accept="image/*" multiple required><label>GHI CHÚ</label><textarea name="note"></textarea><button id="settlementSubmit" class="btn primary full" style="margin-top:16px" '+(ready?'':'disabled')+'>Gửi yêu cầu tất toán</button></form></div>';
    };
    MEEOPS7.submitSettlement=async function(e,id){
      e.preventDefault();var form=e.target,btn=qs('#settlementSubmit',form),o=orderById(id);if(!o||form.dataset.saving==='1')return;
      if(isShop(o.shipping)&&!o.shipConfirmed)return window.toast&&toast('Cần nhập phí ship trước khi gửi tất toán.',1);
      var files=[...((qs('#billFiles',form)||{}).files||[])];if(!files.length)return window.toast&&toast('Cần ít nhất một ảnh bill.',1);
      form.dataset.saving='1';if(btn){btn.disabled=true;btn.textContent='Đang gửi…'}
      try{
        var billFiles=await Promise.all(files.map(function(file){return new Promise(function(resolve,reject){var r=new FileReader();r.onload=function(){resolve({name:file.name,type:file.type,data:r.result})};r.onerror=function(){reject(new Error('Không đọc được ảnh bill.'))};r.readAsDataURL(file)})}));
        var r=await call('submitSettlement',{orderId:id,billFiles:billFiles,note:(qs('[name="note"]',form)||{}).value||''});
        if(window.orderMutationDirty)orderMutationDirty();await refresh(id,o);if(window.MEEOPS7&&MEEOPS7.closeOverlay)MEEOPS7.closeOverlay();if(window.toast)toast(r.message||'Đã gửi tất toán.');
      }catch(err){form.dataset.saving='0';if(btn){btn.disabled=false;btn.textContent='Gửi yêu cầu tất toán'}if(window.toast)toast(err.message||'Không gửi được tất toán.',1)}
    };
    var oldToggle=MEEOPS7.togglePick;
    MEEOPS7.togglePick=function(id,v){var o=orderById(id);if(v&&o&&!o.canOperate){if(window.toast)toast('Đơn đã khóa hoặc bạn không có quyền thao tác.',1);return}return oldToggle&&oldToggle.apply(this,arguments)};
    return true;
  }
  function patch(){install();patchShipButtons(qs('#overlay')||document);patchProductionSelection(qs('#content')||document);patchCardFinance(qs('#content')||document);patchCardFinance(qs('#overlay')||document)}
  function init(){patch();var content=qs('#content'),overlay=qs('#overlay');if(content)new MutationObserver(function(){setTimeout(patch,20)}).observe(content,{childList:true,subtree:true});if(overlay)new MutationObserver(function(){setTimeout(patch,0)}).observe(overlay,{childList:true,subtree:true});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
