(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

  function patchPayment(){
    if(!window.S||S.page!=='payment'){
      document.body.classList.remove('mee-page-settlement-v364');
      return;
    }
    var root=qs('#content');if(!root)return;
    document.body.classList.add('mee-page-settlement-v364');
    var grid=qs('.order-grid',root);if(!grid)return;
    var cards=qsa('.settlement-card',grid);if(!cards.length)return;
    grid.classList.add('mee-settlement-grid-v364');

    var checks=qsa('.settle-check',grid).filter(function(x){return !x.disabled});
    var bar=qs('.mee-settlement-selectbar-v364',root);
    if(!bar&&checks.length){
      bar=document.createElement('div');
      bar.className='mee-settlement-selectbar-v364';
      bar.innerHTML='<label><input type="checkbox" id="mee-settlement-select-all-v364"><span>Chọn tất cả</span></label><span data-mee-selected-v364>0 đã chọn</span>';
      grid.parentNode.insertBefore(bar,grid);
    }
    if(bar){
      var master=qs('#mee-settlement-select-all-v364',bar);
      var sync=function(){
        var current=qsa('.settle-check',grid).filter(function(x){return !x.disabled});
        var n=current.filter(function(x){return x.checked}).length;
        var count=qs('[data-mee-selected-v364]',bar);if(count)count.textContent=n+' đã chọn';
        if(master){master.checked=current.length>0&&n===current.length;master.indeterminate=n>0&&n<current.length}
      };
      if(master&&!master.dataset.bound){master.dataset.bound='1';master.addEventListener('change',function(){qsa('.settle-check',grid).filter(function(x){return !x.disabled}).forEach(function(x){x.checked=master.checked;x.dispatchEvent(new Event('change',{bubbles:true}))});sync()})}
      checks.forEach(function(x){if(!x.dataset.v364){x.dataset.v364='1';x.addEventListener('change',sync)}});sync();
    }

    qsa('.settlement-card .thumbs img',grid).forEach(function(img){
      if(img.dataset.v364)return;img.dataset.v364='1';img.loading='lazy';
      var a=img.closest('a');if(a)a.addEventListener('click',function(e){e.preventDefault();openProof(img.src)});
    });
  }

  function openProof(src){
    var ov=qs('#overlay');if(!ov)return;
    ov.innerHTML='<div class="modal-bg mee-proof-lightbox-v364"><div class="mee-proof-view-v364"><button class="close" type="button" onclick="MEEOPS7.closeOverlay()">×</button><img src="'+esc(src)+'" alt="Chứng minh thanh toán"></div></div>';
  }

  function patchPaidCopy(){
    if(!window.S||!['production','orders'].includes(S.page))return;
    var root=qs('#content');if(!root)return;
    qsa('.ops-tile,.order:not(.settlement-card),.order-card-mobile',root).forEach(function(card){
      var walker=document.createTreeWalker(card,NodeFilter.SHOW_TEXT);var n;
      while((n=walker.nextNode()))if(String(n.nodeValue||'').trim()==='Đã tất toán')n.nodeValue='Bankful full hoa';
    });
  }

  function patchMaterialsLabel(){
    if(!window.S||S.page!=='flowers')return;
    var d=S.filters&&S.filters.flowers&&S.filters.flowers.date;
    var r=d&&S.data&&S.data.flowers&&S.data.flowers[d];
    var root=qs('#content');if(!r||!root)return;
    if(r.aiStatus==='FALLBACK_NO_KEY'){
      qsa('.mee-ai-error',root).forEach(function(x){x.remove()});
      var hero=qs('.mee-materials-hero',root);if(hero&&!qs('.mee-local-fallback-note',root)){
        var note=document.createElement('div');note.className='mee-local-fallback-note';note.innerHTML='<b>Đang dùng phân loại local tạm thời</b><span>Gemini API key chưa được cấu hình trên Supabase. Kết quả hiện tại vẫn gom theo loại hoa từ nội dung đơn, nhưng chưa phải AI Gemini.</span>';
        hero.insertAdjacentElement('afterend',note);
      }
    }
  }

  function patch(){patchPayment();patchPaidCopy();patchMaterialsLabel()}
  var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(patch,45)}
  function init(){patch();var root=qs('#content');if(root)new MutationObserver(schedule).observe(root,{childList:true,subtree:true,characterData:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
