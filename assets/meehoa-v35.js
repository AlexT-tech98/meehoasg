(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}
  function dateVN2(iso){
    if(!iso) return '';
    var p=String(iso).split('-');
    return p.length===3 ? p[2]+'/'+p[1]+'/'+p[0] : iso;
  }
  function addDays(iso,n){
    var p=iso.split('-').map(Number),d=new Date(p[0],p[1]-1,p[2]);
    d.setDate(d.getDate()+n);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function eachDate(start,end){
    var out=[],d=start,guard=0;
    while(d<=end && guard<62){out.push(d);d=addDays(d,1);guard++;}
    return out;
  }

  function installRangePicker(){
    if(!window.MEEOPS7 || !window.S || !window.renderDatePicker) return false;
    if(window.__meeRangeV35) return true;
    window.__meeRangeV35=true;

    MEEOPS7.openDatePicker=function(key,mode){
      mode=(key==='production')?'range':(mode||'range');
      var f=S.filters[key]||{};
      var start=mode==='single'?(f.date||today()):(f.start||f.date||today());
      var end=mode==='single'?start:(f.end||f.date||start);
      window._meeDatePicker={
        key:key,mode:mode,start:start,end:end,
        month:String(start).slice(0,7)+'-01',
        awaitingEnd:false,
        freshRange:mode==='range'
      };
      renderDatePicker();
      syncApplyState();
    };

    MEEOPS7.datePickerSelect=function(iso){
      var x=window._meeDatePicker;if(!x)return;
      if(x.mode==='single'){
        x.start=x.end=iso;x.awaitingEnd=false;
      }else if(x.freshRange || !x.awaitingEnd){
        x.start=iso;x.end='';x.awaitingEnd=true;x.freshRange=false;
      }else{
        if(iso<x.start){x.end=x.start;x.start=iso;}
        else{x.end=iso;}
        x.awaitingEnd=false;
      }
      renderDatePicker();
      syncApplyState();
    };

    var oldShortcut=MEEOPS7.datePickerShortcut;
    MEEOPS7.datePickerShortcut=function(which){
      if(oldShortcut) oldShortcut(which);
      var x=window._meeDatePicker;
      if(x&&x.mode==='range'){x.freshRange=false;x.awaitingEnd=false;}
      syncApplyState();
    };

    MEEOPS7.datePickerApply=async function(){
      var x=window._meeDatePicker;if(!x||!x.start)return;
      if(x.mode==='range'&&!x.end){
        syncApplyState(true);return;
      }
      var key=x.key,start=x.start,end=x.end||x.start;
      if(key==='production'){
        S.filters.production.start=start;
        S.filters.production.end=end;
        S.filters.production.date=start;
        if(window.closeOverlay) closeOverlay();
        await loadProductionRange(start,end);
        return;
      }
      if(x.mode==='range'){
        S.filters[key].start=start;S.filters[key].end=end;
        if(key==='orders')S.filters.orders.page=1;
      }else S.filters[key].date=start;
      if(window.closeOverlay) closeOverlay();
      if(key==='flowers'&&window.loadFlowers) await loadFlowers(true);
      else if(window.loadPage) await loadPage(key,true);
    };
    return true;
  }

  function syncApplyState(showHint){
    requestAnimationFrame(function(){
      var x=window._meeDatePicker,modal=qs('.calendar-modal');if(!x||!modal)return;
      var btn=modal.querySelector('.calendar-actions .btn.primary');
      if(btn && x.mode==='range') btn.disabled=!x.start||!x.end;
      var sel=modal.querySelector('.calendar-selection');
      if(sel&&x.mode==='range'){
        sel.classList.toggle('mee-range-waiting',!!(x.start&&!x.end));
        var sub=sel.querySelector('.sub');
        if(sub) sub.textContent=x.end?'Sẵn sàng áp dụng':'Chọn ngày kết thúc';
        if(showHint&&!x.end) sel.setAttribute('data-hint','Chọn thêm ngày kết thúc');
      }
    });
  }

  async function loadProductionRange(start,end){
    if(!window.gas || !window.S || !window.renderProduction) return;
    var dates=eachDate(start,end);
    try{
      var responses=await Promise.all(dates.map(function(date){return gas('getProductionOrders',{date:date});}));
      var orders=[],seen=new Set(),base=null;
      responses.forEach(function(raw){
        var r=(window.validateBuild?validateBuild(raw):raw)||{};
        if(!base&&r) base=Object.assign({},r);
        (r.orders||[]).forEach(function(o){
          var k=o.id||[o.date,o.time,o.customer].join('|');
          if(!seen.has(k)){seen.add(k);orders.push(o);}
        });
      });
      orders.sort(function(a,b){return String(a.date||'')+' '+String(a.time||'')>String(b.date||'')+' '+String(b.time||'')?1:-1;});
      S.data.production=Object.assign({},base||{ok:true},{orders:orders,rangeStart:start,rangeEnd:end});
      if(window.rememberOrders) rememberOrders(orders);
      renderProduction();
      patchProductionRangeButton();
    }catch(e){
      if(window.toast) toast(e&&e.message?e.message:'Không tải được khoảng ngày sản xuất.',1);
    }
  }

  function patchProductionRangeButton(){
    if(!window.S) return;
    var active=qs('[data-p="production"].active');
    if(!active && !/Sản xuất/i.test((qs('#pageTitle')||{}).textContent||'')) return;
    var btn=qs('.production-filter .date-filter-btn');if(!btn)return;
    var f=S.filters.production||{},start=f.start||f.date,end=f.end||f.date||start;
    btn.setAttribute('onclick',"MEEOPS7.openDatePicker('production','range')");
    btn.textContent='▣ '+dateVN2(start)+' → '+dateVN2(end)+'　⌄';
  }

  function removeLoadingCopy(){
    document.querySelectorAll('.page-status').forEach(function(el){el.remove();});
    var pill=qs('.loading-pill');
    if(pill){
      Array.from(pill.childNodes).forEach(function(n){if(n.nodeType===3)n.textContent='';});
      pill.querySelectorAll(':scope > span:not(.spinner)').forEach(function(el){el.style.display='none';});
    }
  }

  var timer=null;
  function schedulePatch(){
    clearTimeout(timer);
    timer=setTimeout(function(){
      installRangePicker();
      patchProductionRangeButton();
      removeLoadingCopy();
      syncApplyState();
    },30);
  }
  var mo=new MutationObserver(function(mutations){
    var relevant=mutations.some(function(m){return m.type==='childList'&&(m.addedNodes.length||m.removedNodes.length)});
    if(relevant) schedulePatch();
  });
  function init(){
    installRangePicker();patchProductionRangeButton();removeLoadingCopy();
    var content=qs('#content'),overlay=qs('#overlay');
    if(content) mo.observe(content,{childList:true,subtree:true});
    if(overlay) mo.observe(overlay,{childList:true,subtree:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
