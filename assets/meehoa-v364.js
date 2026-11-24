(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function fileKey(f){return [f&&f.name||'',f&&f.size||0,f&&f.lastModified||0].join('|')}

  function coreClose(){
    if(window.MEEOPS7&&typeof MEEOPS7.closeOverlay==='function')MEEOPS7.closeOverlay();
    else if(typeof window.closeOverlay==='function')window.closeOverlay();
    var ov=qs('#overlay');if(ov){ov.innerHTML='';ov.onpaste=null}
    document.body.classList.remove('mee-overlay-open-v364');
  }

  function closeActiveOverlay(){
    var ov=qs('#overlay');
    var proof=ov&&qs('.mee-proof-layer-v364',ov);
    if(proof){proof.remove();overlaySync();return}
    coreClose();
  }
  window.MEEV364CloseOverlay=closeActiveOverlay;

  function ensureOverlayControls(){
    var ov=qs('#overlay');if(!ov)return;
    var active=!!ov.firstElementChild;
    document.body.classList.toggle('mee-overlay-open-v364',active);
    if(!active)return;
    var panel=qs('.modal,.drawer,.mobile-menu-sheet,.calendar-modal,.mee3-order-drawer-form',ov);
    if(panel&&!panel.dataset.meeScrollInit){panel.dataset.meeScrollInit='1';panel.scrollTop=0}
  }

  function openProof(src){
    var ov=qs('#overlay');if(!ov||!src)return;
    qsa('.mee-proof-layer-v364',ov).forEach(function(x){x.remove()});
    var layer=document.createElement('div');layer.className='mee-proof-layer-v364';
    var ext=/^https?:\/\//i.test(String(src))?'<a class="mee3-proof-ext" href="'+esc(src)+'" target="_blank" rel="noopener">Mở tab mới ↗</a>':'';
    layer.innerHTML='<div class="modal-bg mee-proof-lightbox-v364"><div class="mee3-proof-toolbar">'+ext+'<button class="close" type="button" aria-label="Đóng ảnh" onclick="window.MEEV364CloseOverlay()">×</button></div><div class="mee-proof-view-v364"><img src="'+esc(src)+'" alt="Xem ảnh"></div></div>';
    ov.appendChild(layer);ensureOverlayControls();
  }
  window.MEEV364OpenProof=openProof;

  function paymentChecks(grid){
    return qsa('.settle-check',grid).filter(function(x){return !x.disabled});
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

    var checks=paymentChecks(grid);
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
        var current=paymentChecks(grid);
        var n=current.filter(function(x){return x.checked}).length;
        var count=qs('[data-mee-selected-v364]',bar);if(count)count.textContent=n+' đã chọn';
        if(master){master.checked=current.length>0&&n===current.length;master.indeterminate=n>0&&n<current.length}
      };
      if(master&&!master.dataset.bound){
        master.dataset.bound='1';
        master.addEventListener('change',function(){
          var want=master.checked;
          paymentChecks(grid).forEach(function(x){x.checked=want});
          sync();
        });
      }
      checks.forEach(function(x){if(!x.dataset.v364){x.dataset.v364='1';x.addEventListener('change',sync)}});
      if(!root.dataset.meePaymentBulkGuard){
        root.dataset.meePaymentBulkGuard='1';
        root.addEventListener('click',function(e){
          var btn=e.target&&e.target.closest?e.target.closest('button'):null;
          if(!btn)return;
          var text=String(btn.textContent||'').trim().toLowerCase();
          if(text.indexOf('duyệt các mục đã chọn')<0)return;
          var liveMaster=qs('#mee-settlement-select-all-v364',root);
          if(liveMaster&&liveMaster.checked)paymentChecks(grid).forEach(function(x){x.checked=true});
        },true);
      }
      sync();
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

  function existingDisplaySrc(u,i){
    var map=window._editPreviewMap||{};
    if(map[u])return map[u];
    var list=Array.isArray(window._editPreviewUrls)?window._editPreviewUrls:[];
    if(list[i])return list[i];
    return u;
  }
  function existingFullSrc(u,i){
    var map=window._editFullMap||{};
    if(map[u])return map[u];
    var list=Array.isArray(window._editFullUrls)?window._editFullUrls:[];
    if(list[i])return list[i];
    return existingDisplaySrc(u,i);
  }
  function renderOrderImageManager(form,input,state){
    var box=qs('.mee-order-image-manager-v364',form);if(!box)return;
    var existing=syncExistingUrls(state);
    var pasted=Array.isArray(window._pasted)?window._pasted:[];
    var sig=existing.map(function(u,i){return u+'@'+existingDisplaySrc(u,i)}).join('||')+'##'+state.newFiles.map(fileKey).join('||')+'##'+pasted.map(fileKey).join('||');
    if(box.dataset.signature===sig)return;box.dataset.signature=sig;
    var parts=[];
    existing.forEach(function(u,i){var thumb=existingDisplaySrc(u,i),full=existingFullSrc(u,i);parts.push('<div class="mee-order-image-tile-v364"><img src="'+esc(thumb)+'" data-full-src="'+esc(full)+'" loading="lazy" decoding="async" alt="Ảnh hiện có"><span>Hiện có</span><button type="button" data-remove-existing="'+i+'" aria-label="Xóa ảnh">×</button></div>')});
    state.newFiles.forEach(function(f,i){var src=previewForFile(f,state);parts.push('<div class="mee-order-image-tile-v364"><img src="'+esc(src)+'" data-full-src="'+esc(src)+'" alt="Ảnh mới"><span>Ảnh mới</span><button type="button" data-remove-new="'+i+'" aria-label="Xóa ảnh">×</button></div>')});
    pasted.forEach(function(f,i){if(!f)return;var src=previewForFile(f,state);parts.push('<div class="mee-order-image-tile-v364"><img src="'+esc(src)+'" data-full-src="'+esc(src)+'" alt="Ảnh paste"><span>Ảnh paste</span><button type="button" data-remove-pasted="'+i+'" aria-label="Xóa ảnh">×</button></div>')});
    box.innerHTML=parts.length?'<div class="mee-order-image-grid-v364">'+parts.join('')+'</div><div class="mee-order-image-help-v364">Có '+parts.length+' ảnh sẽ được giữ/lưu. Bấm × trên ảnh để bỏ.</div>':'<div class="mee-order-image-empty-v364">Chưa có ảnh nào được chọn.</div>';

    qsa('[data-remove-existing]',box).forEach(function(b){b.onclick=function(){var idx=Number(b.dataset.removeExisting);var current=Array.isArray(window._editExistingUrls)?window._editExistingUrls.slice():[];var url=current[idx];if(url)state.removedExisting.add(url);window._editExistingUrls=current.filter(function(_,j){return j!==idx});if(Array.isArray(window._editPreviewUrls))window._editPreviewUrls=window._editPreviewUrls.filter(function(_,j){return j!==idx});if(Array.isArray(window._editFullUrls))window._editFullUrls=window._editFullUrls.filter(function(_,j){return j!==idx});box.dataset.signature='';renderOrderImageManager(form,input,state)}});
    qsa('[data-remove-new]',box).forEach(function(b){b.onclick=function(){state.newFiles.splice(Number(b.dataset.removeNew),1);rebuildFileInput(input,state);box.dataset.signature='';renderOrderImageManager(form,input,state)}});
    qsa('[data-remove-pasted]',box).forEach(function(b){b.onclick=function(){var i=Number(b.dataset.removePasted);if(Array.isArray(window._pasted))window._pasted.splice(i,1);box.dataset.signature='';renderOrderImageManager(form,input,state)}});
    qsa('.mee-order-image-tile-v364 img',box).forEach(function(img){img.onclick=function(){openProof(img.dataset.fullSrc||img.src)}});
  }

  function patchOrderImageUploader(){
    var form=qs('#orderForm');if(!form)return;
    var input=qs('#imageFiles',form);if(!input)return;
    var state=form._meeImageStateV364;
    if(!state){
      state={newFiles:[],removedExisting:new Set(),objectUrls:{}};form._meeImageStateV364=state;
      var box=document.createElement('div');box.className='mee-order-image-manager-v364';
      var sub=input.nextElementSibling;if(sub&&sub.classList.contains('sub'))sub.insertAdjacentElement('afterend',box);else input.insertAdjacentElement('afterend',box);
      input.addEventListener('change',function(){
        var incoming=Array.from(input.files||[]);var seen=new Set(state.newFiles.map(fileKey));
        incoming.forEach(function(f){var k=fileKey(f);if(!seen.has(k)){seen.add(k);state.newFiles.push(f)}});
        rebuildFileInput(input,state);box.dataset.signature='';renderOrderImageManager(form,input,state);
      });
      var ov=qs('#overlay');if(ov&&!ov.dataset.meePastePreview){ov.dataset.meePastePreview='1';ov.addEventListener('paste',function(){setTimeout(function(){var liveForm=qs('#orderForm',ov);if(!liveForm)return;var liveInput=qs('#imageFiles',liveForm);var liveState=liveForm._meeImageStateV364;var liveBox=qs('.mee-order-image-manager-v364',liveForm);if(liveInput&&liveState&&liveBox){liveBox.dataset.signature='';renderOrderImageManager(liveForm,liveInput,liveState)}},0)})}
    }
    renderOrderImageManager(form,input,state);
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

  function contentSync(){patchPayment();patchMaterialsLabel()}
  function overlaySync(){patchOrderImageUploader();ensureOverlayControls()}
  function patch(){contentSync();overlaySync()}
  function init(){
    window.MEE_V364_CONTENT_SYNC=contentSync;
    window.MEE_V364_OVERLAY_SYNC=overlaySync;
    patch();
    var ov=qs('#overlay');if(ov){
      ov.addEventListener('click',function(e){
        var target=e.target;
        if(target&&target.matches&&target.matches('.modal-bg,.drawer-bg')){e.preventDefault();closeActiveOverlay();return}
        var lb=target&&target.closest?target.closest('[data-lightbox-src]'):null;
        if(lb&&ov.contains(lb)){e.preventDefault();e.stopPropagation();openProof(lb.getAttribute('data-lightbox-src')||lb.getAttribute('href'));return}
        var a=target&&target.closest?target.closest('.thumbs a,.mee3-thumb-strip a'):null;
        if(a&&ov.contains(a)){var img=qs('img',a);if(img){e.preventDefault();e.stopPropagation();openProof(a.dataset.fullSrc||img.dataset.fullSrc||a.getAttribute('href')||img.src)}}
      },true);
    }
    document.addEventListener('keydown',function(e){
      if(e.key!=='Escape')return;
      if(qs('#meeInvoicePreview')){e.preventDefault();if(window.MEE_CLOSE_INVOICE)window.MEE_CLOSE_INVOICE();else qs('#meeInvoicePreview').remove();return}
      if(qs('.mee3-dialog-layer')){e.preventDefault();if(window.MEE_UI_V3)window.MEE_UI_V3.closeDialog();else qs('.mee3-dialog-layer').remove();return}
      if(qs('#overlay')&&qs('#overlay').firstElementChild){e.preventDefault();closeActiveOverlay()}
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
