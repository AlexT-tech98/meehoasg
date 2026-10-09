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

  function patchCreateButtons(){
    qsa('.topbar .actions button').forEach(function(b){var c=b.getAttribute('onclick')||'';if(c.indexOf('openOrderForm')>=0)b.dataset.meeHideCreateV365='1'});
    document.body.classList.toggle('mee-page-dashboard-v365',!!(window.S&&S.page==='dashboard'));
    if(window.S&&S.page==='dashboard')qsa('#content button').forEach(function(b){var c=b.getAttribute('onclick')||'';if(c.indexOf('openOrderForm')>=0)b.dataset.meeHideCreateV365='1'});
  }
  function patchBodyPage(){document.body.classList.toggle('mee-page-dashboard-v365',!!(window.S&&S.page==='dashboard'))}

  function buildCopyText(o){
    if(!o)return'';
    var q=Math.max(1,Number(o.cardQty||1)),accessory=[];
    if(o.card)accessory.push('Thiệp: '+(o.cardText||'')+' ('+vnd(q*10000)+')');
    if(o.banner)accessory.push('Banner: '+(o.bannerText||'')+' (35.000đ)');
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
  function patchCopyActions(){patchCreatedCopy();wrapCopy();bindCopyTargets()}
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
    if(!o||!(o.updatedAt||o.updated_at)){if(window.toast)window.toast('Tải lại chi tiết đơn trước khi xóa.',1);return;}
    btn._deletePayload=btn._deletePayload||{token:S.token,orderId:id,requestId:crypto.randomUUID(),expectedUpdatedAt:o.updatedAt||o.updated_at};
    var old=btn.textContent;btn.disabled=true;btn.textContent='Đang xóa…';
    try{
      var r=await fetch(DELETE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(btn._deletePayload)}),j=await r.json();
      if(!j.ok){if(j.code&&['ORDER_CONFLICT','VERSION_REQUIRED','ORDER_LOCKED','NOT_OWNER','NOT_FOUND','ORDER_DELETING'].indexOf(j.code)>=0)delete btn._deletePayload;throw new Error(j.message||'Không xóa được đơn.');}
      if(window.MEEOPS7&&MEEOPS7.closeOverlay)MEEOPS7.closeOverlay();
      if(window.toast)window.toast(j.message||'Đã gửi yêu cầu xóa.');
      if(window.loadPage&&S.page)window.loadPage(S.page,true);
    }catch(e){if(window.toast)window.toast(e.message||'Không xóa được đơn.',1);btn.disabled=false;btn.textContent=old}
  }
  function patchDelete(){
    if(!window.S||!S.user||S.user.role!=='ADMIN')return;
    var ov=qs('#overlay'),actions=ov&&qs('.order-actions',ov);if(!actions||qs('.mee-delete-order',actions))return;
    var id=drawerOrderId();if(!id)return;
    var b=document.createElement('button');b.type='button';b.className='btn danger full mee-delete-order';b.textContent='Xóa đơn';b.addEventListener('click',function(){requestDelete(id,b)});actions.appendChild(b);
  }

  function installReload(){
    if(qs('#meeReloadApp'))return;
    var host=qs('.side-user')||qs('.sidebar');if(!host)return;
    var b=document.createElement('button');b.id='meeReloadApp';b.type='button';b.className='btn secondary full mee-reload-app-v365';b.textContent='↻ Tải lại ứng dụng';
    b.onclick=function(){try{Object.keys(localStorage).filter(function(k){return k.indexOf('meehoa-shell-')===0}).forEach(function(k){localStorage.removeItem(k)})}catch(_){ }location.reload()};
    host.insertBefore(b,host.firstChild);
  }

  function patch(){patchBodyPage();patchCreateButtons();patchOrderForm();patchCopyActions();patchDelete();installReload()}
  function wrapOpenForm(){
    if(!window.MEEOPS7||!MEEOPS7.openOrderForm||MEEOPS7.openOrderForm._mee365)return;
    var orig=MEEOPS7.openOrderForm;
    var wrapped=function(id){var r=orig.apply(this,arguments);setTimeout(patchOrderForm,0);setTimeout(patchOrderForm,160);return r};wrapped._mee365=true;MEEOPS7.openOrderForm=wrapped;
  }
  function init(){
    wrapOpenForm();patch();
    if(!document.documentElement.dataset.meeCopyDelegate365){document.documentElement.dataset.meeCopyDelegate365='1';document.addEventListener('click',delegatedCopyTap,true)}
    var tries=0,bindTimer=setInterval(function(){wrapOpenForm();patchCopyActions();tries++;if((window.MEEOPS7&&MEEOPS7._meeCopy365)||tries>80)clearInterval(bindTimer)},50);
    var root=qs('#content');if(root)new MutationObserver(function(){setTimeout(patch,20)}).observe(root,{childList:true,subtree:true});
    var ov=qs('#overlay');if(ov)new MutationObserver(function(){setTimeout(function(){patchOrderForm();patchCopyActions();patchDelete()},0)}).observe(ov,{childList:true,subtree:true});
    document.addEventListener('visibilitychange',function(){if(!document.hidden)patch()});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
