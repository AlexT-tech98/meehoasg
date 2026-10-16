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

  var privacy={key:'',hidden:{}};
  function privacyState(){
    var key='mee-dashboard-money:'+String(window.S&&S.user&&S.user.username||'');
    if(privacy.key!==key){privacy.key=key;privacy.hidden={};try{var value=JSON.parse(localStorage.getItem(key)||'{}');['revenue','average','debt','staff'].forEach(function(k){privacy.hidden[k]=value&&value[k]===true;});}catch(_){}}
    return privacy.hidden;
  }
  function moneyToggle(key,label){
    var hidden=!!privacyState()[key],action=(hidden?'Hiện số tiền: ':'Ẩn số tiền: ')+label;
    return '<button type="button" class="mee-money-toggle" data-dashboard-money="'+key+'" aria-pressed="'+hidden+'" aria-label="'+esc(action)+'" title="'+esc(action)+'">'+
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'+(hidden?'<path d="m3 3 18 18"/>':'')+'</svg></button>';
  }
  var hourlyState={dashboardRef:null,countsRef:null,day:'',rows:null,unknown:0,total:0,loading:false,error:'',request:0};
  function hourlyModel(items){
    var map={};(items||[]).forEach(function(o){var m=String(o&&o.time||'').match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/);var h=m?Number(m[1]):-1;if(h<0||h>23)return;map[h]=(map[h]||0)+1;});
    var hours=Object.keys(map).map(Number).sort(function(a,b){return a-b}),max=Math.max.apply(null,hours.map(function(h){return map[h]}).concat([0]));
    return hours.map(function(h){return {hour:h,label:hourLabel(h),count:map[h],percent:max?map[h]/max*100:0}});
  }
  function hourlyHtml(rows){
    var pairs={},max=0;(rows||[]).forEach(function(x){var group=Math.floor(Number(x.hour)/2)*2;pairs[group]=(pairs[group]||0)+Number(x.count||0);});
    var keys=Object.keys(pairs).map(Number).filter(function(k){return pairs[k]>0}).sort(function(a,b){return a-b});keys.forEach(function(k){max=Math.max(max,pairs[k])});
    return '<div class="mee-approved-hour-chart">'+keys.map(function(k){var count=pairs[k],height=max?Math.max(4,Math.round(count/max*100)):0;return '<div class="mee-approved-hour-item" data-hour-count="'+count+'"><b>'+count+'</b><div class="mee-approved-hour-column '+(count===max?'peak':'')+'" style="height:'+height+'%"></div><small>'+String(k).padStart(2,'0')+'–'+String(k+2).padStart(2,'0')+'</small></div>';}).join('')+'</div>';
  }
  function hourSection(el){var section=qs('#meeHourlySingleV361',el);if(!section){section=document.createElement('section');section.id='meeHourlySingleV361';section.className='mee-hour-card';var grid=qs('.stat-grid-5',el);if(grid)grid.insertAdjacentElement('afterend',section);else el.insertBefore(section,el.firstChild)}return section;}
  function renderHourly(el){
    if(!el)return;var section=hourSection(el),rows=hourlyState.rows||[],html='',sig='';if(section.classList)section.classList.add('mee-approved-analytics-hours');
    if(hourlyState.loading){sig='loading';html='<div class="mee-approved-subtitle">Đang tải dữ liệu đơn hàng…</div>';}
    else if(hourlyState.error){sig='error|'+hourlyState.error;html='<div class="mee-v361-empty">'+esc(hourlyState.error)+' <button type="button" class="btn secondary" onclick="MEE_DASHBOARD_V361_RETRY()">Thử lại</button></div>';}
    else{sig='rows|'+rows.map(function(x){return x.hour+':'+x.count}).join(',')+'|'+hourlyState.unknown+'|'+hourlyState.total;
      html=rows.length?hourlyHtml(rows):'<div class="mee-v361-empty">Chưa có đơn có giờ nhận trong kỳ.</div>';
      if(hourlyState.unknown)html+='<div class="mee-hour-unknown">Chưa rõ giờ nhận: <b>'+hourlyState.unknown+' đơn</b></div>';
      var counted=rows.reduce(function(n,x){return n+Number(x.count||0);},0)+hourlyState.unknown;
      html+='<div class="mee-approved-footnote" data-hourly-total="'+counted+'">Đã thống kê '+counted+'/'+hourlyState.total+' đơn</div>';
    }
    sig=hourlyState.day+'|'+sig;if(section.dataset.v361HourlySig===sig)return;section.dataset.v361HourlySig=sig;
    var dates=hourlyState.day.split('|'),period=dates[0]===dates[1]?dateVN(dates[0]):dateVN(dates[0])+' – '+dateVN(dates[1]);
    section.innerHTML='<div class="mee-approved-panel"><div class="mee-approved-title">Đơn hàng theo khung giờ</div><div class="mee-approved-subtitle">Theo giờ nhận hoa · '+esc(period)+' · Cùng kỳ với tổng đơn</div>'+html+'</div>';
  }
  function dashboardRange(){var r=S.data&&S.data.dashboard||{},f=S.filters&&S.filters.dashboard||{},range=r.range||f;return {start:range.start||today(),end:range.end||range.start||today()};}
  function useHourly(r,key){hourlyState.day=key;hourlyState.rows=(r.hourlyCounts||[]).map(function(x){return {hour:x.hour,label:hourLabel(x.hour),count:Number(x.count)||0};});hourlyState.unknown=Number(r.hourlyUnknown)||0;hourlyState.total=Number(r.summary&&r.summary.orders)||0;hourlyState.countsRef=r.hourlyCounts;hourlyState.error='';hourlyState.loading=false;}
  async function loadHourly(el,force){
    if(!window.gas||!window.S||S.page!=='dashboard')return;var r=S.data.dashboard||{},range=dashboardRange(),key=range.start+'|'+range.end;
    if(!force&&Array.isArray(r.hourlyCounts)&&r.hourlyScope==='SELECTED_RANGE'){hourlyState.request++;useHourly(r,key);renderHourly(el);return;}
    if(hourlyState.loading&&hourlyState.day===key)return;
    var request=++hourlyState.request;hourlyState.loading=true;hourlyState.day=key;hourlyState.rows=null;hourlyState.error='';renderHourly(el);
    try{var result=await window.gas('getDashboardSummary',{start:range.start,end:range.end});if(request!==hourlyState.request)return;
      if(!result||!result.ok||!Array.isArray(result.hourlyCounts)||result.hourlyScope!=='SELECTED_RANGE')throw new Error('Chưa tải đủ thống kê theo kỳ. Vui lòng thử lại.');
      if(S.page!=='dashboard'||dashboardRange().start+'|'+dashboardRange().end!==key)return;
      S.data.dashboard=result;hourlyState.dashboardRef=result;useHourly(result,key);patchDashboard();
    }catch(e){if(request===hourlyState.request)hourlyState.error=e&&e.message?e.message:'Không tải được thống kê đơn hàng theo giờ.';}
    finally{if(request===hourlyState.request){hourlyState.loading=false;if(window.S&&S.page==='dashboard')renderHourly(qs('#content'));}}
  }
  window.MEE_DASHBOARD_V361_RETRY=function(){loadHourly(qs('#content'),true)};

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
    var hidden=privacyState();var sig=JSON.stringify([items,hidden]);
    if(grid._meeApprovedSig===sig)return;
    grid.classList.add('mee-dashboard-summary','mee-approved-summary');
    grid.innerHTML=items.map(function(x){
      var monetary=['revenue','average','debt'].includes(x[3]);
      return '<article class="mee-approved-kpi '+x[3]+'"><div class="mee-kpi-heading"><div class="mee-approved-kpi-label">'+esc(x[0])+'</div>'+(monetary?moneyToggle(x[3],x[0]):'')+'</div>'+
      '<div class="mee-approved-kpi-value">'+(monetary&&hidden[x[3]]?'••••••':esc(x[1]))+'</div>'+
      '<div class="mee-approved-kpi-note">'+esc(x[2])+'</div></article>';
    }).join('');
    grid._meeApprovedSig=sig;
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
    var hidden=!!privacyState().staff;var sig=JSON.stringify([rows,hidden]);
    if(section._meeApprovedSig===sig)return;
    var top=Math.max.apply(null,[1].concat(rows.map(function(x){return x.settled+x.unsettled})));
    section.innerHTML='<div class="mee-approved-panel">'+
      '<div class="mee-kpi-heading"><div class="mee-approved-title">Doanh thu theo nhân viên</div>'+moneyToggle('staff','Doanh thu theo nhân viên')+'</div>'+
      '<div class="mee-approved-subtitle">Giá trị đơn theo Sale · Đã và chưa tất toán</div>'+
      (rows.length?rows.map(function(x){
        var total=x.settled+x.unsettled;
        return '<div class="mee-approved-staff-row"><span class="mee-approved-staff-name">'+esc(x.sale)+'</span>'+
          '<div class="mee-approved-track" role="img" aria-label="'+esc(x.sale)+': '+(hidden?'Doanh thu đã ẩn':money(total))+'"><div style="width:'+Math.max(0,Math.min(100,total/top*100)).toFixed(1)+'%"></div></div>'+
          '<b>'+x.orders+' đơn · '+(hidden?'••••••':money(total))+'</b></div>';
      }).join(''):'<div class="mee-v361-empty">Chưa có dữ liệu doanh thu theo nhân viên trong kỳ.</div>')+
      '<div class="mee-approved-footnote">Doanh thu đơn hàng, không phải hoa hồng · Theo kỳ đang chọn</div></div>';
    section._meeApprovedSig=sig;
  }

  function patchDashboard(){
    if(!window.S||S.page!=='dashboard')return;
    var r=S.data&&S.data.dashboard,el=qs('#content');if(!r||!el)return;
    buildSummary(r,el);buildReport(r,el);
    var pageHead=qs('.page-header',el);
    if(pageHead){
      var h=qs('h1',pageHead);if(h)h.textContent='Một ngày ở Meehoasg.';
      var sub=qs('.sub',pageHead);if(sub)sub.textContent='';
      pageHead.classList.add('mee-atelier-dashboard-header');
    }
    if(pageHead)pageHead.classList.add('mee-approved-page-header');
    if(hourlyState.dashboardRef!==r||hourlyState.countsRef!==r.hourlyCounts){hourlyState.dashboardRef=r;loadHourly(el,false)}else renderHourly(el);
  }

  window.MEE_DASHBOARD_V361_RENDER=patchDashboard;
  document.addEventListener('click',function(e){var button=e.target.closest&&e.target.closest('[data-dashboard-money]');if(!button||!window.S||S.page!=='dashboard'||!qs('#content').contains(button))return;var key=button.getAttribute('data-dashboard-money');if(!['revenue','average','debt','staff'].includes(key))return;var state=privacyState();state[key]=!state[key];try{localStorage.setItem(privacy.key,JSON.stringify(state));}catch(_){}patchDashboard();});
  if(window.__MEE_TEST_MODE__)window.__MEE_DASHBOARD_V361_TEST__={hourlyModel:hourlyModel,hourlyHtml:hourlyHtml,renderHourly:renderHourly,hourlyState:hourlyState};

  var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(patchDashboard,45)}
  function init(){patchDashboard();var content=qs('#content');if(content)new MutationObserver(function(ms){if(ms.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)}))schedule()}).observe(content,{childList:true,subtree:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
