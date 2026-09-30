/**
 * MEEHOASG — PARALLEL TEST SYNC
 * Version: 2026-09-30 v5 (Legacy production -> Supabase + gated web test writeback)
 *
 * CURRENT TEST PHASE:
 *  - Old web app + Order Sheets + MEE_OPS_DATABASE remain production sources.
 *  - Order Sheet + MEE_OPS_DATABASE -> Supabase continuously.
 *  - Supabase -> Sheets/Database only for explicitly allowed web-test orders.
 *  - New orders created on the new website (no source_sheet yet) are automatically treated as test orders.
 *
 * Script Properties:
 *  SUPABASE_INGEST_URL
 *  SUPABASE_INGEST_SECRET
 *  DATABASE_SPREADSHEET_ID   = spreadsheet ID of MEE_OPS_DATABASE
 *  WEB_TEST_ORDER_IDS        = comma/newline separated existing Order IDs allowed to write back from new web
 *  SUPABASE_ANON_KEY         = optional direct API fallback
 *  SUPABASE_SYNC_USERNAME    = optional direct API fallback
 *  SUPABASE_SYNC_PASSWORD    = optional direct API fallback
 *  ORDER_SHEET_NAMES         = optional
 */

var SPREADSHEET_ID = '1TsVOtDWrqlkjEUPGWmRudGEvGe38qLG0S62MOVDefpM';

var CFG = {
  ORDER_WIDTH: 15,
  META_SHEET_NAME: 'MIG_ORDER_META_V6',
  BATCH_SIZE: 80,
  LOOKBACK: 30,
  LOG_SHEET: 'SYNC_LOG'
};

function syncDelta() {
  _doSync(false);
  syncSupabaseToSheet();
}

function _getIngestConfig(props) {
  props = props || PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var url = '';
  var secret = '';
  var keys = {};
  for (var k in all) {
    if (k.indexOf('CREATE_REQ_') === -1 && k.indexOf('MEE_CREATE_') === -1) keys[k] = all[k];
  }
  if (keys.SUPABASE_INGEST_SECRET) secret = keys.SUPABASE_INGEST_SECRET;
  else if (keys.INGEST_SECRET) secret = keys.INGEST_SECRET;
  else if (keys.MEEHOA_CONNECTOR_SECRET) secret = keys.MEEHOA_CONNECTOR_SECRET;

  for (var k in keys) {
    var cleanK = String(k || '').trim().toUpperCase();
    var val = String(keys[k] || '').trim();
    if (!secret && (cleanK.indexOf('CONNECTOR') >= 0 || cleanK.indexOf('SECRET') >= 0 || cleanK.indexOf('INGEST') >= 0) && cleanK !== 'SESSION_SECRET' && cleanK !== 'PASSWORD_SALT' && val) secret = val;
    if (!url && (cleanK.indexOf('SUPABASE') >= 0 || cleanK.indexOf('INGEST') >= 0) && cleanK.indexOf('URL') >= 0) url = val;
  }
  if (!url || url.indexOf('supabase.co') === -1) url = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-ingest';
  return { url: url, secret: String(secret || '').trim() };
}

function _getAuxSpreadsheet(props) {
  var dbId = String(props.getProperty('DATABASE_SPREADSHEET_ID') || '').trim();
  if (!dbId) return null;
  try { return SpreadsheetApp.openById(dbId); }
  catch (e) { _log('ERROR', 'Không mở được MEE_OPS_DATABASE: ' + e.message); return null; }
}

function _getAuxMetaSheet(props) {
  var dbSs = _getAuxSpreadsheet(props);
  if (!dbSs) return null;
  return dbSs.getSheetByName(CFG.META_SHEET_NAME) || dbSs.getSheetByName('ORDER_META');
}

function _getWebTestIdSet(props) {
  var raw = String(props.getProperty('WEB_TEST_ORDER_IDS') || '').trim();
  var set = {};
  if (!raw) return set;
  raw.split(/[\n,;]+/).forEach(function(x) {
    var id = String(x || '').trim();
    if (id) set[id] = true;
  });
  return set;
}

