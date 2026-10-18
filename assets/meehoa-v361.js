/* Dashboard is owned by this module. Direct render only; no DOM observer or injected UI patch. */
(function(){
  'use strict';
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
  function n(value){return Number(value)||0;}
  function money(value){return new Intl.NumberFormat('vi-VN').format(n(value))+'đ';}
  function viDate(iso){var p=String(iso||'').split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:String(iso||'');}
  function today(){var d=new Date(),pad=function(v){return String(v).padStart(2,'0');};return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
  function visibleMoney(value,key){return isHidden(key)?'••••••':money(value);}
  var preferences={user:'',values:{}};
  function readPreferences(){
    var id=String(window.S&&S.user&&S.user.username||'');
    if(preferences.user!==id){
      preferences.user=id;preferences.values={};
      try{var saved=JSON.parse(localStorage.getItem('mee-dashboard-money:'+id)||'{}');['revenue','average','debt','staff'].forEach(function(k){preferences.values[k]=saved[k]===true;});}catch(_){}
    }
    return preferences.values;
  }
  function isHidden(key){return readPreferences()[key]===true;}
  function privacyButton(key,title){
    var hidden=isHidden(key);
    return '<button type="button" class="mee-dv2-privacy" data-money-key="'+key+'" aria-pressed="'+hidden+'" aria-label="'+esc((hidden?'Hiện':'Ẩn')+' '+title)+'" title="'+esc((hidden?'Hiện':'Ẩn')+' '+title)+'">'+
      (hidden?'◉':'◎')+'</button>';
  }
  function metric(label,value,detail,key){
    return '<div class="mee-dv2-metric"><div class="mee-dv2-metric-top"><span>'+esc(label)+'</span>'+(key?privacyButton(key,label):'')+'</div>'+
      '<strong class="mee-dv2-metric-value">'+value+'</strong><span class="mee-dv2-metric-foot">'+detail+'</span></div>';
  }
  function renderMetrics(r){
    var s=r.summary||{},orders=n(s.orders),delivered=n(s['Đã giao']),revenue=n(s.revenue)||n(s.grossRevenue)||n(s.settledRevenue)+n(s.unsettledRevenue);
    var average=orders?Math.round(revenue/orders):0;
    var near=(r.attentionGroups&&r.attentionGroups.nearUnpacked||[]).length,late=(r.attentionGroups&&r.attentionGroups.packedOverdue||[]).length;
    return '<section class="mee-dv2-metrics" aria-label="Các chỉ số vận hành">'+
      metric('Đơn hàng',String(orders),'Đã giao '+delivered+' / '+orders)+
      metric('Doanh thu đơn',visibleMoney(revenue,'revenue'),'Bình quân '+visibleMoney(average,'average')+privacyButton('average','Bình quân trên đơn'), 'revenue')+
      metric('Công nợ chưa thu',visibleMoney(s.debt,'debt'),'Cần thu và đối soát','debt')+
      metric('Đơn cần ưu tiên',String(near+late),near+' sắp đến giờ · '+late+' trễ giờ')+
      '</section>';
  }
  function orderRows(r){
    var groups=r.attentionGroups||{};
    var near=Array.isArray(groups.nearUnpacked)?groups.nearUnpacked:[];
    var late=Array.isArray(groups.packedOverdue)?groups.packedOverdue:[];
    var list=near.map(function(o){return {o:o,kind:'near'};}).concat(late.map(function(o){return {o:o,kind:'late'};}));
    if(!list.length)return '<div class="mee-dv2-empty">Không có đơn cần xử lý gấp trong khoảng ngày đã chọn.</div>';
    return '<div class="mee-dv2-order-list" role="list">'+list.map(function(item){
      var o=item.o||{},flag=item.kind==='late'?'Trễ giờ':'Sắp đến giờ';
      var title=esc(o.customer||'Khách vãng lai'),subtitle=esc(o.flower||o.description||'Đơn hoa');
      return '<button class="mee-dv2-order" type="button" role="listitem" data-dashboard-order="'+esc(o.id||'')+'">'+
        '<span class="mee-dv2-order-time"><b>'+esc(o.time||'—')+'</b><small>'+esc(viDate(o.date))+'</small></span>'+
        '<span class="mee-dv2-order-info"><b>'+title+'</b><small>'+subtitle+'</small></span>'+
        '<span class="mee-dv2-order-flag '+(item.kind==='late'?'is-late':'is-near')+'">'+flag+'</span>'+
        '<span class="mee-dv2-order-chevron" aria-hidden="true">›</span></button>';
    }).join('')+'</div>';
  }
  function progress(r){
    var s=r.summary||{},total=n(s.orders),delivered=n(s['Đã giao']),packed=n(s['Đã bó']),waiting=n(s['Chờ bó']);
    var pct=function(value){return total?Math.max(0,Math.min(100,value/total*100)):0;};
    var other=Math.max(0,total-delivered-packed-waiting);
    var segments=[{title:'Đã giao',value:delivered,cls:'done'},{title:'Đã bó',value:packed,cls:'packed'},{title:'Chờ bó',value:waiting,cls:'wait'}];
    if(other)segments.push({title:'Trạng thái khác',value:other,cls:'other'});
    return '<section class="mee-dv2-panel mee-dv2-progress"><div class="mee-dv2-panel-head"><h3>Tiến độ trong ngày</h3><span>'+total+' đơn</span></div>'+
      '<div class="mee-dv2-progress-total">'+(total?Math.round(delivered/total*100):0)+'<small>% hoàn thành</small></div>'+
      '<div class="mee-dv2-progress-track" role="img" aria-label="Tiến độ hoàn thành '+delivered+' trên '+total+' đơn">'+
        segments.map(function(x){return '<span class="mee-dv2-progress-segment '+x.cls+'" style="width:'+pct(x.value).toFixed(2)+'%"></span>';}).join('')+'</div>'+
      '<div class="mee-dv2-progress-rows">'+segments.map(function(x){
        return '<div><span class="mee-dv2-dot '+x.cls+'"></span><span>'+esc(x.title)+'</span><b>'+x.value+'</b></div>';
      }).join('')+'</div>'+
      '<div class="mee-dv2-progress-footer">CMS cơ bản <b>'+visibleMoney(s.cms,'revenue')+'</b></div></section>';
  }
  function hourlyData(r){
    var a=Array.isArray(r.hourlyCounts)?r.hourlyCounts:[];
    var pairs={};a.forEach(function(x){var h=n(x.hour);if(h<0||h>23)return;var slot=Math.floor(h/2)*2;pairs[slot]=(pairs[slot]||0)+n(x.count);});
    return Object.keys(pairs).map(Number).sort(function(a,b){return a-b;}).map(function(h){return {label:String(h).padStart(2,'0')+'–'+String(h+2).padStart(2,'0'),count:pairs[h]};});
  }
  function renderHourly(r){
    var rows=hourlyData(r),max=Math.max.apply(null,[1].concat(rows.map(function(x){return x.count;})));
    var unknown=n(r.hourlyUnknown),total=n(r.summary&&r.summary.orders);
    var body=rows.length?'<div class="mee-dv2-hour-bars">'+rows.map(function(x){
      var height=Math.max(4,x.count/max*100);
      return '<div class="mee-dv2-hour"><span>'+x.count+'</span><div class="mee-dv2-hour-track"><div style="height:'+height.toFixed(1)+'%"></div></div><small>'+x.label+'</small></div>';
    }).join('')+'</div>':'<div class="mee-dv2-empty">Chưa có đơn có giờ nhận trong kỳ.</div>';
    if(unknown)body+='<div class="mee-dv2-note">Chưa rõ giờ nhận: '+unknown+' đơn</div>';
    return '<section class="mee-dv2-panel mee-dv2-hourly"><div class="mee-dv2-panel-head"><h3>Đơn theo khung giờ</h3><span>'+total+' đơn</span></div>'+body+'</section>';
  }
  function salesReport(r){
    var map=new Map();
    (r.salesDaily||[]).forEach(function(x){
      var key=String(x.saleUsername||x.sale||'Chưa phân công').trim().toLowerCase();
      var item=map.get(key)||{label:x.sale||x.saleUsername||'Chưa phân công',orders:0,settledOrders:0,unsettledOrders:0,gross:0,settled:0,unsettled:0};
      item.orders+=n(x.orders);item.settledOrders+=n(x.settledOrders);item.unsettledOrders+=n(x.unsettledOrders);
      item.gross+=n(x.grossRevenue)||n(x.settledRevenue)+n(x.unsettledRevenue);
      item.settled+=n(x.settledRevenue);item.unsettled+=n(x.unsettledRevenue);
      map.set(key,item);
    });
    var rows=Array.from(map.values()).sort(function(a,b){return b.gross-a.gross;});
    return '<section class="mee-dv2-panel mee-dv2-sales"><div class="mee-dv2-panel-head"><div><h3>Doanh thu theo Sale</h3><p>Trong khoảng ngày đã chọn</p></div>'+privacyButton('staff','Doanh thu theo Sale')+'</div>'+
      '<div class="mee-dv2-sales-scroll"><table class="mee-dv2-sales-table"><thead><tr><th>Sale</th><th>Đơn</th><th>Đã xác nhận</th><th>Chưa xác nhận</th><th>Tổng tiền hoa</th><th>Doanh thu xác nhận</th></tr></thead><tbody>'+
      (rows.length?rows.map(function(x){return '<tr><td><b>'+esc(x.label)+'</b></td><td>'+x.orders+'</td><td>'+x.settledOrders+'</td><td>'+x.unsettledOrders+'</td><td>'+visibleMoney(x.gross,'staff')+'</td><td>'+visibleMoney(x.settled,'staff')+'</td></tr>';}).join(''):'<tr><td colspan="6">Không có dữ liệu trong kỳ.</td></tr>')+
      '</tbody></table></div></section>';
  }
  function render(){
    if(!window.S||S.page!=='dashboard')return;
    var el=document.getElementById('content'),r=S.data&&S.data.dashboard;
    if(!el||!r)return;
    var root=el.querySelector('#meeDashboardV2');
    if(!root)return;
    var range=S.filters&&S.filters.dashboard||{},dates=viDate(range.start||today())+(range.end&&range.end!==range.start?' – '+viDate(range.end):'');
    root.innerHTML='<div class="mee-dv2">'+
      '<div class="mee-dv2-context"><span>TÌNH HÌNH VẬN HÀNH</span><span>'+esc(dates)+'</span></div>'+
      renderMetrics(r)+
      '<div class="mee-dv2-primary"><section class="mee-dv2-panel mee-dv2-attention"><div class="mee-dv2-panel-head"><h3>Cần xử lý</h3><span>Ưu tiên theo thời gian</span></div>'+orderRows(r)+'</section>'+progress(r)+'</div>'+
      '<div class="mee-dv2-secondary">'+renderHourly(r)+salesReport(r)+'</div></div>';
  }
  document.addEventListener('click',function(event){
    var target=event.target.closest&&event.target.closest('#meeDashboardV2 [data-money-key],#meeDashboardV2 [data-dashboard-order]');
    if(!target||!window.S||S.page!=='dashboard')return;
    if(target.dataset.dashboardOrder){
      if(window.MEEOPS7&&MEEOPS7.openDrawer)MEEOPS7.openDrawer(target.dataset.dashboardOrder,'dashboard');
      return;
    }
    var key=target.dataset.moneyKey;if(!['revenue','average','debt','staff'].includes(key))return;
    var values=readPreferences();values[key]=!values[key];
    try{localStorage.setItem('mee-dashboard-money:'+preferences.user,JSON.stringify(values));}catch(_){}
    render();
  });
  window.MEE_DASHBOARD_RENDER=render;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render);else render();
  if(window.__MEE_TEST_MODE__)window.__MEE_DASHBOARD_TEST__={hourlyData:hourlyData,renderMetrics:renderMetrics};
})();