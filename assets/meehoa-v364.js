(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]})}
  function fileKey(f){return [f&&f.name||'',f&&f.size||0,f&&f.lastModified||0].join('|')}
  var proofPreviousHtml='';

  function coreClose(){
    if(window.MEEOPS7&&typeof MEEOPS7.closeOverlay==='function')MEEOPS7.closeOverlay();
    else if(typeof window.closeOverlay==='function')window.closeOverlay();
    var ov=qs('#overlay');if(ov){ov.innerHTML='';ov.onpaste=null}
    proofPreviousHtml='';
    document.body.classList.remove('mee-overlay-open-v364');
  }

  function closeActiveOverlay(){
    var ov=qs('#overlay');
    if(ov&&qs('.mee-proof-lightbox-v364',ov)&&proofPreviousHtml){
      ov.innerHTML=proofPreviousHtml;
      proofPreviousHtml='';
      schedule();
      return;
    }
    coreClose();
  }
  window.MEEV364CloseOverlay=closeActiveOverlay;

  function ensureOverlayControls(){
    var ov=qs('#overlay');if(!ov)return;
    var active=!!ov.firstElementChild;
    document.body.classList.toggle('mee-overlay-open-v364',active);
    if(!active)return;
    if(!qs('.mee-overlay-global-close-v364',ov)){
      var b=document.createElement('button');
      b.type='button';b.className='mee-overlay-global-close-v364';b.setAttribute('aria-label','Đóng');b.textContent='×';
      b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();closeActiveOverlay()});
      ov.appendChild(b);
    }
    var panel=qs('.modal,.drawer,.mobile-menu-sheet,.calendar-modal',ov);
    if(panel&&!panel.dataset.meeScrollInit){panel.dataset.meeScrollInit='1';panel.scrollTop=0}
  }

  function openProof(src){
    var ov=qs('#overlay');if(!ov)return;
    if(!qs('.mee-proof-lightbox-v364',ov))proofPreviousHtml=ov.innerHTML;
    ov.innerHTML='<div class="modal-bg mee-proof-lightbox-v364"><div class="mee-proof-view-v364"><button class="close" type="button" onclick="window.MEEV364CloseOverlay()">×</button><img src="'+esc(src)+'" alt="Xem ảnh"></div></div>';
    ensureOverlayControls();
  }

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
  }

  function rebuildFileInput(input,state){
    if(typeof DataTransfer==='undefined')return;
    var dt=new DataTransfer();state.newFiles.forEach(function(f){try{dt.items.add(f)}catch(_){}});input.files=dt.files;
  }

  function previewForFile(file,state){
    var key=fileKey(file);state.objectUrls=state.objectUrls||{};
    if(!state.objectUrls[key])state.objectUrls[key]=URL.createObjectURL(file);
    return state.objectUrls[key];
  }

  function syncExistingUrls(state){
    var source=Array.isArray(window._editExistingUrls)?window._editExistingUrls.slice():[];
    var kept=source.filter(function(u){return !state.removedExisting.has(u)});
    if(source.length!==kept.length||source.some(function(u,i){return u!==kept[i]}))window._editExistingUrls=kept.slice();
    return kept;
  }

  function renderOrderImageManager(form,input,state){
    var box=qs('.mee-order-image-manager-v364',form);if(!box)return;
    var existing=syncExistingUrls(state);
    var pasted=Array.isArray(window._pasted)?window._pasted:[];
    var sig=existing.join('||')+'##'+state.newFiles.map(fileKey).join('||')+'##'+pasted.map(fileKey).join('||');
    if(box.dataset.signature===sig)return;box.dataset.signature=sig;
    var parts=[];
    existing.forEach(function(u,i){parts.push('<div class="mee-order-image-tile-v364"><img src="'+esc(u)+'" alt="Ảnh hiện có"><span>Hiện có</span><button type="button" data-remove-existing="'+i+'" aria-label="Xóa ảnh">×</button></div>')});
    state.newFiles.forEach(function(f,i){parts.push('<div class="mee-order-image-tile-v364"><img src="'+esc(previewForFile(f,state))+'" alt="Ảnh mới"><span>Ảnh mới</span><button type="button" data-remove-new="'+i+'" aria-label="Xóa ảnh">×</button></div>')});
    pasted.forEach(function(f,i){if(!f)return;parts.push('<div class="mee-order-image-tile-v364"><img src="'+esc(previewForFile(f,state))+'" alt="Ảnh paste"><span>Ảnh paste</span><button type="button" data-remove-pasted="'+i+'" aria-label="Xóa ảnh">×</button></div>')});
    box.innerHTML=parts.length?'<div class="mee-order-image-grid-v364">'+parts.join('')+'</div><div class="mee-order-image-help-v364">Có '+parts.length+' ảnh sẽ được giữ/lưu. Bấm × trên ảnh để bỏ.</div>':'<div class="mee-order-image-empty-v364">Chưa có ảnh nào được chọn.</div>';

    qsa('[data-remove-existing]',box).forEach(function(b){b.onclick=function(){var idx=Number(b.dataset.removeExisting);var current=Array.isArray(window._editExistingUrls)?window._editExistingUrls.slice():[];var url=current[idx];if(url)state.removedExisting.add(url);window._editExistingUrls=current.filter(function(_,j){return j!==idx});box.dataset.signature='';renderOrderImageManager(form,input,state)}});
    qsa('[data-remove-new]',box).forEach(function(b){b.onclick=function(){state.newFiles.splice(Number(b.dataset.removeNew),1);rebuildFileInput(input,state);box.dataset.signature='';renderOrderImageManager(form,input,state)}});
    qsa('[data-remove-pasted]',box).forEach(function(b){b.onclick=function(){var i=Number(b.dataset.removePasted);if(Array.isArray(window._pasted))window._pasted.splice(i,1);box.dataset.signature='';renderOrderImageManager(form,input,state)}});
    qsa('.mee-order-image-tile-v364 img',box).forEach(function(img){img.onclick=function(){openProof(img.src)}});
  }

  function patchOrderImageUploader(){
    var form=qs('#orderForm');if(!form)return;
    var input=qs('#imageFiles',form);if(!input)return;
    var state=form._meeImageStateV364;
    if(!state){
      state={newFiles:[],removedExisting:new Set(),objectUrls:{}};form._meeImageStateV364=state;
      var box=document.createElement('div');box.className='mee-order-image-manager-v364';
      var sub=input.nextElementSibling; if(sub&&sub.classList.contains('sub'))sub.insertAdjacentElement('afterend',box); else input.insertAdjacentElement('afterend',box);
      input.addEventListener('change',function(){
        var incoming=Array.from(input.files||[]);var seen=new Set(state.newFiles.map(fileKey));
        incoming.forEach(function(f){var k=fileKey(f);if(!seen.has(k)){seen.add(k);state.newFiles.push(f)}});
        rebuildFileInput(input,state);box.dataset.signature='';renderOrderImageManager(form,input,state);
      });
      var ov=qs('#overlay');if(ov&&!ov.dataset.meePastePreview){ov.dataset.meePastePreview='1';ov.addEventListener('paste',function(){setTimeout(function(){box.dataset.signature='';renderOrderImageManager(form,input,state)},0)})}
    }
    renderOrderImageManager(form,input,state);
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

  function patch(){patchPayment();patchPaidCopy();patchMaterialsLabel();patchOrderImageUploader();ensureOverlayControls()}
  var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(patch,45)}
  function init(){
    patch();
    var root=qs('#content');if(root)new MutationObserver(schedule).observe(root,{childList:true,subtree:true,characterData:true});
    var ov=qs('#overlay');if(ov){
      new MutationObserver(schedule).observe(ov,{childList:true,subtree:true});
      ov.addEventListener('click',function(e){
        var target=e.target;
        if(target&&target.matches&&target.matches('.modal-bg,.drawer-bg')){e.preventDefault();closeActiveOverlay();return}
        var a=target&&target.closest?target.closest('.thumbs a'):null;
        if(a&&ov.contains(a)){var img=qs('img',a);if(img){e.preventDefault();e.stopPropagation();openProof(img.src)}}
      },true);
    }
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&qs('#overlay')&&qs('#overlay').firstElementChild){e.preventDefault();closeActiveOverlay()}});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
