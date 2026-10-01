(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}

  function patchPaidCopy(){
    var root=qs('#content');
    if(!root)return;
    var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    var node;
    while((node=walker.nextNode())){
      if(String(node.nodeValue||'').trim()==='Đã tất toán') node.nodeValue='Bankful full hoa';
    }
  }

  function ensureSettlementSelectAll(){
    if(!window.S||S.page!=='settlement')return;
    var root=qs('#content');
    if(!root)return;
    var checks=qsa('.settle input[type="checkbox"]',root).filter(function(x){return !x.disabled});
    if(!checks.length)return;

    var bar=qs('.mee-settlement-selectbar',root);
    if(!bar){
      bar=document.createElement('div');
      bar.className='mee-settlement-selectbar mee-v363-selectbar';
      bar.innerHTML='<label class="mee-select-all-label"><input type="checkbox" id="mee-settlement-select-all"> <span>Chọn tất cả</span></label><span class="mee-selected-count" data-mee-selected-count>0 đã chọn</span>';
      var anchor=qs('.mee-settlement-grid',root)||checks[0].closest('.settle');
      if(anchor&&anchor.parentNode) anchor.parentNode.insertBefore(bar,anchor);
    }

    var master=qs('#mee-settlement-select-all',bar);
    var sync=function(){
      var current=qsa('.settle input[type="checkbox"]',root).filter(function(x){return !x.disabled});
      var selected=current.filter(function(x){return x.checked}).length;
      var countEl=qs('[data-mee-selected-count]',bar);
      if(countEl)countEl.textContent=selected+' đã chọn';
      if(master){
        master.checked=current.length>0&&selected===current.length;
        master.indeterminate=selected>0&&selected<current.length;
      }
    };
    if(master&&!master.dataset.meeV363){
      master.dataset.meeV363='1';
      master.addEventListener('change',function(){
        qsa('.settle input[type="checkbox"]',root).filter(function(x){return !x.disabled}).forEach(function(x){
          x.checked=master.checked;
          x.dispatchEvent(new Event('change',{bubbles:true}));
        });
        sync();
      });
    }
    checks.forEach(function(x){
      if(x.dataset.meeV363)return;
      x.dataset.meeV363='1';
      x.addEventListener('change',sync);
    });
    sync();
  }

  function patch(){
    patchPaidCopy();
    ensureSettlementSelectAll();
  }
  var timer=null;
  function schedule(){clearTimeout(timer);timer=setTimeout(patch,50)}
  function init(){
    patch();
    var root=qs('#content');
    if(root)new MutationObserver(schedule).observe(root,{childList:true,subtree:true,characterData:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
