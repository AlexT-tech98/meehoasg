(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

  function patchMaterialsStatus(){
    if(!window.S||S.page!=='flowers')return;
    var d=S.filters&&S.filters.flowers&&S.filters.flowers.date;
    var r=d&&S.data&&S.data.flowers&&S.data.flowers[d];
    var el=qs('#content');
    if(!r||!el)return;

    var hero=qs('.mee-materials-hero',el);
    if(hero&&!qs('.mee-ai-model',hero)){
      var chip=document.createElement('span');
      chip.className='mee-summary-chip mee-ai-model';
      chip.textContent=r.aiModel?('AI: '+r.aiModel):(r.aiStatus&&r.aiStatus!=='CACHE'?'AI: '+r.aiStatus:'AI');
      var summary=qs('.mee-materials-summary',hero);
      if(summary)summary.appendChild(chip);
    }

    if(r.status==='ai_unavailable'){
      var old=qs('.mee-ai-error',el);
      if(old)return;
      qsa('.mee-review-panel,.mee-materials-grid>.empty',el).forEach(function(x){x.remove()});
      var box=document.createElement('section');
      box.className='mee-ai-error';
      box.innerHTML='<div class="mee-ai-error-icon">!</div><div><b>AI nguyên liệu đang không phản hồi</b><div class="sub">'+
        esc(r.aiMessage||'Không thể phân loại nguyên liệu lúc này.')+
        '</div><div class="mee-ai-error-models">Đã thử: '+esc((r.aiModelsTried||[]).join(' → ')||'chưa có model')+'</div></div>';
      if(hero)hero.insertAdjacentElement('afterend',box); else el.prepend(box);
    }
  }

  function updateSelectionState(root){
    var checks=qsa('.settle input[type="checkbox"]',root).filter(function(x){return !x.disabled});
    var master=qs('#mee-settlement-select-all',root);
    var count=checks.filter(function(x){return x.checked}).length;
    var countEl=qs('[data-mee-selected-count]',root);
    if(countEl)countEl.textContent=count+' đã chọn';
    if(master){
      master.checked=checks.length>0&&count===checks.length;
      master.indeterminate=count>0&&count<checks.length;
    }
  }

  function patchSettlement(){
    if(!window.S||S.page!=='settlement')return;
    var el=qs('#content');
    if(!el)return;
    document.body.classList.add('mee-page-settlement-v362');
    var cards=qsa(':scope > .settle',el);
    var grid=qs('.mee-settlement-grid',el);

    if(!grid&&cards.length){
      grid=document.createElement('div');
      grid.className='mee-settlement-grid';
      cards[0].parentNode.insertBefore(grid,cards[0]);
      cards.forEach(function(card){grid.appendChild(card)});
    }
    if(!grid)return;

    var checks=qsa('.settle input[type="checkbox"]',grid).filter(function(x){return !x.disabled});
    if(checks.length&&!qs('.mee-settlement-selectbar',el)){
      var selectbar=document.createElement('div');
      selectbar.className='mee-settlement-selectbar';
      selectbar.innerHTML=
        '<label class="mee-select-all-label"><input type="checkbox" id="mee-settlement-select-all"> <span>Chọn tất cả</span></label>'+
        '<span class="mee-selected-count" data-mee-selected-count>0 đã chọn</span>';
      grid.parentNode.insertBefore(selectbar,grid);
      var master=qs('#mee-settlement-select-all',selectbar);
      master.addEventListener('change',function(){
        checks.forEach(function(x){x.checked=master.checked;x.dispatchEvent(new Event('change',{bubbles:true}))});
        updateSelectionState(el);
      });
      checks.forEach(function(x){x.addEventListener('change',function(){updateSelectionState(el)})});
      updateSelectionState(el);
    }

    qsa('.settle .bill',grid).forEach(function(img){
      if(img.dataset.meeThumb)return;
      img.dataset.meeThumb='1';
      img.setAttribute('loading','lazy');
      img.addEventListener('click',function(){
        var ov=qs('#overlay');
        if(!ov)return;
        ov.innerHTML='<div class="modal-bg mee-proof-lightbox" onclick="if(event.target===this)MEEOPS7.closeOverlay()">'+
          '<div class="mee-proof-view"><button type="button" class="close" onclick="MEEOPS7.closeOverlay()">×</button>'+
          '<img src="'+esc(img.src)+'" alt="Chứng minh thanh toán"></div></div>';
      });
    });
  }

  function patch(){
    patchMaterialsStatus();
    patchSettlement();
  }

  var timer=null;
  function schedule(){clearTimeout(timer);timer=setTimeout(patch,60)}
  function init(){
    patch();
    var content=qs('#content');
    if(content){
      new MutationObserver(function(m){
        if(m.some(function(x){return x.type==='childList'&&(x.addedNodes.length||x.removedNodes.length)}))schedule();
      }).observe(content,{childList:true,subtree:true});
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
