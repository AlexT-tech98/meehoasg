/* Canonical runtime owner: dashboard summary + sales/day report. */
(function(){
  'use strict';
  window.__MEE_DASHBOARD_V361__=true;
  function qs(s,r){return (r||document).querySelector(s)}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function money(n){return new Intl.NumberFormat('vi-VN').format(Number(n)||0)+' đ'}
  function dateVN(iso){if(!iso)return'';var p=String(iso).split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:iso}

  function buildSummary(r,el){
    var s=r.summary||{},grid=qs('.stat-grid-5',el);if(!grid)return;
    var total=Number(s.orders||0),waiting=Number(s['Chờ bó']||0),delivered=Number(s['Đã giao']||0),notDelivered=Math.max(0,total-delivered);
    var pending=Number(s.unsettledRevenue||0),settled=Number(s.settledRevenue||0),debt=Number(s.debt||0);
    var sig=[total,waiting,notDelivered,pending,settled,debt].join('|');if(grid.dataset.v361Sig===sig)return;
    grid.classList.add('mee-dashboard-summary');
    grid.innerHTML=''+
      '<article class="mee-summary-card orders"><div class="mee-summary-kicker">Đơn hàng</div><div class="mee-summary-main">'+total+' đơn</div><div class="mee-summary-mini-grid"><div class="mee-summary-mini"><span>Chờ bó</span><b>'+waiting+'</b></div><div class="mee-summary-mini"><span>Chưa giao</span><b>'+notDelivered+'</b></div></div></article>'+
      '<article class="mee-summary-card revenue"><div class="mee-summary-kicker">Doanh thu</div><div class="mee-revenue-lines"><div class="mee-revenue-line pending"><span>Chưa tất toán</span><b>'+money(pending)+'</b></div><div class="mee-revenue-line settled"><span>Đã tất toán</span><b>'+money(settled)+'</b></div></div></article>'+
      '<article class="mee-summary-card debt"><div class="mee-summary-kicker">Công nợ chưa thu</div><div class="mee-summary-main">'+money(debt)+'</div><div class="mee-debt-note">Theo số tiền còn phải thu trên các đơn chưa khóa đối soát.</div></article>';
    grid.dataset.v361Sig=sig;
  }

  function buildReport(r,el){
    var items=Array.isArray(r.salesDaily)?r.salesDaily:[];
    var sig=JSON.stringify(items.map(function(x){return[x.date,x.sale,x.orders,x.unsettledRevenue,x.settledRevenue]}));
    var section=qs('.mee-sales-daily-section',el);if(!section){section=document.createElement('section');section.className='mee-sales-daily-section';el.appendChild(section)}
    if(section.dataset.v361Sig===sig)return;
    var rows=items.map(function(x){return '<tr><td>'+esc(dateVN(x.date))+'</td><td><b>'+esc(x.sale||'Chưa gán')+'</b></td><td>'+Number(x.orders||0)+' đơn</td><td class="mee-money-pending">'+money(x.unsettledRevenue||0)+'</td><td class="mee-money-settled">'+money(x.settledRevenue||x.revenue||0)+'</td></tr>'}).join('');
    section.innerHTML='<div class="mee-v361-report-card"><div class="mee-v361-report-head"><div><h3>Báo cáo doanh thu theo nhân viên / ngày</h3><div class="sub">Đối chiếu doanh thu chưa và đã tất toán theo từng Sale.</div></div><span class="mee-v361-rule">Tách trạng thái đối soát</span></div><div class="mee-v361-table-wrap"><table class="mee-v361-table"><thead><tr><th>Ngày</th><th>Nhân viên</th><th>Số đơn</th><th>Chưa tất toán</th><th>Đã tất toán</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5" class="mee-v361-empty">Chưa có dữ liệu trong khoảng đang chọn.</td></tr>')+'</tbody></table></div></div>';
    section.dataset.v361Sig=sig;
  }

  function patchDashboard(){
    if(!window.S||S.page!=='dashboard')return;
    var r=S.data&&S.data.dashboard,el=qs('#content');if(!r||!el)return;
    buildSummary(r,el);buildReport(r,el);
  }

  var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(patchDashboard,45)}
  function init(){patchDashboard();var content=qs('#content');if(content)new MutationObserver(function(ms){if(ms.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)}))schedule()}).observe(content,{childList:true,subtree:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
