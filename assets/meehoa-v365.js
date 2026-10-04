(function(){
  'use strict';
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
    function walk(v){if(!v||typeof v!=='object'||seen.has(v))return null;seen.add(v);if(v.id===id)return v;if(v instanceof Map){var direct=v.get(id);if(direct)return direct;for(var mv of v.values()){var mr=walk(mv);if(mr)return mr}return null}if(Array.isArray(v)){for(var i=0;i<v.length;i++){var r=walk(v[i]);if(r)return r}}else{for(var k in v){if(k==='user'||k==='options')continue;var r2=walk(v[k]);if(r2)return r2}}return null}
    return walk(S.data)||walk(S.cache)||null;
  }
  function replaceTextInput(input){
    if(!input||input.tagName!=='INPUT')return input;var t=(input.type||'text').toLowerCase();if(!['text','tel'].includes(t))return input;
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
    ['flowerTotal','depositAmount','charmFee','paperFee','vat'].forEach(function(name){var x=qs('[name="'+name+'"]',form);if(!x)return;x.type='text';x.inputMode='numeric';x.classList.add('mee-money-v365');x.removeAttribute('step');x.removeAttribute('min');if(x.value)x.value=money(x.value);if(!x.dataset.meeMoney365){x.dataset.meeMoney365='1';x.addEventListener('input',function(){if(window.MEEOPS7&&MEEOPS7.formatMoneyInput)MEEOPS7.formatMoneyInput(x);else x.value=money(x.value)})}})
  }
  function patchCardQty(form){
    var cb=qs('input[name="card"]',form);if(!cb)return;var label=cb.closest('label.check');if(!label)return;
    if(label.textContent.indexOf('10.000đ / thiệp')<0){Array.from(label.childNodes).forEach(function(n){if(n.nodeType===3&&/Thiệp/.test(n.nodeValue||''))n.nodeValue=' Thiệp · 10.000đ / thiệp'})}
    var box=qs('.mee-card-qty-v365',form);var id=parseId(form);var o=findOrderDeep(id)||{};
    if(!box){box=document.createElement('div');box.className='mee-card-qty-v365';box.innerHTML='<div><label>SỐ LƯỢNG THIỆP</label><div class="mee-card-price">10.000đ × số lượng</div></div><input type="number" name="cardQty" min="1" max="99" step="1" inputmode="numeric" value="1">';label.insertAdjacentElement('afterend',box)}
    var qty=qs('input[name="cardQty"]',box);if(!qty)return;
    if(!box.dataset.seeded){var initial=Number(o.cardQty||0);qty.value=String(cb.checked?Math.max(1,initial||1):0);box.dataset.seeded='1'}
    function sync(){box.style.display=cb.checked?'grid':'none';qty.disabled=!cb.checked;if(cb.checked&&Number(qty.value)<1)qty.value='1';if(!cb.checked)qty.value='0'}
    if(!cb.dataset.meeQty365){cb.dataset.meeQty365='1';cb.addEventListener('change',sync)}
    if(!qty.dataset.meeQtyInput365){qty.dataset.meeQtyInput365='1';qty.addEventListener('input',function(){var n=Math.max(1,Math.min(99,parseInt(qty.value||'1',10)||1));qty.value=String(n)})}
    sync();
  }
  function patchOrderForm(){var form=qs('#orderForm');if(!form)return;patchMultiline(form);patchMoney(form);patchCardQty(form)}
  function patchCreateButtons(){
    qsa('.topbar .actions button').forEach(function(b){var c=b.getAttribute('onclick')||'';if(c.indexOf('openOrderForm')>=0)b.dataset.meeHideCreateV365='1'});
    document.body.classList.toggle('mee-page-dashboard-v365',!!(window.S&&S.page==='dashboard'));
    if(window.S&&S.page==='dashboard')qsa('#content button').forEach(function(b){var c=b.getAttribute('onclick')||'';if(c.indexOf('openOrderForm')>=0)b.dataset.meeHideCreateV365='1'});
  }
  function patchBodyPage(){document.body.classList.toggle('mee-page-dashboard-v365',!!(window.S&&S.page==='dashboard'))}
  function buildCopyText(o){
    if(!o)return'';var q=Math.max(1,Number(o.cardQty||1));var accessory=[o.card?'Thiệp: '+(o.cardText||'')+' ('+vnd(q*10000)+')':'',o.banner?'Banner: '+(o.bannerText||'')+' (35.000đ)':'',Number(o.charmFee)?'Charm: '+(o.charmText||'')+' ('+vnd(o.charmFee)+')':'',Number(o.paperFee)?'Thay giấy: '+(o.paperText||'')+' ('+vnd(o.paperFee)+')':''].filter(Boolean);
    return ['THÔNG TIN ĐƠN HÀNG','Khách hàng: '+(o.customer||''),'SĐT: '+(o.phone||''),'Ngày nhận: '+dateVN(o.date)+(o.time?' · '+o.time:''),'Mẫu hoa: '+(o.flower||''),'Note: '+(o.note||'')].concat(accessory,['Vận chuyển: '+(o.shipping||''),'Địa chỉ: '+(o.address||''),'Tiền hoa: '+vnd(o.flowerTotal!==undefined?o.flowerTotal:o.total),'Thanh toán: '+(o.payment||'')]).filter(function(x){return !/: $/.test(x)}).join('\n');
  }
  function selectionCopy(value){
    var host=document.createElement('div');host.contentEditable='true';host.textContent=value;host.setAttribute('aria-hidden','true');
    host.style.position='fixed';host.style.left='0';host.style.top='0';host.style.width='1px';host.style.height='1px';host.style.overflow='hidden';host.style.opacity='0.01';host.style.fontSize='16px';host.style.userSelect='text';host.style.webkitUserSelect='text';host.style.zIndex='2147483647';
    document.body.appendChild(host);var ok=false,sel=window.getSelection&&window.getSelection();
    try{var range=document.createRange();range.selectNodeContents(host);if(sel){sel.removeAllRanges();sel.addRange(range)}ok=!!document.execCommand&&document.execCommand('copy')}catch(_){ok=false}
    try{if(sel)sel.removeAllRanges()}catch(_){ }host.remove();return ok;
  }
  function textareaCopy(value){
    var ta=document.createElement('textarea');ta.value=value;ta.style.position='fixed';ta.style.left='0';ta.style.top='0';ta.style.width='2px';ta.style.height='2px';ta.style.opacity='0.01';ta.style.fontSize='16px';ta.style.zIndex='2147483647';document.body.appendChild(ta);ta.focus();ta.select();try{ta.setSelectionRange(0,value.length)}catch(_){ }
    var ok=false;try{ok=!!document.execCommand&&document.execCommand('copy')}catch(_){ok=false}ta.remove();return ok;
  }
  function copyNow(value,label){
    value=String(value||'');if(!value)return Promise.resolve(false);
    function success(){if(window.toast)window.toast('Đã sao chép '+label);return true}
    function manual(){try{window.prompt('Sao chép thủ công nội dung bên dưới:',value)}catch(_){ }return false}
    if(selectionCopy(value)||textareaCopy(value))return Promise.resolve(success());
    if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){
      try{return navigator.clipboard.writeText(value).then(success).catch(manual)}catch(_){ }
    }
    return Promise.resolve(manual());
  }
  function copyOrder(id){var o=findOrderDeep(id);if(!o){if(window.toast)window.toast('Không tìm thấy dữ liệu đơn để sao chép.',1);return false}return copyNow(buildCopyText(o),'thông tin đơn hàng')}
  function copyField(id,field,label){var o=findOrderDeep(id);if(!o){if(window.toast)window.toast('Không tìm thấy dữ liệu đơn để sao chép.',1);return false}return copyNow(o[field]||'',label||field)}
  function wrapCopy(){
    if(!window.MEEOPS7)return;
    MEEOPS7.copyOrderById=copyOrder;
    MEEOPS7.copyOrderField=copyField;
    MEEOPS7._meeCopy365=true;
  }
  function patchCreatedCopy(){
    var btn=qs('#copyCreated'),ov=qs('#overlay');if(!btn||!ov)return;
    btn.dataset.meeCopyFixed365='1';
    btn.onclick=function(e){if(e){e.preventDefault();e.stopPropagation()}var pre=qs('pre',ov);var text=pre?pre.textContent||pre.innerText||'':'';return copyNow(text,'thông tin đơn hàng')};
  }
  function patchCopyActions(){patchCreatedCopy();wrapCopy()}
  function delegatedCopyTap(e){
    var target=e.target&&e.target.closest?e.target.closest('#copyCreated,[onclick*="copyOrderById"],[onclick*="copyOrderField"]'):null;if(!target)return;
    if(target.id==='copyCreated'){e.preventDefault();e.stopImmediatePropagation();var pre=qs('#overlay pre');return copyNow(pre?pre.textContent||pre.innerText||'':'','thông tin đơn hàng')}
    var code=target.getAttribute('onclick')||'',m=code.match(/copyOrderById\(['"]([^'"]+)['"]\)/);if(m){e.preventDefault();e.stopImmediatePropagation();return copyOrder(m[1])}
    var f=code.match(/copyOrderField\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]*)['"])?\)/);if(f){e.preventDefault();e.stopImmediatePropagation();return copyField(f[1],f[2],f[3]||f[2])}
  }
  function installReload(){
    if(qs('#meeReloadApp'))return;var host=qs('.side-user')||qs('.sidebar');if(!host)return;var b=document.createElement('button');b.id='meeReloadApp';b.type='button';b.className='btn secondary full mee-reload-app-v365';b.textContent='↻ Tải lại ứng dụng';b.onclick=function(){try{Object.keys(localStorage).filter(function(k){return k.indexOf('meehoa-shell-')===0}).forEach(function(k){localStorage.removeItem(k)})}catch(_){ }location.reload()};host.insertBefore(b,host.firstChild);
  }
  function patch(){patchBodyPage();patchCreateButtons();patchOrderForm();patchCopyActions();installReload()}
  function wrapOpenForm(){
    if(!window.MEEOPS7||!MEEOPS7.openOrderForm||MEEOPS7.openOrderForm._mee365)return;
    var orig=MEEOPS7.openOrderForm;
    var wrapped=function(id){var r=orig.apply(this,arguments);setTimeout(patchOrderForm,0);setTimeout(patchOrderForm,160);return r};wrapped._mee365=true;MEEOPS7.openOrderForm=wrapped;
  }
  function init(){wrapOpenForm();patch();if(!document.documentElement.dataset.meeCopyDelegate365){document.documentElement.dataset.meeCopyDelegate365='1';document.addEventListener('click',delegatedCopyTap,true)}var tries=0;var bindTimer=setInterval(function(){patchCopyActions();tries++;if((window.MEEOPS7&&MEEOPS7._meeCopy365)||tries>40)clearInterval(bindTimer)},50);var root=qs('#content');if(root)new MutationObserver(function(){setTimeout(patch,20)}).observe(root,{childList:true,subtree:true});var ov=qs('#overlay');if(ov)new MutationObserver(function(){setTimeout(function(){patchOrderForm();patchCopyActions()},0)}).observe(ov,{childList:true,subtree:true});document.addEventListener('visibilitychange',function(){if(!document.hidden)patch()})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
