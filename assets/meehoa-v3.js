(function(){
  'use strict';

  function qs(s,root){return (root||document).querySelector(s)}
  function qsa(s,root){return Array.from((root||document).querySelectorAll(s))}
  function clamp(n,min,max){return Math.max(min,Math.min(max,n))}

  function retireLegacyMobileNav(){
    var legacy=qs('#mobileNav');
    if(legacy) legacy.remove();
  }

  function forceSidebarState(side,open){
    if(!side) return;
    side.classList.toggle('mee-open',open);
    if(open){
      side.style.setProperty('display','flex','important');
      side.style.setProperty('position','fixed','important');
      side.style.setProperty('top','0','important');
      side.style.setProperty('bottom','0','important');
      side.style.setProperty('left','0','important');
      side.style.setProperty('right','auto','important');
      side.style.setProperty('width','min(84vw,300px)','important');
      side.style.setProperty('max-width','300px','important');
      side.style.setProperty('height','100dvh','important');
      side.style.setProperty('transform','translate3d(0,0,0)','important');
      side.style.setProperty('visibility','visible','important');
      side.style.setProperty('pointer-events','auto','important');
      side.style.setProperty('opacity','1','important');
      side.style.setProperty('z-index','2147483001','important');
    }else{
      ['display','position','top','bottom','left','right','width','max-width','height','transform','visibility','pointer-events','opacity','z-index'].forEach(function(p){side.style.removeProperty(p)});
    }
  }

  function ensureMenu(){
    var top=qs('.topbar');
    if(!top) return;
    retireLegacyMobileNav();

    var btn=qs('.mee-menu-btn',top);
    if(!btn){
      btn=document.createElement('button');
      btn.className='mee-menu-btn';
      btn.type='button';
      btn.title='Mở menu';
      btn.setAttribute('aria-label','Mở menu');
      btn.setAttribute('aria-expanded','false');
      btn.innerHTML='<span></span>';
      var left=qs('.topbar-left',top);
      top.insertBefore(btn,left||top.firstChild);
    }

    var back=qs('.mee-menu-backdrop');
    if(!back){
      back=document.createElement('div');
      back.className='mee-menu-backdrop';
      back.setAttribute('aria-hidden','true');
      document.body.appendChild(back);
    }
    back.style.setProperty('z-index','2147483000','important');

    function set(open){
      var side=qs('.sidebar');
      open=!!open;
      forceSidebarState(side,open);
      back.classList.toggle('mee-open',open);
      document.body.classList.toggle('mee-menu-open',open);
      btn.setAttribute('aria-expanded',open?'true':'false');
      back.setAttribute('aria-hidden',open?'false':'true');
      if(open && side) side.scrollTop=0;
    }

    if(btn.dataset.meeBound!=='1'){
      btn.dataset.meeBound='1';
      btn.addEventListener('click',function(e){
        e.preventDefault();
        e.stopPropagation();
        var side=qs('.sidebar');
        set(!(side&&side.classList.contains('mee-open')));
      },{passive:false});
    }
    if(back.dataset.meeBound!=='1'){
      back.dataset.meeBound='1';
      back.addEventListener('click',function(e){e.preventDefault();set(false)},{passive:false});
    }
    if(!document.documentElement.dataset.meeMenuKeys){
      document.documentElement.dataset.meeMenuKeys='1';
      document.addEventListener('keydown',function(e){if(e.key==='Escape')set(false)});
      document.addEventListener('click',function(e){if(e.target.closest('.sidebar button[data-p]')) set(false)},true);
    }
  }

  function ensureBranding(){
    qsa('.brand-mark').forEach(function(mark){
      mark.dataset.meeLogo='1';
      mark.classList.add('mee-brand-mark');
      mark.innerHTML='<img src="/assets/meehoa-mark.svg?v=2" alt="Meehoa">';
    });
    qsa('.sidebar .brand').forEach(function(brand){
      if(brand.dataset.meeBrand==='2') return;
      brand.dataset.meeBrand='2';
      var copy=brand.querySelector('.brand-copy');
      if(copy) copy.innerHTML='<img class="mee-brand-wordmark" src="/assets/meehoa-wordmark.svg?v=2" alt="meehoa.">';
    });
  }

  function updateSearchVisibility(){
    var active=qs('[data-p].active');
    var page=(window.S&&S.page)||(active&&active.getAttribute('data-p'))||'';
    var show=page==='orders'||page==='production';
    document.body.classList.toggle('mee-search-page',show);
    document.body.classList.toggle('mee-page-production',page==='production');
    document.body.classList.toggle('mee-page-kpi',page==='kpi');
  }

  function shippingIcon(text){
    text=String(text||'');
    if(/Shop book ship/i.test(text)) return '🛵';
    if(/Khách tự book/i.test(text)) return '📱';
    if(/Ghé lấy/i.test(text)) return '🏪';
    return '';
  }

  function decorateShippingIcons(){
    qsa('.order .meta,.order-card-mobile .meta,.order-card-mobile-meta,.drawer .meta,.drawer-row,.ops-lines span').forEach(function(el){
      var txt=el.textContent||'',icon=shippingIcon(txt);
      if(!icon) return;
      el.innerHTML=el.innerHTML.replace(/🚗|🚙|🚚|🚘/g,icon);
      if(!el.querySelector('.mee-shipping-icon') && !/[🛵📱🏪]/.test(el.textContent||'')){
        var span=document.createElement('span');
        span.className='mee-shipping-icon';
        span.textContent=icon;
        el.insertBefore(span,el.firstChild);
      }
    });
  }

  function parseStatusCounts(){
    var text=(qs('#content')||{}).innerText||'';
    function find(label){var re=new RegExp(label+'\\s*(?:\\([^)]*\\))?\\s*([0-9]+)\\s*đơn','i');var m=text.match(re);return m?Number(m[1]):0}
    var delivered=find('Đã giao'),packed=find('Đã bó'),wait=find('Chờ bó');
    if(!(delivered||packed||wait)) qsa('.dashboard-right b').forEach(function(b){var row=b.parentElement&&b.parentElement.textContent||'';var n=Number((b.textContent.match(/\d+/)||[0])[0]);if(/Đã giao/i.test(row))delivered=n;else if(/Đã bó/i.test(row))packed=n;else if(/Chờ bó/i.test(row))wait=n});
    return {delivered:delivered,packed:packed,wait:wait,total:delivered+packed+wait};
  }

  function addDashboardCharts(){
    var content=qs('#content');if(!content)return;var header=qs('.stat-grid-5',content);if(!header||qs('.mee-chart-grid',content))return;var c=parseStatusCounts();var total=c.total||1;var d=clamp(Math.round(c.delivered/total*100),0,100);var p=clamp(Math.round(c.packed/total*100),0,100);var w=clamp(100-d-p,0,100);var max=Math.max(c.delivered,c.packed,c.wait,1);var wrap=document.createElement('div');wrap.className='mee-chart-grid';wrap.innerHTML='<section class="mee-chart-card"><div class="mee-chart-title">Trạng thái đơn hôm nay</div><div class="mee-donut-wrap"><div class="mee-donut" style="background:conic-gradient(#4d9a7c 0 '+d+'%,#8da9e8 '+d+'% '+(d+p)+'%,#f2bd4d '+(d+p)+'% 100%)"><div class="mee-donut-center"><div><b>'+c.total+'</b>đơn</div></div></div><div class="mee-legend"><div class="mee-legend-row"><span class="mee-legend-label"><i class="mee-dot" style="background:#4d9a7c"></i>Đã giao</span><b>'+c.delivered+' · '+d+'%</b></div><div class="mee-legend-row"><span class="mee-legend-label"><i class="mee-dot" style="background:#8da9e8"></i>Đã bó</span><b>'+c.packed+' · '+p+'%</b></div><div class="mee-legend-row"><span class="mee-legend-label"><i class="mee-dot" style="background:#f2bd4d"></i>Chờ bó</span><b>'+c.wait+' · '+w+'%</b></div></div></div></section><section class="mee-chart-card"><div class="mee-chart-title">Khối lượng xử lý</div><div class="mee-bars"><div class="mee-bar-row"><span>Chờ bó</span><div class="mee-bar-track"><div class="mee-bar-fill" style="width:'+(c.wait/max*100)+'%;background:#f2bd4d"></div></div><b>'+c.wait+'</b></div><div class="mee-bar-row"><span>Đã bó</span><div class="mee-bar-track"><div class="mee-bar-fill" style="width:'+(c.packed/max*100)+'%;background:#8da9e8"></div></div><b>'+c.packed+'</b></div><div class="mee-bar-row"><span>Đã giao</span><div class="mee-bar-track"><div class="mee-bar-fill" style="width:'+(c.delivered/max*100)+'%;background:#4d9a7c"></div></div><b>'+c.delivered+'</b></div></div><div class="mee-chart-note">Biểu đồ dùng dữ liệu thật đang hiển thị trên Dashboard.</div></section>';header.insertAdjacentElement('afterend',wrap);
  }

  function markPage(){retireLegacyMobileNav();ensureMenu();ensureBranding();updateSearchVisibility();decorateShippingIcons();addDashboardCharts()}
  var timer=null;
  var mo=new MutationObserver(function(mutations){var relevant=mutations.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)});if(!relevant)return;clearTimeout(timer);timer=setTimeout(markPage,100)});
  function init(){markPage();var content=qs('#content'),overlay=qs('#overlay');if(content)mo.observe(content,{subtree:true,childList:true});if(overlay)mo.observe(overlay,{subtree:true,childList:true});document.addEventListener('click',function(e){if(e.target.closest('[data-p]'))setTimeout(markPage,0)},true)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
