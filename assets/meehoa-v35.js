(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function pad(n){return String(n).padStart(2,'0')}
  function todayISO(){var d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
  function dateVN2(iso){if(!iso)return'';var p=String(iso).split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:iso}
  function addDays(iso,n){var p=iso.split('-').map(Number),d=new Date(p[0],p[1]-1,p[2]);d.setDate(d.getDate()+n);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
  function eachDate(start,end){var out=[],d=start,guard=0;while(d<=end&&guard<62){out.push(d);d=addDays(d,1);guard++}return out}
  function monthStart(iso){return String(iso||todayISO()).slice(0,7)+'-01'}
  function monthShift(iso,n){var p=iso.split('-').map(Number),d=new Date(p[0],p[1]-1+n,1);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-01'}
  function monthLabel(iso){var p=iso.split('-').map(Number);return 'Tháng '+p[1]+' / '+p[0]}

  function renderMeeRangePicker(){
    var x=window._meeDatePicker,ov=qs('#overlay');if(!x||!ov)return;
    var p=x.month.split('-').map(Number),first=new Date(p[0],p[1]-1,1),last=new Date(p[0],p[1],0),offset=(first.getDay()+6)%7;
    var cells=[];
    for(var i=0;i<offset;i++)cells.push('<span class="calendar-day out" aria-hidden="true"></span>');
    for(var d=1;d<=last.getDate();d++){
      var iso=p[0]+'-'+pad(p[1])+'-'+pad(d),cls='calendar-day';
      if(iso===todayISO())cls+=' today';
      if(iso===x.start||iso===x.end)cls+=' selected';
      else if(x.start&&x.end&&iso>x.start&&iso<x.end)cls+=' in-range';
      cells.push('<button type="button" class="'+cls+'" onclick="MEEOPS7.datePickerSelect(\''+iso+'\')">'+d+'</button>');
    }
    var endText=x.end?dateVN2(x.end):'Chọn ngày kết thúc';
    ov.innerHTML='<div class="modal-bg mee-calendar-bg" onclick="if(event.target===this)MEEOPS7.closeOverlay()">'+
      '<div class="calendar-modal">'+
        '<div class="modal-head"><div><h3 style="margin:0">Chọn khoảng ngày</h3><div class="sub">Chọn ngày bắt đầu, sau đó chọn ngày kết thúc</div></div><button type="button" class="close" onclick="MEEOPS7.closeOverlay()">×</button></div>'+
        '<div class="calendar-shortcuts"><button type="button" class="btn" onclick="MEEOPS7.datePickerShortcut(\'today\')">Hôm nay</button><button type="button" class="btn" onclick="MEEOPS7.datePickerShortcut(\'week\')">7 ngày</button><button type="button" class="btn" onclick="MEEOPS7.datePickerShortcut(\'month\')">Tháng này</button></div>'+
        '<div class="calendar-head"><button type="button" class="calendar-nav" onclick="MEEOPS7.datePickerMonth(-1)">‹</button><strong>'+monthLabel(x.month)+'</strong><button type="button" class="calendar-nav" onclick="MEEOPS7.datePickerMonth(1)">›</button></div>'+
        '<div class="calendar-grid"><div class="calendar-dow">T2</div><div class="calendar-dow">T3</div><div class="calendar-dow">T4</div><div class="calendar-dow">T5</div><div class="calendar-dow">T6</div><div class="calendar-dow">T7</div><div class="calendar-dow">CN</div>'+cells.join('')+'</div>'+
        '<div class="calendar-selection '+(x.start&&!x.end?'mee-range-waiting':'')+'"><div><b>'+dateVN2(x.start)+'</b><div class="sub">Bắt đầu</div></div><span>→</span><div style="text-align:right"><b>'+endText+'</b><div class="sub">Kết thúc</div></div></div>'+
        '<div class="calendar-actions"><button type="button" class="btn" onclick="MEEOPS7.closeOverlay()">Hủy</button><button type="button" class="btn primary" '+(!x.start||!x.end?'disabled':'')+' onclick="MEEOPS7.datePickerApply()">Áp dụng</button></div>'+
      '</div></div>';
  }

  async function loadProductionRange(start,end){
    if(!window.gas||!window.S||!window.renderProduction)return;
    var dates=eachDate(start,end);
    try{
      var responses=await Promise.all(dates.map(function(date){return gas('getProductionOrders',{date:date})}));
      var orders=[],seen=new Set(),base=null;
      responses.forEach(function(raw){var r=(window.validateBuild?validateBuild(raw):raw)||{};if(!base&&r)base=Object.assign({},r);(r.orders||[]).forEach(function(o){var k=o.id||[o.date,o.time,o.customer].join('|');if(!seen.has(k)){seen.add(k);orders.push(o)}})});
      orders.sort(function(a,b){return (String(a.date||'')+' '+String(a.time||'')).localeCompare(String(b.date||'')+' '+String(b.time||''))});
      S.data.production=Object.assign({},base||{ok:true},{orders:orders,rangeStart:start,rangeEnd:end});
      if(window.rememberOrders)rememberOrders(orders);
      renderProduction();patchProductionRangeButton();
    }catch(e){if(window.toast)toast(e&&e.message?e.message:'Không tải được khoảng ngày sản xuất.',1)}
  }

  function installRangePicker(){
    if(!window.MEEOPS7||!window.S)return false;
    MEEOPS7.openDatePicker=function(key,mode){
      var f=S.filters[key]||{},start=f.start||f.date||todayISO(),end=f.end||f.date||start;
      window._meeDatePicker={key:key,mode:'range',start:start,end:end,month:monthStart(start),awaitingEnd:false,freshRange:true};
      renderMeeRangePicker();
    };
    MEEOPS7.datePickerSelect=function(iso){
      var x=window._meeDatePicker;if(!x)return;
      if(x.freshRange||!x.start||x.end){x.start=iso;x.end='';x.freshRange=false;x.awaitingEnd=true}
      else{if(iso<x.start){x.end=x.start;x.start=iso}else{x.end=iso}x.awaitingEnd=false}
      renderMeeRangePicker();
    };
    MEEOPS7.datePickerMonth=function(delta){var x=window._meeDatePicker;if(!x)return;x.month=monthShift(x.month,delta);renderMeeRangePicker()};
    MEEOPS7.datePickerShortcut=function(which){
      var x=window._meeDatePicker;if(!x)return;var t=todayISO();
      if(which==='today'){x.start=t;x.end=t}
      else if(which==='week'){x.start=t;x.end=addDays(t,6)}
      else{var d=new Date(),s=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-01',e=new Date(d.getFullYear(),d.getMonth()+1,0);x.start=s;x.end=e.getFullYear()+'-'+pad(e.getMonth()+1)+'-'+pad(e.getDate())}
      x.freshRange=false;x.awaitingEnd=false;x.month=monthStart(x.start);renderMeeRangePicker();
    };
    MEEOPS7.datePickerApply=async function(){
      var x=window._meeDatePicker;if(!x||!x.start||!x.end)return;
      var key=x.key,start=x.start,end=x.end;
      if(S.filters[key]){S.filters[key].start=start;S.filters[key].end=end;if('date' in S.filters[key])S.filters[key].date=start}
      if(window.closeOverlay)closeOverlay();
      if(key==='production'){await loadProductionRange(start,end);return}
      if(key==='orders')S.filters.orders.page=1;
      if(key==='flowers'&&window.loadFlowers)await loadFlowers(true);
      else if(window.loadPage)await loadPage(key,true);
    };
    return true;
  }

  function patchProductionRangeButton(){
    if(!window.S)return;var btn=qs('.production-filter .date-filter-btn');if(!btn)return;
    var f=S.filters.production||{},start=f.start||f.date,end=f.end||f.date||start;
    btn.setAttribute('onclick',"MEEOPS7.openDatePicker('production','range')");btn.textContent='▣ '+dateVN2(start)+' → '+dateVN2(end)+'　⌄';
  }
  function removeLoadingCopy(){document.querySelectorAll('.page-status').forEach(function(el){el.remove()});var pill=qs('.loading-pill');if(pill){Array.from(pill.childNodes).forEach(function(n){if(n.nodeType===3)n.textContent=''});pill.querySelectorAll(':scope > span:not(.spinner)').forEach(function(el){el.style.display='none'})}}
  var timer=null;function schedulePatch(){clearTimeout(timer);timer=setTimeout(function(){installRangePicker();patchProductionRangeButton();removeLoadingCopy()},40)}
  var mo=new MutationObserver(function(mutations){if(mutations.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)}))schedulePatch()});
  function init(){installRangePicker();patchProductionRangeButton();removeLoadingCopy();var content=qs('#content'),overlay=qs('#overlay');if(content)mo.observe(content,{childList:true,subtree:true});if(overlay)mo.observe(overlay,{childList:true,subtree:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
