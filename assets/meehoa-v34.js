(function(){
  'use strict';
  function qs(s,r){return (r||document).querySelector(s)}

  function findFieldWrap(form,name){
    var el=form.querySelector('[name="'+name+'"]');
    if(!el) return null;
    return el.closest('.span2')||el.parentElement;
  }

  function createSection(tone,title){
    var s=document.createElement('section');
    s.className='mee-form-section';
    s.dataset.tone=tone;
    var h=document.createElement('div');
    h.className='mee-section-title';
    h.textContent=title;
    s.appendChild(h);
    return s;
  }

  function enhanceOrderForm(){
    var form=qs('#orderForm');
    if(!form||form.dataset.meeEnhanced==='1') return;
    var grid=qs('.form-grid',form);
    if(!grid) return;

    form.dataset.meeEnhanced='1';
    form.classList.add('mee-order-form');

    var customer=createSection('customer','01 · Khách hàng');
    var order=createSection('order','02 · Đơn hoa');
    var delivery=createSection('delivery','03 · Giao nhận');
    var payment=createSection('payment','04 · Thanh toán & phụ trách');

    var groups={
      customer:['customer','phone'],
      order:['flower','note','imageFiles'],
      delivery:['date','time','shipping','address'],
      payment:['flowerTotal','paymentType','depositAmount','sale']
    };
    function move(names,target){
      names.forEach(function(name){
        var w=findFieldWrap(form,name);
        if(w&&w.parentElement===grid) target.appendChild(w);
      });
    }
    move(groups.customer,customer);
    move(groups.order,order);
    move(groups.delivery,delivery);
    move(groups.payment,payment);
    [customer,order,delivery,payment].forEach(function(s){if(s.children.length>1) grid.appendChild(s)});

    /* Keep original field nodes intact. Replacing input elements after the app binds
       validation/listeners can break form behavior and cached DOM references. */
    var address=form.querySelector('[name="address"]');
    var addressWrap=address&&(address.closest('.span2')||address.parentElement);
    if(addressWrap) addressWrap.classList.add('mee-address-wrap');
    var shipping=form.querySelector('[name="shipping"]');
    function syncAddress(){
      if(!shipping||!addressWrap) return;
      var hide=/Khách tự book|Ghé lấy/i.test(shipping.value||'');
      addressWrap.classList.toggle('mee-hidden',hide);
    }
    if(shipping){shipping.addEventListener('change',syncAddress);syncAddress();}
  }

  var timer=null;
  var mo=new MutationObserver(function(mutations){
    var relevant=mutations.some(function(m){
      if(m.type!=='childList'||!m.addedNodes.length) return false;
      return Array.from(m.addedNodes).some(function(n){
        return n.nodeType===1 && (n.id==='orderForm'||(n.querySelector&&n.querySelector('#orderForm')));
      });
    });
    if(!relevant) return;
    clearTimeout(timer);
    timer=setTimeout(enhanceOrderForm,0);
  });

  function init(){
    enhanceOrderForm();
    var ov=qs('#overlay');
    if(ov) mo.observe(ov,{childList:true,subtree:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
