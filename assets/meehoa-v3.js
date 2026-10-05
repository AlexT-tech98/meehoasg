/* Canonical runtime owner: shell navigation, branding, search visibility, shipping icons. */
(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}

  function retireLegacyMobileNav(){var legacy=qs('#mobileNav');if(legacy)legacy.remove()}

  function forceSidebarState(side,open){
    if(!side)return;
    side.classList.toggle('mee-open',open);
    if(open){
      [['display','flex'],['position','fixed'],['top','0'],['bottom','0'],['left','0'],['right','auto'],['width','min(84vw,300px)'],['max-width','300px'],['height','100dvh'],['transform','translate3d(0,0,0)'],['visibility','visible'],['pointer-events','auto'],['opacity','1'],['z-index','2147483001']].forEach(function(x){side.style.setProperty(x[0],x[1],'important')});
    }else{
      ['display','position','top','bottom','left','right','width','max-width','height','transform','visibility','pointer-events','opacity','z-index'].forEach(function(p){side.style.removeProperty(p)});
    }
  }

  function ensureMenu(){
    var top=qs('.topbar');if(!top)return;retireLegacyMobileNav();
    var btn=qs('.mee-menu-btn',top);
    if(!btn){btn=document.createElement('button');btn.className='mee-menu-btn';btn.type='button';btn.title='Mở menu';btn.setAttribute('aria-label','Mở menu');btn.setAttribute('aria-expanded','false');btn.innerHTML='<span></span>';var left=qs('.topbar-left',top);top.insertBefore(btn,left||top.firstChild)}
    var back=qs('.mee-menu-backdrop');
    if(!back){back=document.createElement('div');back.className='mee-menu-backdrop';back.setAttribute('aria-hidden','true');document.body.appendChild(back)}
    back.style.setProperty('z-index','2147483000','important');
    function set(open){var side=qs('.sidebar');open=!!open;forceSidebarState(side,open);back.classList.toggle('mee-open',open);document.body.classList.toggle('mee-menu-open',open);btn.setAttribute('aria-expanded',open?'true':'false');back.setAttribute('aria-hidden',open?'false':'true');if(open&&side)side.scrollTop=0}
    if(btn.dataset.meeBound!=='1'){btn.dataset.meeBound='1';btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var side=qs('.sidebar');set(!(side&&side.classList.contains('mee-open')))},{passive:false})}
    if(back.dataset.meeBound!=='1'){back.dataset.meeBound='1';back.addEventListener('click',function(e){e.preventDefault();set(false)},{passive:false})}
    if(!document.documentElement.dataset.meeMenuKeys){document.documentElement.dataset.meeMenuKeys='1';document.addEventListener('keydown',function(e){if(e.key==='Escape')set(false)});document.addEventListener('click',function(e){if(e.target.closest('.sidebar button[data-p]'))set(false)},true)}
  }

  function ensureBranding(){
    qsa('.brand-mark').forEach(function(mark){mark.dataset.meeLogo='7';mark.classList.add('mee-brand-mark');mark.innerHTML='<img src="/assets/meehoa-mark.svg?v=7" alt="Meehoa">'});
    qsa('.sidebar .brand').forEach(function(brand){brand.dataset.meeBrand='7';brand.classList.add('mee-brand-compact-only');var mark=brand.querySelector('.brand-mark');if(!mark){mark=document.createElement('div');mark.className='brand-mark mee-brand-mark';brand.insertBefore(mark,brand.firstChild)}mark.innerHTML='<img src="/assets/meehoa-mark.svg?v=7" alt="Meehoa">';var copy=brand.querySelector('.brand-copy');if(copy)copy.remove()});
  }

  function updateSearchVisibility(){
    var active=qs('[data-p].active');
    var page=(window.S&&S.page)||(active&&active.getAttribute('data-p'))||'';
    var show=page==='orders'||page==='production';
    document.body.classList.toggle('mee-search-page',show);
    document.body.classList.toggle('mee-page-production',page==='production');
    document.body.classList.toggle('mee-page-kpi',page==='kpi');
  }

  function cleanKpiCopy(){
    var active=qs('[data-p="kpi"].active');var title=(qs('#pageTitle')||{}).textContent||'';
    if(!active&&!/KPI|Báo cáo/i.test(title))return;
    var content=qs('#content');if(!content)return;
    var head=content.querySelector('.section-head');
    if(head){qsa('.sub',head).forEach(function(el){el.remove()});var next=head.nextElementSibling;if(next&&next.classList&&next.classList.contains('notice'))next.remove()}
  }

  function shippingIcon(text){text=String(text||'');if(/Shop book ship/i.test(text))return'🛵';if(/Khách tự book/i.test(text))return'📱';if(/Ghé lấy/i.test(text))return'🏪';return''}
  function decorateShippingIcons(){
    qsa('.order .meta,.order-card-mobile .meta,.order-card-mobile-meta,.drawer .meta,.drawer-row,.ops-lines span').forEach(function(el){
      var txt=el.textContent||'',icon=shippingIcon(txt);if(!icon)return;
      el.innerHTML=el.innerHTML.replace(/🚗|🚙|🚚|🚘/g,icon);
      if(!el.querySelector('.mee-shipping-icon')&&!/[🛵📱🏪]/.test(el.textContent||'')){var span=document.createElement('span');span.className='mee-shipping-icon';span.textContent=icon;el.insertBefore(span,el.firstChild)}
    })
  }

  function patchShell(){retireLegacyMobileNav();ensureMenu();ensureBranding();updateSearchVisibility();cleanKpiCopy();decorateShippingIcons()}
  var timer=null,mo=new MutationObserver(function(ms){
    var relevant=ms.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)});if(!relevant)return;
    clearTimeout(timer);timer=setTimeout(patchShell,80)
  });
  function init(){
    patchShell();var content=qs('#content'),overlay=qs('#overlay');
    if(content)mo.observe(content,{subtree:true,childList:true});
    if(overlay)mo.observe(overlay,{subtree:true,childList:true});
    document.addEventListener('click',function(e){if(e.target.closest('[data-p]'))setTimeout(patchShell,0)},true)
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