function _rememberWebTestOrder(props, id) {
  if (!id) return;
  var set = _getWebTestIdSet(props);
  if (set[id]) return;
  set[id] = true;
  props.setProperty('WEB_TEST_ORDER_IDS', Object.keys(set).join(','));
}

function _isWebWritebackAllowed(o, props, testIds) {
  if (!o || !o.id) return false;
  if (!o.source_sheet && !o.source_row) return true;
  return !!testIds[o.id];
}

function _fetchOrdersFromSupabase(props, cfg) {
  var apiUrl = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-api';
  var anonKey = String(props.getProperty('SUPABASE_ANON_KEY') || '').trim();
  var syncUsername = String(props.getProperty('SUPABASE_SYNC_USERNAME') || props.getProperty('BOOTSTRAP_USERNAME') || '').trim();
  var syncPassword = String(props.getProperty('SUPABASE_SYNC_PASSWORD') || '').trim();

  try {
    if (!anonKey || !syncUsername || !syncPassword) throw new Error('Thiếu direct API credentials; chuyển sang ingest.');
    var cache = CacheService.getScriptCache();
    var token = cache.get('SUPABASE_SESSION_TOKEN');
    if (!token) {
      var loginResp = UrlFetchApp.fetch(apiUrl, {
        method: 'post', contentType: 'application/json',
        headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey },
        payload: JSON.stringify({ name: 'loginAndBootstrap', payload: { username: syncUsername, password: syncPassword } }),
        muteHttpExceptions: true
      });
      if (loginResp.getResponseCode() === 200) {
        var loginData = JSON.parse(loginResp.getContentText() || '{}');
        if (loginData.token) { token = loginData.token; cache.put('SUPABASE_SESSION_TOKEN', token, 21600); }
      }
    }
    if (token) {
      var now = new Date();
      var startD = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
      var endD = new Date(now.getTime() + 60 * 24 * 3600 * 1000);
      var startStr = Utilities.formatDate(startD, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
      var endStr = Utilities.formatDate(endD, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
      var ordersResp = UrlFetchApp.fetch(apiUrl, {
        method: 'post', contentType: 'application/json',
        headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey },
        payload: JSON.stringify({ name: 'getOrders', payload: { token: token, start: startStr, end: endStr, pageSize: 200 } }),
        muteHttpExceptions: true
      });
      if (ordersResp.getResponseCode() === 200) {
        var items = (JSON.parse(ordersResp.getContentText() || '{}').items || []);
        return items.map(function(o) {
          return {
            id:o.id, customer:o.customer, order_date:o.date, order_time:o.time, flower:o.flower, note:o.note,
            status:o.status, source_sheet:o.sourceSheet, source_row:o.sourceRow, phone:o.phone, address:o.address,
            shipping:o.shipping, flower_total:o.flowerTotal, payment:o.payment, sale:o.sale, settled:o.settled,
            image_urls:o.imageUrls || [], ship_fee:o.shipFee || 0, ship_confirmed:!!o.shipConfirmed,
            card:!!o.card, card_text:o.cardText || '', banner:!!o.banner, banner_text:o.bannerText || '',
            charm_fee:o.charmFee || 0, charm_text:o.charmText || '', paper_fee:o.paperFee || 0,
            paper_text:o.paperText || '', vat:o.vat || 0
          };
        });
      }
      if (ordersResp.getResponseCode() === 401) cache.remove('SUPABASE_SESSION_TOKEN');
    }
  } catch(e) { _log('WARN', 'Direct API không dùng được: ' + e.message + '. Thử ingest...'); }

  if (cfg.secret) {
    try {
      var sinceParam = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      var resp = UrlFetchApp.fetch(cfg.url, {
        method:'post', contentType:'application/json', headers:{'x-ingest-secret':cfg.secret},
        payload:JSON.stringify({action:'getOrdersForSheet', since:sinceParam, limit:200}), muteHttpExceptions:true
      });
      if (resp.getResponseCode() === 200) return JSON.parse(resp.getContentText() || '{}').orders || [];
      _log('WARN', 'meehoasg-ingest trả mã ' + resp.getResponseCode());
    } catch(e) { _log('ERROR', 'meehoasg-ingest lỗi: ' + e.message); }
  }
  return [];
}

