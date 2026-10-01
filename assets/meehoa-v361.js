(function(){
  'use strict';
  window.__MEE_DASHBOARD_V361__=true;

  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function money(n){return new Intl.NumberFormat('vi-VN').format(Number(n)||0)+' đ'}
  function dateVN(iso){if(!iso)return'';var p=String(iso).split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:iso}
  function clamp(n,min,max){return Math.max(min,Math.min(max,n))}

  function injectStyles(){
    if(qs('#mee-v361-style'))return;
    var style=document.createElement('style');style.id='mee-v361-style';
    style.textContent=`
/* v3.6.1 desktop-fit + compact dashboard */
.topbar{left:0!important;right:0!important;width:100%!important;max-width:100vw!important}
.main{margin-left:0!important;width:100%!important;max-width:100vw!important;min-width:0!important}
.content,#content{width:min(100%,1680px)!important;max-width:1680px!important;margin-left:auto!important;margin-right:auto!important;min-width:0!important;overflow-x:hidden!important}
.sales-kpi-grid{width:100%!important;min-width:0!important}.sales-kpi-card{min-width:0!important;max-width:100%!important;overflow:hidden!important}
@media(min-width:1200px){.sales-kpi-grid{grid-template-columns:repeat(4,minmax(0,1fr))!important}}
@media(min-width:901px) and (max-width:1199px){.sales-kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
@media(max-width:900px){.content,#content{width:100%!important;max-width:100%!important}.sales-kpi-grid{grid-template-columns:minmax(0,1fr)!important}}

.mee-dashboard-summary{display:grid!important;grid-template-columns:1.05fr 1.15fr .8fr!important;gap:12px!important;margin:0 0 18px!important}
.mee-dashboard-summary .mee-summary-card{min-width:0;border:1px solid rgba(68,82,75,.08);border-radius:18px;padding:15px 16px;background:#fff;box-shadow:0 8px 24px rgba(58,45,39,.055);position:relative;overflow:hidden}
.mee-dashboard-summary .mee-summary-card.orders{background:linear-gradient(145deg,#fff,#fff7df)}
.mee-dashboard-summary .mee-summary-card.revenue{background:linear-gradient(145deg,#fff,#eef9f4)}
.mee-dashboard-summary .mee-summary-card.debt{background:linear-gradient(145deg,#fff,#fff0f4)}
.mee-summary-kicker{font-size:10.5px;line-height:1.2;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#7b8a82;margin-bottom:7px}
.mee-summary-main{font-size:26px;font-weight:850;letter-spacing:-.04em;color:#20342b;line-height:1.08}
.mee-summary-mini-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.mee-summary-mini{padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.74);border:1px solid rgba(65,89,76,.07)}.mee-summary-mini span{display:block;font-size:10.5px;color:#7b8b83}.mee-summary-mini b{display:block;margin-top:2px;font-size:15px;color:#2c3a34}
.mee-revenue-lines{display:grid;gap:8px;margin-top:5px}.mee-revenue-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.75);border:1px solid rgba(65,89,76,.07)}.mee-revenue-line span{font-size:11.5px;color:#697b72}.mee-revenue-line b{font-size:16px;white-space:nowrap}.mee-revenue-line.pending b{color:#a16a12}.mee-revenue-line.settled b{color:#166d50}
.mee-debt-note{font-size:11px;color:#8e6b74;margin-top:8px}

.mee-sales-daily-section{margin:22px 0 8px!important;padding:0!important;background:transparent!important;border:0!important;box-shadow:none!important}
.mee-v361-report-card{border:1px solid rgba(65,89,76,.09);border-radius:20px;background:#fff;padding:17px;box-shadow:0 10px 28px rgba(30,55,45,.055)}
.mee-v361-report-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:13px}.mee-v361-report-head h3{margin:0;font-size:16px}.mee-v361-report-head .sub{margin-top:3px}.mee-v361-rule{display:inline-flex;gap:6px;align-items:center;border-radius:999px;padding:6px 10px;background:#f4f8f5;border:1px solid #e1ebe5;font-size:11px;font-weight:750;color:#4d6b5e}
.mee-v361-table-wrap{overflow:auto;border:1px solid #e9eeeb;border-radius:14px}.mee-v361-table{width:100%;border-collapse:collapse;min-width:720px}.mee-v361-table th,.mee-v361-table td{padding:10px 12px;border-bottom:1px solid #eef2ef;text-align:left;vertical-align:middle}.mee-v361-table th{font-size:10.5px;text-transform:uppercase;letter-spacing:.055em;color:#7e8d85;background:#fafcfb}.mee-v361-table td:nth-last-child(-n+2),.mee-v361-table th:nth-last-child(-n+2){text-align:right}.mee-v361-table tr:last-child td{border-bottom:0}.mee-money-pending{font-weight:800;color:#9a6513}.mee-money-settled{font-weight:800;color:#166d50}
.mee-chart-grid.mee-v361-charts{display:grid!important;grid-template-columns:1fr!important;gap:12px!important;margin:14px 0 0!important}
.mee-v361-chart-card{border:1px solid #e9eeeb;border-radius:16px;background:linear-gradient(145deg,#fff,#fafdfb);padding:14px}.mee-v361-chart-head{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.mee-v361-chart-head b{font-size:13px}.mee-v361-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:10.5px;color:#718078}.mee-v361-legend span{display:inline-flex;align-items:center;gap:5px}.mee-v361-dot{width:8px;height:8px;border-radius:99px;display:inline-block}.mee-v361-dot.pending{background:#e4b04c}.mee-v361-dot.settled{background:#3c9873}
.mee-v361-bars{display:grid;gap:11px}.mee-v361-sale-row{display:grid;grid-template-columns:140px minmax(0,1fr) 180px;gap:10px;align-items:center;min-width:0}.mee-v361-sale-name{font-size:11.5px;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mee-v361-pair{display:grid;gap:5px}.mee-v361-track{height:7px;border-radius:99px;background:#f0f1ed;overflow:hidden}.mee-v361-fill{height:100%;border-radius:99px}.mee-v361-fill.pending{background:#e4b04c}.mee-v361-fill.settled{background:#3c9873}.mee-v361-values{font-size:10.5px;color:#75827c;text-align:right;white-space:nowrap}.mee-v361-empty{padding:20px;text-align:center;color:#8b9891;font-size:12px}

@media(max-width:760px){
  .mee-dashboard-summary{grid-template-columns:minmax(0,1fr)!important}
  .mee-summary-main{font-size:23px}
  .mee-v361-sale-row{grid-template-columns:100px minmax(0,1fr)!important}.mee-v361-values{grid-column:1/-1;text-align:left;padding-left:110px;white-space:normal}
  .mee-v361-report-card{padding:13px}
}
`;
    document.head.appendChild(style);
  }

  function buildSummary(r,el){
    var s=r.summary||{},grid=qs('.stat-grid-5',el);if(!grid)return;
    var total=Number(s.orders||0),waiting=Number(s['Chờ bó']||0),delivered=Number(s['Đã giao']||0),notDelivered=Math.max(0,total-delivered);
    var pending=Number(s.unsettledRevenue||0),settled=Number(s.settledRevenue||0),debt=Number(s.debt||0);
    var sig=[total,waiting,notDelivered,pending,settled,debt].join('|');
    if(grid.dataset.v361Sig===sig)return;
    grid.classList.add('mee-dashboard-summary');
    grid.innerHTML=''+
      '<article class="mee-summary-card orders"><div class="mee-summary-kicker">Đơn hàng</div><div class="mee-summary-main">'+total+' đơn</div><div class="mee-summary-mini-grid"><div class="mee-summary-mini"><span>Chờ bó</span><b>'+waiting+'</b></div><div class="mee-summary-mini"><span>Chưa giao</span><b>'+notDelivered+'</b></div></div></article>'+
      '<article class="mee-summary-card revenue"><div class="mee-summary-kicker">Doanh thu</div><div class="mee-revenue-lines"><div class="mee-revenue-line pending"><span>Chưa tất toán</span><b>'+money(pending)+'</b></div><div class="mee-revenue-line settled"><span>Đã tất toán</span><b>'+money(settled)+'</b></div></div></article>'+
      '<article class="mee-summary-card debt"><div class="mee-summary-kicker">Công nợ chưa thu</div><div class="mee-summary-main">'+money(debt)+'</div><div class="mee-debt-note">Theo số tiền còn phải thu trên các đơn chưa khóa đối soát.</div></article>';
    grid.dataset.v361Sig=sig;
  }

  function aggregateSales(items){
    var map=new Map();
    (items||[]).forEach(function(x){
      var key=x.sale||'Chưa gán',v=map.get(key)||{sale:key,pending:0,settled:0,orders:0};
      v.pending+=Number(x.unsettledRevenue||0);v.settled+=Number(x.settledRevenue||x.revenue||0);v.orders+=Number(x.orders||0);map.set(key,v)
    });
    return Array.from(map.values()).sort(function(a,b){return (b.pending+b.settled)-(a.pending+a.settled)||a.sale.localeCompare(b.sale,'vi')})
  }

  function buildChart(items){
    var sales=aggregateSales(items),max=Math.max(1,...sales.map(function(x){return Math.max(x.pending,x.settled)}));
    if(!sales.length)return '<div class="mee-v361-chart-card"><div class="mee-v361-chart-head"><b>Biểu đồ doanh thu theo nhân viên</b></div><div class="mee-v361-empty">Chưa có dữ liệu doanh thu trong khoảng đang chọn.</div></div>';
    var rows=sales.map(function(x){
      var pw=clamp(x.pending/max*100,0,100),sw=clamp(x.settled/max*100,0,100);
      return '<div class="mee-v361-sale-row"><div class="mee-v361-sale-name">'+esc(x.sale)+'</div><div class="mee-v361-pair"><div class="mee-v361-track"><div class="mee-v361-fill pending" style="width:'+pw.toFixed(1)+'%"></div></div><div class="mee-v361-track"><div class="mee-v361-fill settled" style="width:'+sw.toFixed(1)+'%"></div></div></div><div class="mee-v361-values">'+money(x.pending)+' · '+money(x.settled)+'</div></div>'
    }).join('');
    return '<div class="mee-v361-chart-card"><div class="mee-v361-chart-head"><b>Biểu đồ doanh thu theo nhân viên</b><div class="mee-v361-legend"><span><i class="mee-v361-dot pending"></i>Chưa tất toán</span><span><i class="mee-v361-dot settled"></i>Đã tất toán</span></div></div><div class="mee-v361-bars">'+rows+'</div></div>';
  }

  function buildReport(r,el){
    var items=Array.isArray(r.salesDaily)?r.salesDaily:[];
    var sig=JSON.stringify(items.map(function(x){return[x.date,x.sale,x.orders,x.unsettledRevenue,x.settledRevenue]}));
    var section=qs('.mee-sales-daily-section',el);
    if(!section){section=document.createElement('section');section.className='mee-sales-daily-section';el.appendChild(section)}
    if(section.dataset.v361Sig!==sig){
      var rows=items.map(function(x){
        return '<tr><td>'+esc(dateVN(x.date))+'</td><td><b>'+esc(x.sale||'Chưa gán')+'</b></td><td>'+Number(x.orders||0)+' đơn</td><td class="mee-money-pending">'+money(x.unsettledRevenue||0)+'</td><td class="mee-money-settled">'+money(x.settledRevenue||x.revenue||0)+'</td></tr>'
      }).join('');
      section.innerHTML='<div class="mee-v361-report-card"><div class="mee-v361-report-head"><div><h3>Báo cáo doanh thu theo nhân viên / ngày</h3><div class="sub">Bảng trên trước, biểu đồ bên dưới để đối chiếu nhanh doanh thu chưa và đã tất toán.</div></div><span class="mee-v361-rule">Tách trạng thái đối soát</span></div><div class="mee-v361-table-wrap"><table class="mee-v361-table"><thead><tr><th>Ngày</th><th>Nhân viên</th><th>Số đơn</th><th>Chưa tất toán</th><th>Đã tất toán</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5" class="mee-v361-empty">Chưa có dữ liệu trong khoảng đang chọn.</td></tr>')+'</tbody></table></div><div class="mee-chart-grid mee-v361-charts">'+buildChart(items)+'</div></div>';
      section.dataset.v361Sig=sig;
    }
    el.appendChild(section);
  }

  function patchDashboard(){
    if(!window.S||S.page!=='dashboard')return;
    var r=S.data&&S.data.dashboard,el=qs('#content');if(!r||!el)return;
    buildSummary(r,el);
    qsa('.mee-chart-grid',el).forEach(function(x){if(!x.classList.contains('mee-v361-charts'))x.remove()});
    buildReport(r,el);
  }

  function patchFit(){
    document.documentElement.classList.add('mee-v361');
    var top=qs('.topbar');if(top){top.style.setProperty('left','0','important');top.style.setProperty('right','0','important');top.style.setProperty('width','100%','important')}
  }

  function patchAll(){injectStyles();patchFit();patchDashboard()}
  var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(patchAll,45)}
  var observer=new MutationObserver(function(ms){if(ms.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)}))schedule()});
  function init(){patchAll();var content=qs('#content');if(content)observer.observe(content,{childList:true,subtree:true});document.addEventListener('click',function(e){if(e.target.closest('[data-p]'))setTimeout(patchAll,0)},true)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
