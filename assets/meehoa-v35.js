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
  function money(n){return new Intl.NumberFormat('vi-VN').format(Number(n)||0)+' đ'}

  function injectV36Styles(){
    if(document.getElementById('mee-v36-style'))return;
    var style=document.createElement('style');
    style.id='mee-v36-style';
    style.textContent=`
html,body{min-height:100%!important;height:auto!important;overflow-x:hidden!important}
body:not(:has(.login:not(.hidden))){overflow-y:auto!important}
.app:not(.hidden),.main{height:auto!important;min-height:100vh!important;max-height:none!important;overflow:visible!important}
.main{padding-top:62px!important}
#content{height:auto!important;max-height:none!important;overflow:visible!important}
.topbar{position:fixed!important;top:0!important;left:228px!important;right:0!important;width:auto!important;z-index:86!important}
body.mee-page-production .ops-grid{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(360px,1fr))!important;gap:16px!important;align-items:stretch!important}
body.mee-page-production .ops-tile{grid-template-columns:84px minmax(0,1fr)!important;gap:13px!important;align-items:start!important;min-width:0!important;height:100%!important}
body.mee-page-production .ops-tile>div:last-child{min-width:0!important;display:flex!important;flex-direction:column!important;gap:4px!important}
body.mee-page-production .ops-tile .order-top{gap:10px!important;align-items:flex-start!important;min-width:0!important}
body.mee-page-production .ops-tile .order-top>b{min-width:0!important;overflow-wrap:anywhere!important;line-height:1.35!important}
body.mee-page-production .ops-thumb-wrap{width:84px!important;height:84px!important;min-width:84px!important;min-height:84px!important;overflow:hidden!important;border-radius:13px!important}
body.mee-page-production .ops-thumb-wrap img{display:block!important;width:100%!important;height:100%!important;object-fit:cover!important}
body.mee-page-production .ops-lines{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:start!important;gap:6px 12px!important;margin-top:4px!important;min-width:0!important}
body.mee-page-production .ops-lines>*{min-width:0!important;overflow-wrap:anywhere!important}
body.mee-page-production .ops-lines>.multiline{line-height:1.45!important;color:var(--text-primary)!important}
body.mee-page-production .ops-tile .actions{margin-top:auto!important;padding-top:10px!important;flex-wrap:wrap!important}
.mee-sales-daily-section{margin:18px 0 22px;padding:18px;border:1px solid rgba(21,94,71,.10);border-radius:20px;background:linear-gradient(135deg,#f7fbf9,#fff 48%,#fff8ee);box-shadow:0 10px 28px rgba(28,43,36,.05)}
.mee-sales-daily-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.mee-sales-daily-head h3{margin:0;font-size:16px}.mee-rule-badge{display:inline-flex;align-items:center;border-radius:999px;padding:5px 10px;background:#eaf8f1;color:#16704f;border:1px solid #bee8d4;font-size:11.5px;font-weight:700}
.mee-sales-table-wrap{overflow-x:auto;border:1px solid #e8ede9;border-radius:14px;background:#fff}.mee-sales-table{width:100%;border-collapse:collapse;min-width:560px}.mee-sales-table th,.mee-sales-table td{padding:11px 13px;border-bottom:1px solid #eef1ee;text-align:left}.mee-sales-table th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#7b8b83;background:#fafcfb}.mee-sales-table td:last-child,.mee-sales-table th:last-child{text-align:right}.mee-sales-table tr:last-child td{border-bottom:0}.mee-sales-money{font-weight:800;color:#145c46}
.mee-materials-hero{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin:14px 0 18px;padding:18px;border-radius:20px;background:linear-gradient(135deg,#eff9f5,#fff 52%,#fff2f5);border:1px solid rgba(21,94,71,.08)}
.mee-materials-hero h3{margin:0 0 4px;font-size:18px}.mee-materials-summary{display:flex;gap:8px;flex-wrap:wrap}.mee-summary-chip{border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;background:#fff;border:1px solid #e6ebe8}.mee-summary-chip.review{background:#fff1f2;color:#b52f4d;border-color:#ffd0d8}
.mee-materials-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px}.mee-material-card{appearance:none;text-align:left;border:1px solid #e6ebe8;border-radius:18px;background:#fff;padding:16px;min-height:118px;box-shadow:0 8px 22px rgba(30,55,45,.05);transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;cursor:pointer}.mee-material-card:hover{transform:translateY(-2px);box-shadow:0 14px 30px rgba(30,55,45,.09);border-color:#a9d8c5}.mee-material-card:focus-visible{outline:3px solid rgba(21,94,71,.18);outline-offset:2px}.mee-material-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.mee-material-name{font-size:16px;font-weight:800;line-height:1.3;color:#183329}.mee-material-count{display:inline-flex;align-items:center;justify-content:center;min-width:54px;padding:5px 9px;border-radius:999px;background:#eaf8f1;color:#166e50;border:1px solid #bee8d4;font-size:12px;font-weight:800}.mee-material-hint{margin-top:18px;font-size:12px;color:#7f8d86}.mee-material-hint:after{content:' →';font-weight:800;color:#3d745f}
.mee-review-panel{margin-top:18px;padding:17px;border-radius:20px;background:linear-gradient(135deg,#fff4f4,#fff9ed);border:1px solid #ffd3d7}.mee-review-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:12px}.mee-review-head h3{margin:0;color:#a42e45}.mee-review-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.mee-review-card{border:1px solid #ffd8da;border-radius:14px;background:rgba(255,255,255,.85);padding:12px;cursor:pointer}.mee-review-card b{display:block;margin-bottom:5px}.mee-review-card .sub{color:#8b6168}.mee-review-card:hover{border-color:#ef9fac}
.mee-material-drawer-list{display:flex;flex-direction:column;gap:10px}.mee-material-order{border:1px solid var(--border);border-radius:14px;padding:12px;background:#fff}.mee-material-order-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:6px}.mee-material-order .flower-copy{white-space:pre-wrap;color:var(--text-secondary);line-height:1.45}.mee-material-order .btn{margin-top:9px}
@media(max-width:900px){.topbar{left:0!important}.main{padding-top:62px!important}body.mee-page-production .ops-grid{grid-template-columns:minmax(0,1fr)!important}.mee-sales-daily-section,.mee-materials-hero{padding:14px!important;border-radius:16px!important}.mee-materials-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important}.mee-material-card{padding:13px!important;min-height:108px!important}}
@media(max-width:560px){body.mee-page-production .ops-tile{grid-template-columns:72px minmax(0,1fr)!important;padding:12px!important}body.mee-page-production .ops-thumb-wrap{width:72px!important;height:72px!important;min-width:72px!important;min-height:72px!important}body.mee-page-production .ops-lines{grid-template-columns:minmax(0,1fr)!important;gap:4px!important}body.mee-page-production .ops-lines>b{font-size:14px!important}.mee-materials-grid{grid-template-columns:minmax(0,1fr)!important}.mee-review-grid{grid-template-columns:minmax(0,1fr)!important}}
`;
    document.head.appendChild(style);
  }

  function renderMeeRangePicker(){
    var x=window._meeDatePicker,ov=qs('#overlay');if(!x||!ov)return;
    var p=x.month.split('-').map(Number),first=new Date(p[0],p[1]-1,1),last=new Date(p[0],p[1],0),offset=(first.getDay()+6)%7;
    var cells=[];
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

  function patchPaidCopy(root){
    root=root||document;
    var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);var node;
    while((node=walker.nextNode())){
      if(node.nodeValue&&node.nodeValue.indexOf('Đã thu đủ')>=0&&node.nodeValue.indexOf('Đã thu đủ tiền hoa')<0){node.nodeValue=node.nodeValue.replace(/Đã thu đủ/g,'Đã thu đủ tiền hoa')}
    }
  }

  function patchDashboard(){
    if(!window.S||S.page!=='dashboard')return;
    var r=S.data&&S.data.dashboard,el=qs('#content');if(!r||!el)return;
    var items=Array.isArray(r.salesDaily)?r.salesDaily:[];
    var sig=JSON.stringify(items.map(function(x){return[x.date,x.sale,x.revenue,x.orders]}));
    var old=qs('.mee-sales-daily-section',el);if(old&&old.dataset.sig===sig)return;if(old)old.remove();
    var section=document.createElement('section');section.className='mee-sales-daily-section';section.dataset.sig=sig;
    var rows=items.map(function(x){return '<tr><td>'+esc(dateVN2(x.date))+'</td><td><b>'+esc(x.sale||'Chưa gán')+'</b></td><td>'+Number(x.orders||0)+' đơn</td><td class="mee-sales-money">'+money(x.revenue)+'</td></tr>'}).join('');
    section.innerHTML='<div class="mee-sales-daily-head"><div><h3>Doanh thu theo nhân viên / ngày</h3><div class="sub">Theo dõi tiến độ Sale trên các đơn đã hoàn tất đối soát.</div></div><span class="mee-rule-badge">Chỉ tính đơn đã tất toán</span></div><div class="mee-sales-table-wrap"><table class="mee-sales-table"><thead><tr><th>Ngày</th><th>Nhân viên</th><th>Đơn đã tất toán</th><th>Doanh thu</th></tr></thead><tbody>'+(rows||'<tr><td colspan="4" class="empty">Chưa có doanh thu tất toán trong khoảng này.</td></tr>')+'</tbody></table></div>';
    var stats=qs('.stats',el);if(stats&&stats.parentNode)stats.insertAdjacentElement('afterend',section);else el.prepend(section);
  }

  function materialSig(r,d){return d+'|'+(r.reviewCount||0)+'|'+(r.items||[]).map(function(x){return x.name+':'+x.orders}).join(',')}
  function renderMaterialsV36(){
    if(!window.S||S.page!=='flowers')return;
    var d=S.filters&&S.filters.flowers&&S.filters.flowers.date,r=S.data&&S.data.flowers&&S.data.flowers[d],el=qs('#content');if(!d||!r||!el)return;
    var sig=materialSig(r,d);if(el.dataset.meeMaterialsSig===sig)return;
    var filter=qs('.date-filter-bar',el);var filterHtml=filter?filter.outerHTML:'';
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
  function patchAll(){injectV36Styles();installRangePicker();patchProductionRangeButton();patchPaidCopy(qs('#content')||document);patchPaidCopy(qs('#overlay')||document);patchDashboard();renderMaterialsV36();removeLoadingCopy()}
  var timer=null;function schedulePatch(){clearTimeout(timer);timer=setTimeout(patchAll,50)}
  var mo=new MutationObserver(function(mutations){if(mutations.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)}))schedulePatch()});
  function init(){injectV36Styles();if(window.MEEOPS7)MEEOPS7.openMaterialDrawer=openMaterialDrawer;patchAll();var content=qs('#content'),overlay=qs('#overlay');if(content)mo.observe(content,{childList:true,subtree:true});if(overlay)mo.observe(overlay,{childList:true,subtree:true})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();