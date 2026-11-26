/* Canonical runtime owner: shell navigation, branding, search visibility, shipping icons. */
(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}


  function forceSidebarState(side,open){
    if(!side)return;
    side.classList.toggle('mee-open',open);
  }

  function ensureMenu(){
    var top=qs('.topbar');if(!top)return;
    var btn=qs('.mee-menu-btn',top);
    if(!btn){btn=document.createElement('button');btn.className='mee-menu-btn';btn.type='button';btn.title='Mở menu';btn.setAttribute('aria-label','Mở menu');btn.setAttribute('aria-expanded','false');btn.innerHTML='<span></span>';var left=qs('.topbar-left',top);top.insertBefore(btn,left||top.firstChild)}
    var back=qs('.mee-menu-backdrop');
    if(!back){back=document.createElement('div');back.className='mee-menu-backdrop';back.setAttribute('aria-hidden','true');document.body.appendChild(back)}
    function set(open){var side=qs('.sidebar');open=!!open;forceSidebarState(side,open);back.classList.toggle('mee-open',open);document.body.classList.toggle('mee-menu-open',open);btn.setAttribute('aria-expanded',open?'true':'false');back.setAttribute('aria-hidden',open?'false':'true');if(open&&side)side.scrollTop=0}
    if(btn.dataset.meeBound!=='1'){btn.dataset.meeBound='1';btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var side=qs('.sidebar');set(!(side&&side.classList.contains('mee-open')))},{passive:false})}
    if(back.dataset.meeBound!=='1'){back.dataset.meeBound='1';back.addEventListener('click',function(e){e.preventDefault();set(false)},{passive:false})}
    if(!document.documentElement.dataset.meeMenuKeys){document.documentElement.dataset.meeMenuKeys='1';document.addEventListener('keydown',function(e){if(e.key==='Escape')set(false)});document.addEventListener('click',function(e){if(e.target.closest('.sidebar button[data-p]'))set(false)},true)}
  }

  function ensureBranding(){
    qsa('.brand-mark').forEach(function(mark){mark.dataset.meeLogo='7';mark.classList.add('mee-brand-mark');mark.innerHTML='<img src="/assets/meehoa-mark.svg?v=7" alt="Meehoa">'});
    qsa('.sidebar .brand').forEach(function(brand){
      brand.dataset.meeBrand='atelier-28';brand.classList.add('mee-atelier-brand');
      var mark=brand.querySelector('.brand-mark');
      if(!mark){mark=document.createElement('div');mark.className='brand-mark mee-brand-mark';brand.insertBefore(mark,brand.firstChild)}
      mark.innerHTML='<span class="mee-atelier-wordmark">meehoa<i>.</i></span>';
      var copy=brand.querySelector('.brand-copy');
      if(!copy){copy=document.createElement('div');copy.className='brand-copy';brand.appendChild(copy)}
      copy.innerHTML='<small>MEEHOASG OPERATIONS</small>';
    });
  }

  function updateSearchVisibility(){
    var active=qs('[data-p].active');
    var page=(window.S&&S.page)||(active&&active.getAttribute('data-p'))||'';
    /* Production's legacy search field never filtered production orders. Hide it there
       until a production-owned search implementation exists instead of showing a dead control. */
    var show=page==='orders'||page==='dashboard';
    document.body.classList.toggle('mee-search-page',show);
    document.body.classList.toggle('mee-page-production',page==='production');
    document.body.classList.toggle('mee-page-kpi',page==='kpi');
  }

  function decorateShippingIcons(){
    /* Shipping icons are now rendered natively with crisp inline SVGs in UI V3 markup. */
  }

  function init(){
    window.MEE_SHELL_ROUTE_SYNC=updateSearchVisibility;
    window.MEE_SHELL_CONTENT_SYNC=decorateShippingIcons;
    ensureMenu();ensureBranding();updateSearchVisibility();decorateShippingIcons();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
