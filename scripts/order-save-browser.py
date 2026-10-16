"""Isolated regression: real shell/runtime, synthetic API. Requires Python Playwright.
Set MEEHOA_CHROMIUM to system Chromium; install Playwright WebKit for Safari coverage.
No external request is allowed through; no production session or customer data is used.
"""
from playwright.sync_api import sync_playwright
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from functools import partial
import threading,json,os
root=Path(__file__).resolve().parent.parent
out=root/'artifacts/order-save';out.mkdir(parents=True,exist_ok=True)
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
srv=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(root)))
threading.Thread(target=srv.serve_forever,daemon=True).start()
origin=f'http://127.0.0.1:{srv.server_port}'
order=dict(id='FIXTURE-PU',customer='Khách thử',phone='0900000000',date='2026-10-17',time='11:30',flower='Hoa thử',flowerTotal=1500000,payment='Đã thanh toán toàn bộ đơn',fullPaid=True,fullPaidBillUrls=['https://fixture.invalid/bill.png'],sale='pu',saleUsername='pu',status='Chờ bó',shipping='Shop book ship',address='Địa chỉ thử',note='',imageUrls=['https://fixture.invalid/sample.png'],driveUrls=['https://fixture.invalid/sample.png'],card=True,cardQty=1,cardText='Bs sau',banner=False,accessoryTotal=30000,shipFee=20000,shipConfirmed=True,canEdit=True,detailLoaded=True,updatedAt='2026-10-16T12:28:37Z')
engines=os.getenv('MEEHOA_TEST_ENGINES','chromium,webkit').split(',')
results=[]
try:
 with sync_playwright() as p:
  for engine in engines:
   browser=getattr(p,engine).launch(**(dict(executable_path=os.getenv('MEEHOA_CHROMIUM','/usr/bin/chromium'),args=['--no-sandbox']) if engine=='chromium' else {}),headless=True)
   try:
    for role in ['SALE','ADMIN','THO_OPS']:
     for scenario in ['normal','serialization-error','validation','submit-not-dispatched','lost-response']:
      ctx=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
      page=ctx.new_page();page.set_default_timeout(8000);errors=[];calls=[];diagnostics=[]
      page.on('pageerror',lambda e:errors.append(str(e)))
      def route(r):
       if r.request.url.startswith(origin):return r.continue_()
       if '.supabase.co/functions/v1/' not in r.request.url:return r.abort()
       if r.request.method=='OPTIONS':return r.fulfill(status=204,headers={'access-control-allow-origin':'*','access-control-allow-headers':'*'})
       req=r.request.post_data_json;name=req.get('name');calls.append(name)
       listing=dict(ok=True,items=[order],total=1,page=1,pageSize=80,hasMore=False)
       data=listing if name=='getOrders' else dict(ok=True)
       if name=='loginAndBootstrap':data=dict(ok=True,token='a'*64,user=dict(username='pu',name='Pu',role=role,active=True),options=dict(sales=['Pu'],shipping=['Shop book ship']),initial=dict(page='orders',data=listing))
       if name=='getOrder':data=dict(ok=True,order=order)
       if name=='getAppOptions':data=dict(ok=True,options=dict(sales=['Pu'],shipping=['Shop book ship']))
       if name=='logOrderSaveFailure':diagnostics.append(req['payload'])
       if name=='updateOrder':
        if scenario=='lost-response':return r.abort()
        data=dict(ok=True,orderId=order['id'],order={**order,**req['payload']['order']},message='Đã lưu thay đổi.')
       r.fulfill(status=200,headers={'access-control-allow-origin':'*','content-type':'application/json'},body=json.dumps({**data,'build':'2026.09.28-supabase-v3'}))
      ctx.route('**/*',route)
      try:
       page.goto(origin);page.locator('#loginUser').fill('pu');page.locator('#loginPass').fill('fixture');page.locator('#loginBtn').click();page.wait_for_function('window.S?.user')
       page.evaluate("MEEOPS7.openOrderForm('FIXTURE-PU')");page.wait_for_timeout(150)
       page.locator('.mee-accessory-head').tap();page.locator('[name=cardText]').fill('Happy Birthday Sis 💕 Test')
       assert page.locator('#orderSubmit').evaluate('e=>e.form.id')=='orderForm'
       assert page.locator('#orderSubmit').evaluate('e=>(getComputedStyle(e).userSelect||getComputedStyle(e).webkitUserSelect)')=='none'
       assert page.locator('[name=cardText]').evaluate('e=>(getComputedStyle(e).userSelect||getComputedStyle(e).webkitUserSelect)')!='none'
       if scenario=='serialization-error':page.evaluate("() => { window.realFormData=FormData;window.FormData=function(){throw new Error('Fixture: serialization failed')} }")
       if scenario=='validation':page.locator('[name=customer]').fill('')
       if scenario=='submit-not-dispatched':page.evaluate("document.getElementById('orderForm').onsubmit=null")
       page.locator('#orderSubmit').tap()
       if scenario=='normal':
        page.wait_for_function("!document.getElementById('orderForm')");assert calls.count('updateOrder')==1
       else:
        page.locator('[data-order-feedback]').wait_for();page.wait_for_timeout(200)
        assert page.locator('[name=cardText]').input_value()=='Happy Birthday Sis 💕 Test'
        assert page.locator('#orderSubmit').is_enabled()
        feedback=page.locator('[data-order-feedback]').inner_text()
        if scenario=='validation':assert 'TÊN KHÁCH HÀNG' in feedback and calls.count('updateOrder')==0
        else:
         assert 'Mã lỗi:' in feedback
         page.wait_for_function("JSON.parse(sessionStorage.getItem('mee-order-save-diagnostics')).length>0")
         stage=dict([('serialization-error','serialize'),('submit-not-dispatched','submit'),('lost-response','request')])[scenario]
         assert page.evaluate("JSON.parse(sessionStorage.getItem('mee-order-save-diagnostics')).at(-1).stage")==stage
         assert any(x['stage']==stage for x in diagnostics)
         assert calls.count('updateOrder')==(1 if scenario=='lost-response' else 0)
         page.screenshot(path=str(out/f'{engine}-{role}-{scenario}.png'))
        if scenario in ['serialization-error','submit-not-dispatched']:
         page.evaluate("() => { if(window.realFormData)window.FormData=window.realFormData;document.getElementById('orderForm').onsubmit=e=>MEEOPS7.saveOrder(e,'FIXTURE-PU') }")
         page.locator('#orderSubmit').tap();page.wait_for_function("!document.getElementById('orderForm')");assert calls.count('updateOrder')==1
       assert errors==[],errors
       results.append(dict(engine=engine,role=role,scenario=scenario,status='pass'))
       print(f'PASS {engine} {role} {scenario}',flush=True)
      except Exception:
       page.screenshot(path=str(out/f'{engine}-{role}-{scenario}-FAIL.png'));raise
      finally:ctx.close()
   finally:browser.close()
finally:
 srv.shutdown();(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
print(f'{len(results)}/{len(engines)*15} scenarios passed')
