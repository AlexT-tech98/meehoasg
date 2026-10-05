/* Canonical runtime owner: materials AI diagnostics only. */
(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

  function patchMaterialsStatus(){
    if(!window.S||S.page!=='flowers')return;
    var d=S.filters&&S.filters.flowers&&S.filters.flowers.date;
    var r=d&&S.data&&S.data.flowers&&S.data.flowers[d];
    var el=qs('#content');if(!r||!el)return;

    var hero=qs('.mee-materials-hero',el);
    if(hero&&!qs('.mee-ai-model',hero)){
      var chip=document.createElement('span');
      chip.className='mee-summary-chip mee-ai-model';
      chip.textContent=r.aiModel?('AI: '+r.aiModel):(r.aiStatus&&r.aiStatus!=='CACHE'?'AI: '+r.aiStatus:'AI');
      var summary=qs('.mee-materials-summary',hero);if(summary)summary.appendChild(chip);
    }

    qsa('.mee-ai-error',el).forEach(function(x){if(r.status!=='ai_unavailable')x.remove()});
    if(r.status!=='ai_unavailable')return;
    if(qs('.mee-ai-error',el))return;
    qsa('.mee-review-panel,.mee-materials-grid>.empty',el).forEach(function(x){x.remove()});
    var box=document.createElement('section');box.className='mee-ai-error';
    box.innerHTML='<div class="mee-ai-error-icon">!</div><div><b>AI nguyên liệu đang không phản hồi</b><div class="sub">'+esc(r.aiMessage||'Không thể phân loại nguyên liệu lúc này.')+'</div><div class="mee-ai-error-models">Đã thử: '+esc((r.aiModelsTried||[]).join(' → ')||'chưa có model')+'</div></div>';
    if(hero)hero.insertAdjacentElement('afterend',box);else el.prepend(box);
  }

  var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(patchMaterialsStatus,60)}
  function init(){patchMaterialsStatus();var content=qs('#content');if(content)new MutationObserver(function(m){if(m.some(function(x){return x.type==='childList'&&(x.addedNodes.length||x.removedNodes.length)}))schedule()}).observe(content,{childList:true,subtree:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