function syncSupabaseToSheet() {
  var props = PropertiesService.getScriptProperties();
  var cfg = _getIngestConfig(props);
  var allOrders = _fetchOrdersFromSupabase(props, cfg);
  if (!allOrders || !allOrders.length) return;

  var testIds = _getWebTestIdSet(props);
  var orders = allOrders.filter(function(o) { return _isWebWritebackAllowed(o, props, testIds); });
  if (!orders.length) {
    _log('INFO', 'Web→Sheet: không có đơn test được phép ghi ngược.');
    return;
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var metaSheet = _getAuxMetaSheet(props);
  var updates = [], insertedCount = 0, updatedCount = 0, syncIncomplete = false;

  function _findOrderSheet(targetMonth, preferredName) {
    if (preferredName) { var s = ss.getSheetByName(preferredName); if (s) return s; }
    var candidates = ['Tháng ' + targetMonth, targetMonth, 'Đơn ' + targetMonth, 'Tháng ' + targetMonth.replace(/^0/, ''), targetMonth.replace(/^0/, '')];
    for (var i=0;i<candidates.length;i++) { var s2=ss.getSheetByName(candidates[i]); if (s2) return s2; }
    var all = ss.getSheets();
    for (var j=0;j<all.length;j++) if (all[j].getName().indexOf(targetMonth) >= 0) return all[j];
    return null;
  }

  var byMonth = {};
  orders.forEach(function(o) {
    var m = (o.order_date || '').match(/^(\d{4})-(\d{2})/);
    var monthKey = m ? (m[2] + '/' + m[1]) : Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'MM/yyyy');
    if (!byMonth[monthKey]) byMonth[monthKey] = [];
    byMonth[monthKey].push(o);
  });

  Object.keys(byMonth).forEach(function(monthKey) {
    var monthOrders=byMonth[monthKey], sampleOrder=monthOrders[0] || {}, sheet=_findOrderSheet(monthKey, sampleOrder.source_sheet);
    if (!sheet) { _log('WARN','Không tìm thấy tab sheet cho tháng: ' + monthKey); syncIncomplete=true; return; }
    var lastRow=sheet.getLastRow(), existingIds={};
    if (lastRow>=2) {
      var idValues=sheet.getRange(2,15,lastRow-1,1).getValues();
      for (var r=0;r<idValues.length;r++){ var eid=String(idValues[r][0]||'').trim(); if(eid) existingIds[eid]=r+2; }
    }

    monthOrders.forEach(function(o) {
      var id=o.id, targetRow=existingIds[id];
      if (!targetRow && o.source_row && Number(o.source_row)>=2 && Number(o.source_row)<=lastRow) targetRow=Number(o.source_row);
      var dParts=(o.order_date||'').split('-');
      var dateVal=dParts.length===3 ? (dParts[2]+'/'+dParts[1]+'/'+dParts[0]) : o.order_date;
      var rowValues=[
        o.customer||'', dateVal, o.order_time||'', o.flower||'',
        (o.image_urls&&o.image_urls[0])?o.image_urls[0]:'', o.note||'',
        (o.status==='Đã bó'||o.status==='Đã giao'), (o.status==='Đã giao'),
        o.shipping||'', _formatContactCell(o.phone,o.address), Number(o.flower_total||0),
        o.payment||'', _saleDisplayName(o.sale), Boolean(o.settled), id
      ];

      if (targetRow) {
        sheet.getRange(targetRow,1,1,15).setValues([rowValues]);
        updatedCount++;
      } else {
        if (!rowValues[8]) rowValues[8]='Shop book ship';
        sheet.appendRow(rowValues);
        targetRow=sheet.getLastRow();
        existingIds[id]=targetRow;
        updates.push({id:id, source_sheet:sheet.getName(), source_row:targetRow});
        insertedCount++;
        _rememberWebTestOrder(props, id);
      }
      _upsertMetaFromWeb(metaSheet,o,id);
    });
  });

  if (updates.length>0 && cfg.secret) {
    try { UrlFetchApp.fetch(cfg.url,{method:'post',contentType:'application/json',headers:{'x-ingest-secret':cfg.secret},payload:JSON.stringify({action:'recordSheetPositions',updates:updates}),muteHttpExceptions:true}); } catch(e) {}
  }
  if (!syncIncomplete) props.setProperty('LAST_SUPABASE_TO_SHEET_AT', new Date().toISOString());
  _log('INFO','Web→legacy TEST ONLY: chèn '+insertedCount+', cập nhật '+updatedCount+' đơn.');
}

