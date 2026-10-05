/* Canonical runtime owner: production date range, materials UI, quiet loading labels. */
(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function qsa(s,r){return Array.from((r||document).querySelectorAll(s))}
  function pad(n){return String(n).padStart(2,'0')}
  function todayISO(){var d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
  function dateVN2(iso){if(!iso)return'';var p=String(iso).split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:iso}
  function addDays(iso,n){var p=iso.split('-').map(Number),d=new Date(p[0],p[1]-1,p[2]);d.setDate(d.getDate()+n);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
  function eachDate(start,end){var out=[],d=start,guard=0;while(d<=end&&guard<62){out.push(d);d=addDays(d,1);guard++}return out}
  function monthStart(iso){return String(iso||todayISO()).slice(0,7)+'-01'}
  function monthShift(iso,n){var p=iso.split('-').map(Number),d=new Date(p[0],p[1]-1+n,1);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-01'}
  function monthLabel(iso){var p=iso.split('-').map(Number);return 'Tháng '+p[1]+' / '+p[0]}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function attr(s){return esc(s).replace(/`/g,'&#96;')}

  function renderMeeRangePicker(){
    var x=window._meeDatePicker,ov=qs('#overlay');if(!x||!ov)return;
    var p=x.month.split('-').map(Number),first=new Date(p[0],p[1]-1,1),last=new Date(p[0],p[1],0),offset=(first.getDay()+6)%7,cells=[];
    for(var i=0;i<offset;i++)cells.push('<span class="calendar-day out" aria-hidden="true"></span>');
    for(var d=1;d<=last.getDate();d++){
      var iso=p[0]+'-'+pad(p[1])+'-'+pad(d),cls='calendar-day';
      if(iso===todayISO())cls+=' today';
      if(iso===x.start||iso===x.end)cls+=' selected';
      else if(x.mode!=='single'&&x.start&&x.end&&iso>x.start&&iso<x.end)cls+=' in-range';
      cells.push('<button type="button" class="'+cls+'" onclick="MEEOPS7.datePickerSelect(\''+iso+'\')">'+d+'</button>');
    }
    var single=x.mode==='single',endText=x.end?dateVN2(x.end):'Chọn ngày kết thúc';
    ov.innerHTML='<div class="modal-bg mee-calendar-bg" onclick="if(event.target===this)MEEOPS7.closeOverlay()">'+
      '<div class="calendar-modal">'+
        '<div class="modal-head"><div><h3 style="margin:0">'+(single?'Chọn ngày':'Chọn khoảng ngày')+'</h3><div class="sub">'+(single?'Chọn ngày cần xem':'Chọn ngày bắt đầu, sau đó chọn ngày kết thúc')+'</div></div><button type="button" class="close" onclick="MEEOPS7.closeOverlay()">×</button></div>'+
        '<div class="calendar-shortcuts"><button type="button" class="btn" onclick="MEEOPS7.datePickerShortcut(\'today\')">Hôm nay</button>'+(single?'':'<button type="button" class="btn" onclick="MEEOPS7.datePickerShortcut(\'week\')">7 ngày</button><button type="button" class="btn" onclick="MEEOPS7.datePickerShortcut(\'month\')">Tháng này</button>')+'</div>'+
        '<div class="calendar-head"><button type="button" class="calendar-nav" onclick="MEEOPS7.datePickerMonth(-1)">‹</button><strong>'+monthLabel(x.month)+'</strong><button type="button" class="calendar-nav" onclick="MEEOPS7.datePickerMonth(1)">›</button></div>'+
        '<div class="calendar-grid"><div class="calendar-dow">T2</div><div class="calendar-dow">T3</div><div class="calendar-dow">T4</div><div class="calendar-dow">T5</div><div class="calendar-dow">T6</div><div class="calendar-dow">T7</div><div class="calendar-dow">CN</div>'+cells.join('')+'</div>'+
        (single?'':'<div class="calendar-selection '+(x.start&&!x.end?'mee-range-waiting':'')+'"><div><b>'+dateVN2(x.start)+'</b><div class="sub">Bắt đầu</div></div><span>→</span><div style="text-align:right"><b>'+endText+'</b><div class="sub">Kết thúc</div></div></div>')+
        '<div class="calendar-actions"><button type="button" class="btn" onclick="MEEOPS7.closeOverlay()">Hủy</button><button type="button" class="btn primary" '+(!x.start||(!single&&!x.end)?'disabled':'')+' onclick="MEEOPS7.datePickerApply()">Áp dụng</button></div>'+
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
      mode=mode||'range';
      var f=S.filters[key]||{},single=mode==='single',start=single?(f.date||todayISO()):(f.start||f.date||todayISO()),end=single?start:(f.end||f.date||start);
      window._meeDatePicker={key:key,mode:mode,start:start,end:end,month:monthStart(start),awaitingEnd:false,freshRange:!single};
      renderMeeRangePicker();
    };
    MEEOPS7.datePickerSelect=function(iso){
      var x=window._meeDatePicker;if(!x)return;
      if(x.mode==='single'){x.start=x.end=iso;x.freshRange=false;x.awaitingEnd=false;renderMeeRangePicker();return}
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
      var x=window._meeDatePicker;if(!x||!x.start||(x.mode!=='single'&&!x.end))return;
      var key=x.key,start=x.start,end=x.mode==='single'?x.start:x.end;
      if(S.filters[key]){if('date' in S.filters[key])S.filters[key].date=start;if('start' in S.filters[key])S.filters[key].start=start;if('end' in S.filters[key])S.filters[key].end=end}
      if(window.closeOverlay)closeOverlay();
      if(key==='production'&&x.mode!=='single'){await loadProductionRange(start,end);return}
      if(key==='orders')S.filters.orders.page=1;
      if(key==='flowers'&&window.loadFlowers)await loadFlowers(true);else if(window.loadPage)await loadPage(key,true);
    };
    return true;
  }

  function patchProductionRangeButton(){
    if(!window.S)return;var btn=qs('.production-filter .date-filter-btn');if(!btn)return;
    var f=S.filters.production||{},start=f.start||f.date,end=f.end||f.date||start;
    btn.setAttribute('onclick',"MEEOPS7.openDatePicker('production','range')");btn.textContent='▣ '+dateVN2(start)+' → '+dateVN2(end)+'　⌄';
  }

  function patchPaidCopy(root){
    root=root||document;var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),node;
    while((node=walker.nextNode()))if(node.nodeValue&&node.nodeValue.indexOf('Đã thu đủ')>=0&&node.nodeValue.indexOf('Đã thu đủ tiền hoa')<0)node.nodeValue=node.nodeValue.replace(/Đã thu đủ/g,'Đã thu đủ tiền hoa');
  }

  function materialSig(r,d){return d+'|'+(r.reviewCount||0)+'|'+(r.items||[]).map(function(x){return x.name+':'+x.orders}).join(',')}
  function renderMaterials(){
    if(!window.S||S.page!=='flowers')return;
    var d=S.filters&&S.filters.flowers&&S.filters.flowers.date,r=S.data&&S.data.flowers&&S.data.flowers[d],el=qs('#content');if(!d||!r||!el)return;
    var sig=materialSig(r,d);if(el.dataset.meeMaterialsSig===sig)return;
    var filter=qs('.date-filter-bar',el),filterHtml=filter?filter.outerHTML:'';
    var items=(r.items||[]).map(function(f){return '<button type="button" class="mee-material-card" data-material="'+attr(f.name)+'"><div class="mee-material-top"><span class="mee-material-name">'+esc(f.name)+'</span><span class="mee-material-count">'+Number(f.orders||0)+' đơn</span></div><div class="mee-material-hint">Bấm để xem danh sách đơn</div></button>'}).join('');
    var reviews=(r.reviewOrders||[]).map(function(x){return '<button type="button" class="mee-review-card" data-review-order="'+attr(x.id||'')+'"><b>'+esc(x.customer||'Chưa rõ khách')+'</b><div class="sub">'+esc((x.time||'—')+' · '+(x.flower||'Không đọc được mô tả hoa'))+'</div></button>'}).join('');
    el.innerHTML=filterHtml+'<div class="mee-materials-hero"><div><h3>Nguyên liệu AI theo đơn</h3><div class="sub">Chuẩn hóa tên hoa nhưng giữ màu / biến thể / xử lý. Mỗi số là số đơn có loại hoa đó, không phải số cành.</div></div><div class="mee-materials-summary"><span class="mee-summary-chip">'+Number(r.totalOrders||0)+' đơn</span><span class="mee-summary-chip">'+Number((r.items||[]).length)+' loại hoa</span><span class="mee-summary-chip review">'+Number(r.reviewCount||0)+' cần rà soát</span></div></div><div class="mee-materials-grid">'+(items||'<div class="empty">Chưa có nguyên liệu được nhận diện.</div>')+'</div>'+(r.reviewCount?'<section class="mee-review-panel"><div class="mee-review-head"><div><h3>Cần rà soát</h3><div class="sub">AI chưa đủ chắc chắn để tự phân loại các đơn này.</div></div><span class="mee-summary-chip review">'+Number(r.reviewCount||0)+' đơn</span></div><div class="mee-review-grid">'+reviews+'</div></section>':'');
    el.dataset.meeMaterialsSig=sig;
    qsa('[data-material]',el).forEach(function(btn){btn.addEventListener('click',function(){openMaterialDrawer(btn.dataset.material)})});
    qsa('[data-review-order]',el).forEach(function(btn){btn.addEventListener('click',function(){var id=btn.dataset.reviewOrder;if(id&&window.MEEOPS7&&MEEOPS7.openDrawer)MEEOPS7.openDrawer(id,'production')})});
  }

  function openMaterialDrawer(name){
    if(!window.S)return;var d=S.filters&&S.filters.flowers&&S.filters.flowers.date,r=S.data&&S.data.flowers&&S.data.flowers[d],ov=qs('#overlay');if(!r||!ov)return;
    var item=(r.items||[]).find(function(x){return x.name===name});if(!item)return;
    var orders=(item.orderList||[]).map(function(x){return '<article class="mee-material-order"><div class="mee-material-order-top"><div><b>'+esc(x.customer||'Chưa rõ khách')+'</b><div class="sub">'+esc((x.time||'—')+' · '+dateVN2(x.date||d))+'</div></div><span class="badge">'+esc(name)+'</span></div><div class="flower-copy">'+esc(x.flower||'')+'</div>'+(x.id?'<button type="button" class="btn" data-open-order="'+attr(x.id)+'">Mở đơn hàng</button>':'')+'</article>'}).join('');
    ov.innerHTML='<div class="drawer-bg" onclick="if(event.target===this)MEEOPS7.closeOverlay()"><aside class="drawer"><div class="drawer-head"><div><h3 style="margin:0">'+esc(name)+'</h3><div class="sub">'+Number(item.orders||0)+' đơn cần loại hoa này</div></div><button type="button" class="close" onclick="MEEOPS7.closeOverlay()">×</button></div><div class="mee-material-drawer-list">'+(orders||'<div class="empty">Không có đơn.</div>')+'</div></aside></div>';
    qsa('[data-open-order]',ov).forEach(function(btn){btn.addEventListener('click',function(){var id=btn.dataset.openOrder;if(window.MEEOPS7&&MEEOPS7.closeOverlay)MEEOPS7.closeOverlay();setTimeout(function(){if(window.MEEOPS7&&MEEOPS7.openDrawer)MEEOPS7.openDrawer(id,'production')},0)})});
  }

  function removeLoadingCopy(){document.querySelectorAll('.page-status').forEach(function(el){el.remove()});var pill=qs('.loading-pill');if(pill){Array.from(pill.childNodes).forEach(function(n){if(n.nodeType===3)n.textContent=''});pill.querySelectorAll(':scope > span:not(.spinner)').forEach(function(el){el.style.display='none'})}}
  function patch(){installRangePicker();patchProductionRangeButton();patchPaidCopy(qs('#content')||document);patchPaidCopy(qs('#overlay')||document);renderMaterials();removeLoadingCopy()}
  var timer=null;function schedule(){clearTimeout(timer);timer=setTimeout(patch,50)}
  function init(){if(window.MEEOPS7)MEEOPS7.openMaterialDrawer=openMaterialDrawer;patch();var content=qs('#content'),overlay=qs('#overlay');if(content)new MutationObserver(schedule).observe(content,{childList:true,subtree:true});if(overlay)new MutationObserver(schedule).observe(overlay,{childList:true,subtree:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
