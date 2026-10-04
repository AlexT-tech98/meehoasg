(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function parseHour(value){
    var s=String(value||'').trim();
    if(!s)return null;
    var m=s.match(/(?:^|\D)([01]?\d|2[0-3])(?:\s*[:hH]\s*([0-5]\d))?/);
    if(!m)return null;
    var h=Number(m[1]);return Number.isFinite(h)&&h>=0&&h<=23?h:null;
  }
  function collectOrders(){
    if(!window.S)return[];
    var out=[],seen=new Set();
    function add(o){if(!o||typeof o!=='object')return;var id=o.id||o.orderId||o.order_id||o.row||o._row;if(id&&seen.has(String(id)))return;if(id)seen.add(String(id));out.push(o)}
    if(S.orders&&typeof S.orders.forEach==='function')S.orders.forEach(add);
    function walk(v,depth){if(!v||depth>4)return;if(Array.isArray(v)){v.forEach(function(x){if(x&&typeof x==='object'&&(x.time!==undefined||x.receiveTime!==undefined||x.receive_time!==undefined))add(x);else walk(x,depth+1)});return}if(v instanceof Map){v.forEach(function(x){walk(x,depth+1)});return}if(typeof v==='object'){Object.keys(v).forEach(function(k){if(k==='user'||k==='options')return;walk(v[k],depth+1)})}}
    if(!out.length){walk(S.data,0);walk(S.cache,0)}
    return out;
  }
  function visibleDateFilter(){
    var inputs=Array.from(document.querySelectorAll('#content input[type="date"],#content [data-date]'));
    var vals=inputs.map(function(x){return x.value||x.getAttribute('data-date')||''}).filter(Boolean);
    return vals.length?vals:null;
  }
  function countSlots(){
    var dates=visibleDateFilter(),counts={};
    collectOrders().forEach(function(o){
      var date=String(o.date||o.receiveDate||o.receive_date||'');
      if(dates&&date&&dates.indexOf(date)<0)return;
      var h=parseHour(o.time||o.receiveTime||o.receive_time||o.deliveryTime||o.delivery_time);
      if(h===null)return;counts[h]=(counts[h]||0)+1;
    });
    return Object.keys(counts).map(Number).sort(function(a,b){return a-b}).map(function(h){return {hour:h,count:counts[h]}});
  }
  function ensureStyle(){if(qs('#meeHourlyStyle'))return;var st=document.createElement('style');st.id='meeHourlyStyle';st.textContent='.mee-hourly-card{background:var(--bg-surface,#fff);border:1px solid var(--border,#e8e7e0);border-radius:14px;padding:18px 18px 16px;margin:14px 0;box-shadow:var(--shadow-card,0 2px 8px rgba(0,0,0,.04))}.mee-hourly-head{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:16px}.mee-hourly-title{font-weight:800;font-size:14px;color:var(--text-primary,#1c2b24)}.mee-hourly-sub{font-size:11px;color:var(--text-muted,#83948c);margin-top:2px}.mee-hourly-bars{display:flex;align-items:end;gap:10px;min-height:145px;overflow-x:auto;padding:4px 2px 2px;scrollbar-width:thin}.mee-hourly-col{flex:1 0 52px;min-width:52px;text-align:center}.mee-hourly-count{font-size:12px;font-weight:800;color:var(--brand-green,#155e47);margin-bottom:6px}.mee-hourly-track{height:92px;display:flex;align-items:end;justify-content:center;background:var(--bg-subtle,#f6f5f0);border-radius:8px;padding:0 7px;overflow:hidden}.mee-hourly-fill{width:100%;min-height:8px;border-radius:6px 6px 2px 2px;background:var(--brand-green,#155e47);transition:height .25s ease}.mee-hourly-label{font-size:10.5px;font-weight:650;color:var(--text-secondary,#4a5b53);margin-top:7px;white-space:nowrap}@media(max-width:640px){.mee-hourly-card{padding:15px 12px;margin:12px 0}.mee-hourly-bars{gap:7px;min-height:132px}.mee-hourly-col{flex-basis:46px;min-width:46px}.mee-hourly-track{height:82px}}';document.head.appendChild(st)}
  function render(){
    if(!window.S||S.page!=='dashboard')return;
    var content=qs('#content');if(!content)return;
    var anchor=qs('.mee-chart-grid',content)||qs('.stat-grid-5',content);if(!anchor)return;
    var slots=countSlots(),card=qs('.mee-hourly-card',content);
    if(!slots.length){if(card)card.remove();return}
    var max=Math.max.apply(null,slots.map(function(x){return x.count}))||1;
    var html='<div class="mee-hourly-head"><div><div class="mee-hourly-title">Đơn theo khung giờ</div><div class="mee-hourly-sub">Chỉ hiển thị khung giờ có đơn</div></div></div><div class="mee-hourly-bars">'+slots.map(function(x){var next=(x.hour+1)%24;var label=String(x.hour).padStart(2,'0')+'–'+String(next).padStart(2,'0')+'h';var height=Math.max(8,Math.round(x.count/max*100));return '<div class="mee-hourly-col" title="'+esc(label+': '+x.count+' đơn')+'"><div class="mee-hourly-count">'+x.count+' đơn</div><div class="mee-hourly-track"><div class="mee-hourly-fill" style="height:'+height+'%"></div></div><div class="mee-hourly-label">'+label+'</div></div>'}).join('')+'</div>';
    if(!card){card=document.createElement('section');card.className='mee-hourly-card';anchor.insertAdjacentElement('afterend',card)}
    card.innerHTML=html;
  }
  function init(){ensureStyle();var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(render,120)}render();var content=qs('#content');if(content)new MutationObserver(schedule).observe(content,{childList:true,subtree:true});document.addEventListener('click',function(e){if(e.target.closest('[data-p],input[type="date"],button'))schedule()},true);document.addEventListener('change',schedule,true)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
