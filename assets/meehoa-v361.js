/* Canonical runtime owner: dashboard summary, hourly tracking + sales/day report. */
(function(){
  'use strict';
  window.__MEE_DASHBOARD_V361__=true;
  function qs(s,r){return (r||document).querySelector(s)}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function money(n){return new Intl.NumberFormat('vi-VN').format(Number(n)||0)+' đ'}
  function dateVN(iso){if(!iso)return'';var p=String(iso).split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:iso}
  function today(){var d=new Date(),p=function(n){return String(n).padStart(2,'0')};return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())}
  function hourLabel(h){var x=String(h).padStart(2,'0');return x+':00–'+x+':59'}

  var hourlyState={dashboardRef:null,day:'',rows:null,loading:false,error:''};

  function hourlyModel(items){
    var map={};
    (items||[]).forEach(function(o){
      var m=String(o&&o.time||'').match(/^(\d{1,2}):/);if(!m)return;
      var h=Number(m[1]);if(h<0||h>23)return;
      map[h]=(map[h]||0)+1;
    });
    var hours=Object.keys(map).map(Number).sort(function(a,b){return a-b});
    if(!hours.length)return[];
    var max=Math.max.apply(null,hours.map(function(h){return map[h]}));
    return hours.map(function(h){return {hour:h,label:hourLabel(h),count:map[h],percent:max?map[h]/max*100:0}});
  }

  function hourlyHtml(rows){
    var pairs={},max=0;
    (rows||[]).forEach(function(x){
      var group=Math.floor(Number(x.hour)/2)*2;
      pairs[group]=(pairs[group]||0)+Number(x.count||0);
    });
    var keys=Object.keys(pairs).map(Number).filter(function(k){return pairs[k]>0}).sort(function(a,b){return a-b});
    keys.forEach(function(k){max=Math.max(max,pairs[k])});
    return '<div class="mee-approved-hour-chart">'+keys.map(function(k){
      var count=pairs[k],height=max?Math.max(4,Math.round(count/max*100)):0;
      return '<div class="mee-approved-hour-item"><b>'+count+'</b><div class="mee-approved-hour-column '+(count===max?'peak':'')+'" style="height:'+height+'%"></div>'+
      '<small>'+String(k).padStart(2,'0')+'–'+String(k+2).padStart(2,'0')+'</small></div>';
    }).join('')+'</div>';
  }

  function hourSection(el){
    var section=qs('#meeHourlySingleV361',el);
    if(!section){section=document.createElement('section');section.id='meeHourlySingleV361';section.className='mee-hour-card';var grid=qs('.stat-grid-5',el);if(grid)grid.insertAdjacentElement('afterend',section);else el.insertBefore(section,el.firstChild)}
    return section;
  }

  function renderHourly(el){
    if(!el)return;
    var section=hourSection(el),rows=hourlyState.rows||[],html='',sig='';
    section.classList.add('mee-approved-analytics-hours');
    if(hourlyState.loading&&!rows.length){sig='loading';html='<div class="mee-approved-subtitle">Đang tải dữ liệu đơn hàng…</div>'}
    else if(hourlyState.error){sig='error|'+hourlyState.error;html='<div class="mee-v361-empty">'+esc(hourlyState.error)+' <button type="button" class="btn secondary" onclick="MEE_DASHBOARD_V361_RETRY()">Thử lại</button></div>'}
    else if(!rows.length){sig='empty';html='<div class="mee-v361-empty">Hôm nay chưa có đơn có giờ nhận.</div>'}
    else {sig='rows|'+rows.map(function(x){return x.hour+':'+x.count}).join(',');html=hourlyHtml(rows)}
    if(section.dataset.v361HourlySig===sig)return;
    section.dataset.v361HourlySig=sig;
    section.innerHTML='<div class="mee-approved-panel"><div class="mee-approved-title">Đơn hàng theo khung giờ</div>'+
      '<div class="mee-approved-subtitle">Theo giờ nhận hoa hôm nay · Chỉ hiện khung có đơn</div>'+html+'</div>';
  }

  async function loadHourly(el,force){
    if(!window.gas||!window.S||S.page!=='dashboard')return;
    var day=today();
    if(!force&&hourlyState.day===day&&hourlyState.rows){renderHourly(el);return}
    if(hourlyState.loading)return;
    hourlyState.loading=true;hourlyState.day=day;hourlyState.error='';renderHourly(el);
    try{
      var r=await window.gas('getOrders',{start:day,end:day,page:1,pageSize:200,q:''});
      if(!r||!r.ok)throw new Error(r&&r.message?r.message:'Không nhận được dữ liệu đơn hàng.');
      hourlyState.rows=hourlyModel(r.items||[]);hourlyState.error='';
    }catch(e){hourlyState.rows=null;hourlyState.error=e&&e.message?e.message:'Không tải được thống kê đơn hàng theo giờ.'}
    finally{hourlyState.loading=false;if(window.S&&S.page==='dashboard')renderHourly(qs('#content'))}
  }

  window.MEE_DASHBOARD_V361_RETRY=function(){hourlyState.rows=null;hourlyState.error='';hourlyState.day='';loadHourly(qs('#content'),true)};

  function buildSummary(r,el){
    var s=r.summary||{},grid=qs('.stat-grid-5',el);if(!grid)return;
    var orders=Number(s.orders||0),delivered=Number(s['Đã giao']||0);
    var revenue=Number(s.revenue||0);
    if(!revenue)revenue=Number(s.settledRevenue||0)+Number(s.unsettledRevenue||0);
    var debt=Number(s.debt||0);
    var items=[
      ['Doanh thu đơn hàng',money(revenue),'Tổng giá trị đơn trong kỳ','revenue'],
      ['Tổng đơn hàng',String(orders),'Theo khoảng ngày đã chọn','orders'],
      ['Trung bình / đơn',orders?money(Math.round(revenue/orders)):'0 đ','Giá trị đơn bình quân','average'],
      ['Công nợ còn thu',money(debt),'Cần thu và đối soát','debt'],
      ['Hoàn tất giao hàng',delivered+'/'+orders,(orders?Math.round(delivered/orders*100):0)+'% đã giao','complete']
    ];
    var sig=JSON.stringify(items);
    if(grid.dataset.meeApprovedSig===sig)return;
    grid.classList.add('mee-dashboard-summary','mee-approved-summary');
    grid.innerHTML=items.map(function(x){
      return '<article class="mee-approved-kpi '+x[3]+'"><div class="mee-approved-kpi-label">'+esc(x[0])+'</div>'+
      '<div class="mee-approved-kpi-value">'+esc(x[1])+'</div>'+
      '<div class="mee-approved-kpi-note">'+esc(x[2])+'</div></article>';
    }).join('');
    grid.dataset.meeApprovedSig=sig;
  }

  function buildReport(r,el){
    var source=Array.isArray(r.salesDaily)?r.salesDaily:[];
    var grouped={};
    source.forEach(function(x){
      var sale=String(x.sale||'Chưa phân công').trim()||'Chưa phân công';
      if(!grouped[sale])grouped[sale]={sale:sale,orders:0,settled:0,unsettled:0};
      grouped[sale].orders+=Number(x.orders||0);
      grouped[sale].settled+=Number(x.settledRevenue||0);
      grouped[sale].unsettled+=Number(x.unsettledRevenue||0);
    });
    var rows=Object.keys(grouped).map(function(k){return grouped[k]});
    rows.sort(function(a,b){return b.settled+b.unsettled-a.settled-a.unsettled});
    var section=qs('.mee-sales-daily-section',el);
    if(!section){section=document.createElement('section');section.className='mee-sales-daily-section';el.appendChild(section)}
    section.classList.add('mee-approved-analytics-sales');
    var sig=JSON.stringify(rows);
    if(section.dataset.meeApprovedSig===sig)return;
    var top=Math.max.apply(null,[1].concat(rows.map(function(x){return x.settled+x.unsettled})));
    section.innerHTML='<div class="mee-approved-panel">'+
      '<div class="mee-approved-title">Doanh thu theo nhân viên</div>'+
      '<div class="mee-approved-subtitle">Giá trị đơn theo Sale · Đã và chưa tất toán</div>'+
      (rows.length?rows.map(function(x){
        var total=x.settled+x.unsettled;
        return '<div class="mee-approved-staff-row"><span class="mee-approved-staff-name">'+esc(x.sale)+'</span>'+
          '<div class="mee-approved-track" role="img" aria-label="'+esc(x.sale)+': '+money(total)+'"><div style="width:'+Math.max(0,Math.min(100,total/top*100)).toFixed(1)+'%"></div></div>'+
          '<b>'+money(total)+'</b></div>';
      }).join(''):'<div class="mee-v361-empty">Chưa có dữ liệu doanh thu theo nhân viên trong kỳ.</div>')+
      '<div class="mee-approved-footnote">Doanh thu đơn hàng, không phải hoa hồng · Theo kỳ đang chọn</div></div>';
    section.dataset.meeApprovedSig=sig;
  }

  function patchDashboard(){
    if(!window.S||S.page!=='dashboard')return;
    var r=S.data&&S.data.dashboard,el=qs('#content');if(!r||!el)return;
    buildSummary(r,el);buildReport(r,el);
    if(hourlyState.dashboardRef!==r){hourlyState.dashboardRef=r;loadHourly(el,true)}else renderHourly(el);
  }

  if(window.__MEE_TEST_MODE__)window.__MEE_DASHBOARD_V361_TEST__={hourlyModel:hourlyModel,hourlyHtml:hourlyHtml,renderHourly:renderHourly,hourlyState:hourlyState};

  var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(patchDashboard,45)}
  function init(){patchDashboard();var content=qs('#content');if(content)new MutationObserver(function(ms){if(ms.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)}))schedule()}).observe(content,{childList:true,subtree:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