function _upsertMetaFromWeb(metaSheet,o,id) {
  if(!metaSheet||!id) return;
  try {
    var last=metaSheet.getLastRow(), row=0;
    if(last>=2){
      var ids=metaSheet.getRange(2,1,last-1,1).getValues();
      for(var i=0;i<ids.length;i++){ if(String(ids[i][0]||'').trim()===id){ row=i+2; break; } }
    }
    var values=[[id,o.status||'Chờ bó',Number(o.ship_fee||0),Boolean(o.ship_confirmed),Boolean(o.card),o.card_text||'',Boolean(o.banner),o.banner_text||'',Number(o.charm_fee||0),o.charm_text||'',Number(o.paper_fee||0),o.paper_text||'',Number(o.vat||0),o.phone||'',JSON.stringify(o.image_urls||[]),'SYNC_WEB_TEST',new Date()]];
    if(row) metaSheet.getRange(row,1,1,17).setValues(values);
    else metaSheet.getRange(Math.max(2,last+1),1,1,17).setValues(values);
  } catch(err) { _log('WARN','Không cập nhật được MIG_ORDER_META_V6 cho '+id+': '+err.message); }
}

function syncFull() {
  var props=PropertiesService.getScriptProperties();
  props.getKeys().filter(function(k){return k.indexOf('SYNC_CURSOR_')===0;}).forEach(function(k){props.deleteProperty(k);});
  _doSync(true);
  _log('INFO','syncFull hoàn tất: legacy production → Supabase.');
}

function _doSync(full) {
  var props=PropertiesService.getScriptProperties(), cfg=_getIngestConfig(props), url=cfg.url, secret=cfg.secret;
  if(!secret){_log('ERROR','Chưa tìm thấy SUPABASE_INGEST_SECRET.');return;}
  var ss=SpreadsheetApp.openById(SPREADSHEET_ID), orderSheetNames=_getOrderSheetNames(props,ss);
  if(!orderSheetNames.length){_log('ERROR','Không tìm thấy tab đơn hàng nào.');return;}
  var meta=_buildMetaMap(props);
  for(var s=0;s<orderSheetNames.length;s++){
    var sheetName=orderSheetNames[s], sheet=ss.getSheetByName(sheetName);
    if(!sheet){_log('WARN','Tab không tồn tại: '+sheetName);continue;}
    _syncSheet(sheet,meta,url,secret,props,full);
  }
}

function _getOrderSheetNames(props,ss) {
  var raw=props.getProperty('ORDER_SHEET_NAMES')||'';
  if(raw.trim()) return raw.split(/[\n,]+/).map(function(x){return x.trim();}).filter(Boolean);
  return ss.getSheets().map(function(sh){return sh.getName();}).filter(function(n){return /\d{1,2}\/\d{4}/.test(n)||/^(?:Đơn\s*|Tháng\s*)\d/i.test(n);});
}

function _buildMetaMap(props) {
  var map={};
  try {
    var sh=_getAuxMetaSheet(props);
    if(!sh||sh.getLastRow()<2){
      _log('WARN','Không đọc được MIG_ORDER_META_V6; Supabase sẽ thiếu phụ kiện cũ.');
      return map;
    }
    var rows=sh.getRange(2,1,sh.getLastRow()-1,17).getValues();
    rows.forEach(function(r){
      var id=String(r[0]||'').trim(); if(!id)return;
      var imgs=[]; try{imgs=JSON.parse(r[14]||'[]');}catch(e){}
      map[id]={status:String(r[1]||'').trim(),shipFee:r[2],shipConfirmed:r[3],card:r[4],cardText:r[5],banner:r[6],bannerText:r[7],charmFee:r[8],charmText:r[9],paperFee:r[10],paperText:r[11],vat:r[12],phone:String(r[13]||'').trim(),images:Array.isArray(imgs)?imgs.filter(Boolean):[]};
    });
  } catch(e){_log('WARN','_buildMetaMap: '+e.message);}
  return map;
}

function _syncSheet(sheet,meta,url,secret,props,full) {
  var sheetName=sheet.getName(), lastRow=sheet.getLastRow(); if(lastRow<2)return;
  var cursorKey='SYNC_CURSOR_'+sheetName.replace(/[\/\s]/g,'_'), saved=Number(props.getProperty(cursorKey)||'1'), startRow=full?2:Math.max(2,saved-CFG.LOOKBACK+1), count=lastRow-startRow+1; if(count<=0)return;
  var values=sheet.getRange(startRow,1,count,CFG.ORDER_WIDTH).getValues(), richValues=sheet.getRange(startRow,5,count,1).getRichTextValues(), dispValues=sheet.getRange(startRow,5,count,1).getDisplayValues(), orders=[];
  for(var i=0;i<values.length;i++){
    var r=values[i],customer=String(r[0]||'').trim(),id=String(r[14]||'').trim();
    if(!customer&&!id)continue; if(r[1]===''||r[1]===null)continue;
    var d=_parseDate(r[1]); if(!d)continue;
    if(!id)id='LEGACY-'+sheet.getSheetId()+'-'+(startRow+i);
    var m=meta[id]||{}, fallbackImgs=_imageUrlsFromRichText(richValues[i]&&richValues[i][0],dispValues[i]&&dispValues[i][0]), seen={};
    var imgs=(m.images||[]).concat(fallbackImgs).filter(function(u){if(!u||seen[u])return false;seen[u]=true;return true;});
    var status=_status(r);
    orders.push({
      id:id,sync_id:id,source_sheet:sheetName,source_row:startRow+i,customer:customer,
      order_date:Utilities.formatDate(d,'Asia/Ho_Chi_Minh','yyyy-MM-dd'),order_time:_time(r[2]),
      flower:String(r[3]||'').trim(),note:String(r[5]||'').trim(),shipping:String(r[8]||'').trim(),
      address:_addr(r[9]),phone:_phone(r[9])||m.phone||'',flower_total:_money(r[10]),payment:String(r[11]||'').trim(),
      sale:String(r[12]||'').trim(),settled:_bool(r[13]),status:status,
      ship_fee:_money(m.shipFee),ship_confirmed:_bool(m.shipConfirmed),card:_bool(m.card),card_text:String(m.cardText||'').trim(),
      banner:_bool(m.banner),banner_text:String(m.bannerText||'').trim(),charm_fee:_money(m.charmFee),charm_text:String(m.charmText||'').trim(),
      paper_fee:_money(m.paperFee),paper_text:String(m.paperText||'').trim(),vat:_money(m.vat),image_urls:imgs
    });
  }
  if(!orders.length){props.setProperty(cursorKey,String(lastRow));return;}
  var sent=0,failed=0,errMsg='';
  for(var b=0;b<orders.length;b+=CFG.BATCH_SIZE){
    var batch=orders.slice(b,b+CFG.BATCH_SIZE);
    try{
      var resp=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',headers:{'x-ingest-secret':secret},payload:JSON.stringify({orders:batch}),muteHttpExceptions:true});
      var code=resp.getResponseCode(),body={};try{body=JSON.parse(resp.getContentText()||'{}');}catch(e){}
      if(code===200&&body.ok) sent+=(body.processed||batch.length);
      else {failed+=batch.length;errMsg='HTTP '+code+': '+resp.getContentText().slice(0,120);}
    }catch(ex){failed+=batch.length;errMsg=ex.message;}
  }
  if(failed===0) props.setProperty(cursorKey,String(lastRow));
  _log(failed>0?'WARN':'OK','['+sheetName+'] rows '+startRow+'-'+lastRow+' → '+orders.length+' đơn, sent='+sent+', failed='+failed+(errMsg?' ['+errMsg+']':''));
}

function _formatContactCell(phone,addr){var p=String(phone||'').trim(),a=String(addr||'').trim();if(p&&a)return 'SĐT: '+p+'\nĐịa chỉ: '+a;if(p)return 'SĐT: '+p;return a;}
var SALE_DISPLAY_NAMES={'huynhxuyen':'Huỳnh Xuyến','huynhthu':'Huỳnh Thư','huynhlan':'Huỳnh Lan','hien':'Hiền Lê','tien':'Minh Tiến','cmui':'C Mụi','pu':'Pu'};
function _saleDisplayName(s){if(!s)return 'C Mụi';var key=String(s).toLowerCase().trim();return SALE_DISPLAY_NAMES[key]||s;}
function _imageUrlsFromRichText(rt,txt){var out=[];if(rt){try{if(rt.getLinkUrl&&rt.getLinkUrl())out.push(rt.getLinkUrl());if(rt.getRuns)rt.getRuns().forEach(function(run){var u=run.getLinkUrl();if(u)out.push(u);});}catch(e){}}var source=(rt&&rt.getText)?rt.getText():String(txt||''),m=source.match(/https?:\/\/[^\s"'>]+/g);if(m)out=out.concat(m);var seen={};return out.filter(function(u){u=String(u||'').trim();if(!/^https?:\/\//i.test(u)||seen[u])return false;seen[u]=true;return true;});}
function _time(v){if(v instanceof Date)return Utilities.formatDate(v,'Asia/Ho_Chi_Minh','HH:mm');var s=String(v||'').trim();if(s.indexOf('1899')>=0||s.indexOf('GMT')>=0){var d=new Date(s);if(!isNaN(d.getTime()))return Utilities.formatDate(d,'Asia/Ho_Chi_Minh','HH:mm');}var m=s.match(/(\d{1,2}):(\d{2})/);if(m)return('0'+m[1]).slice(-2)+':'+m[2];return s.slice(0,5);}
function _parseDate(v){if(v instanceof Date)return isNaN(v.getTime())?null:v;if(typeof v==='number'){var d=new Date((v-25569)*86400000);return isNaN(d.getTime())?null:d;}var s=String(v).trim(),m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);if(m)return new Date(Number(m[3]),Number(m[2])-1,Number(m[1]));return null;}
function _phone(v){var m=String(v||'').match(/(?:SĐT|SDT)\s*:\s*([^\n]+)/i);return m?m[1].trim():'';}
function _addr(v){return String(v||'').replace(/(?:SĐT|SDT)\s*:\s*[^\n]+\n?/i,'').replace(/^Địa chỉ\s*:\s*/i,'').trim();}
function _money(v){if(typeof v==='number')return isFinite(v)?Math.round(v):0;var s=String(v||'').trim().replace(/[^\d.,-]/g,'');if(!s)return 0;if(s.indexOf('.')>=0&&s.indexOf(',')>=0)s=s.replace(/\./g,'').replace(',','.');else if(/^-?\d{1,3}(?:[.,]\d{3})+$/.test(s))s=s.replace(/[.,]/g,'');else s=s.replace(',','.');var n=Number(s);return isFinite(n)?Math.round(n):0;}
function _bool(v){return v===true||v===1||['true','yes','1','x'].indexOf(String(v||'').trim().toLowerCase())>=0;}
function _status(r){return _bool(r[7])?'Đã giao':_bool(r[6])?'Đã bó':'Chờ bó';}
function _log(level,msg){var ss=SpreadsheetApp.openById(SPREADSHEET_ID),log=ss.getSheetByName(CFG.LOG_SHEET);if(!log){log=ss.insertSheet(CFG.LOG_SHEET);log.getRange(1,1,1,3).setValues([['Thời gian','Level','Nội dung']]);}log.appendRow([new Date(),level,msg]);Logger.log('['+level+'] '+msg);}