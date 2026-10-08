/**
 * MEEHOASG — PRODUCTION WRITEBACK v9.3 RESUMABLE (v9.2 trigger compatibility)
 * Version: 2026-10-08
 *
 * Requires v9.1 helpers to remain in v9.gs.
 *
 * Fixes the v9.1 performance problem:
 * - v9.1 scanned all ~7,233 Order IDs + metadata EVERY minute before even
 *   checking whether Supabase had any changes.
 * - v9.2 fetches Supabase delta FIRST.
 * - If delta=0: no Sheet scan at all.
 * - If there are changes: validates ONLY the changed Order IDs with TextFinder,
 *   then writes safely by Order ID.
 * - A full duplicate health audit runs separately every 15 minutes.
 *
 * Supabase remains the production source of truth.
 */

function installProductionSyncV92() {
  var props = PropertiesService.getScriptProperties();

  if (String(props.getProperty(P91_MODE_KEY) || '').toUpperCase() !== 'PRODUCTION') {
    throw new Error('MEE_SYNC_MODE chưa phải PRODUCTION. Không cài v9.2.');
  }

  // One final full audit at install time only.
  var audit = _p91AuditProductionReadiness();
  if (!audit.ok) {
    throw new Error(
      'v9.2 bị chặn: duplicateOrderIds=' + audit.duplicateOrderIds +
      ', duplicateMetaIds=' + audit.duplicateMetaIds
    );
  }

  var remove = {
    syncProductionV9: true,
    syncProductionV91: true,
    syncProductionV92: true,
    auditProductionV92Health: true,
    syncDelta: true,
    syncLegacySettlementsDeltaV8: true,
    syncLegacySettlementsToSupabase: true
  };

  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction ? t.getHandlerFunction() : '';
    if (remove[fn]) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('syncProductionV92')
    .timeBased()
    .everyMinutes(1)
    .create();

  ScriptApp.newTrigger('auditProductionV92Health')
    .timeBased()
    .everyMinutes(15)
    .create();

  _p91Log(
    'OK',
    'v9.2 FAST ACTIVE: delta Supabase kiểm tra mỗi 1 phút; full duplicate health audit mỗi 15 phút.'
  );
}

function syncProductionV92() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(3000)) {
    _p91Log('WARN', 'v9.2 bỏ qua lượt này vì execution khác vẫn đang chạy.');
    return;
  }

  try {
    var props = PropertiesService.getScriptProperties();

    if (String(props.getProperty(P91_MODE_KEY) || '').toUpperCase() !== 'PRODUCTION') {
      _p91Log('INFO', 'v9.2 không chạy vì MEE_SYNC_MODE chưa phải PRODUCTION.');
      return;
    }

    var secret = _p91Secret(props);
    if (!secret) throw new Error('Thiếu SUPABASE_INGEST_SECRET.');

    var last = String(props.getProperty(P91_LAST_SYNC_KEY) || '').trim();
    var sinceMs = last && !isNaN(Date.parse(last))
      ? Date.parse(last) - P91_OVERLAP_MS
      : Date.now() - 5 * 60 * 1000;

    var since = new Date(sinceMs).toISOString();
    var until = new Date().toISOString();

    var allOrders = [];
    var offset = 0;
    var page = 0;
    var complete = false;

    // FAST PATH: query Supabase BEFORE touching the large legacy sheets.
    while (page < P91_MAX_PAGES) {
      var feed = _p91FetchFeed(secret, since, until, offset, P91_PAGE_SIZE);
      var rows = feed.orders || [];
      allOrders = allOrders.concat(rows);
      page++;

      if (!feed.hasMore || rows.length < P91_PAGE_SIZE) {
        complete = true;
        break;
      }

      offset += rows.length;
    }

    if (!complete) {
      _p91Log(
        'WARN',
        'v9.2 quá ' + (P91_MAX_PAGES * P91_PAGE_SIZE) +
        ' thay đổi trong một cửa sổ; không advance cursor.'
      );
      return;
    }

    if (!allOrders.length) {
      props.setProperty(P91_LAST_SYNC_KEY, until);
      _p91Log('INFO', 'v9.2: 0 thay đổi từ Supabase.');
      return;
    }

    var result = _p92ApplyChangedOrders(allOrders, props, secret);

    if (!result.ok) {
      _p91Log(
        'WARN',
        'v9.2 chưa hoàn tất; cursor giữ nguyên. ' + result.message
      );
      return;
    }

    props.setProperty(P91_LAST_SYNC_KEY, until);

    _p91Log(
      'OK',
      'v9.2 Supabase→legacy: fetched=' + allOrders.length +
      ', inserted=' + result.inserted +
      ', updated=' + result.updated +
      ', moved=' + result.moved +
      ', meta=' + result.meta + '.'
    );
  } catch (e) {
    _p91Log('ERROR', 'v9.2 lỗi: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function auditProductionV92Health() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(3000)) {
    // Health audit is non-critical; never block production delta sync.
    return;
  }

  try {
    var props = PropertiesService.getScriptProperties();

    if (String(props.getProperty(P91_MODE_KEY) || '').toUpperCase() !== 'PRODUCTION') {
      return;
    }

    var audit = _p91AuditProductionReadiness();

    if (!audit.ok) {
      _p91Log(
        'ERROR',
        'v9.2 HEALTH BLOCKED: duplicateOrderIds=' +
        audit.duplicateOrderIds +
        ', duplicateMetaIds=' +
        audit.duplicateMetaIds +
        '. Production delta sẽ fail-closed nếu ID liên quan thay đổi.'
      );
    } else {
      _p91Log(
        'OK',
        'v9.2 HEALTH PASS: uniqueOrderIds=' +
        audit.uniqueOrderIds +
        ', duplicateOrderIds=0, duplicateMetaIds=0.'
      );
    }
  } finally {
    lock.releaseLock();
  }
}

function testProductionV92Now() {
  syncProductionV92();
}

// Resumable cross-month moves. A journal permits recovery of OUR two-row move,
// never arbitrary duplicate removal. ScriptLock in the caller serializes jobs;
// identity + original row snapshot guard against manual source edits.
function _p92ApplyChangedOrders(orders, props, secret) {
  var ss=SpreadsheetApp.openById(P91_ORDER_SPREADSHEET_ID);
  var sheets=_p91OrderSheets(ss,props), meta=_p91MetaSheet(props);
  if(!meta)return {ok:false,message:'Không mở được ORDER_META.'};
  var byId={},plans=[],counts={inserted:0,updated:0,moved:0,meta:0},completed=[];
  orders.forEach(function(o){if(o&&String(o.id||'').trim())byId[String(o.id).trim()]=o;});
  // Validate every ID before changing any row.
  try{
    Object.keys(byId).forEach(function(id){
      var order=byId[id],key='MEE_MOVE_V93_'+id,journal=JSON.parse(props.getProperty(key)||'null');
      var occurrences=_p92FindOrderOccurrences(sheets,id),metas=_p92FindMetaOccurrences(meta,id);
      var targetName=_p92ResolveMonthSheetName(ss,sheets,order.order_date);
      if(!targetName||metas.length>1)throw Error('Tab/meta không rõ cho '+id);
      if(journal){
        if(journal.targetName!==targetName)throw Error('Đơn '+id+' đổi tháng trong lúc đang phục hồi. Cần đối chiếu nhật ký chuyển tab.');
        if(occurrences.some(function(x){return x.sheet.getSheetId()!==journal.sourceSheetId&&x.sheet.getName()!==journal.targetName;})||occurrences.length>2)throw Error('ID trùng ngoài nhật ký: '+id);
        var source=occurrences.filter(function(x){return x.sheet.getSheetId()===journal.sourceSheetId;});
        var targets=occurrences.filter(function(x){return x.sheet.getName()===journal.targetName;});
        if(source.length>1||targets.length>1)throw Error('ID trùng trong cùng tab: '+id);
        if(source.length&&JSON.stringify(source[0].sheet.getRange(source[0].row,1,1,15).getValues()[0])!==journal.sourceSnapshot)throw Error('Dòng nguồn đã được sửa; giữ cả hai dòng để đối chiếu: '+id);
      }else if(occurrences.length>1)throw Error('Order ID trùng trong legacy: '+id);
      plans.push({id:id,order:order,key:key,journal:journal,targetName:targetName});
    });
    plans.forEach(function(plan){
      var target=ss.getSheetByName(plan.targetName)||_p91FindOrCreateMonthSheet(ss,sheets,plan.order.order_date);
      if(!target)throw Error('Không mở được tab đích: '+plan.id);
      var configured=String(props.getProperty('ORDER_SHEET_NAMES')||'').trim();
      if(configured){var names=configured.split(/[\n,]+/).map(function(n){return n.trim();});if(names.indexOf(target.getName())<0)props.setProperty('ORDER_SHEET_NAMES',names.concat([target.getName()]).join('\n'));}
      // Row numbers can shift after earlier deletes: resolve identity again.
      sheets=_p91OrderSheets(ss,props);
      if(!sheets.some(function(sh){return sh.getSheetId()===target.getSheetId();}))sheets.push(target);
      var occurrences=_p92FindOrderOccurrences(sheets,plan.id),journal=plan.journal;
      var targetLocations=occurrences.filter(function(x){return x.sheet.getSheetId()===target.getSheetId();});
      var sources=occurrences.filter(function(x){return x.sheet.getSheetId()!==target.getSheetId();});
      if(targetLocations.length>1||sources.length>1)throw Error('ID trùng: '+plan.id);
      var source=sources[0],location=targetLocations[0];
      if(source&&!journal){
        journal={sourceSheetId:source.sheet.getSheetId(),sourceSnapshot:JSON.stringify(source.sheet.getRange(source.row,1,1,15).getValues()[0]),targetName:plan.targetName};
        // Persist BEFORE append. Retry can find an append whose response was lost.
        props.setProperty(plan.key,JSON.stringify(journal));
      }
      var rowValues=_p91OrderRow(plan.order,plan.id);
      if(location){
        if(String(target.getRange(location.row,15).getDisplayValue()||'').trim()!==plan.id)throw Error('Dòng đích đổi ID: '+plan.id);
        target.getRange(location.row,1,1,15).setValues([rowValues]);counts.updated++;
      }else{target.appendRow(rowValues);counts.inserted++;}
      var metaRows=_p92FindMetaOccurrences(meta,plan.id);
      if(metaRows.length>1)throw Error('Meta trùng: '+plan.id);
      // Failed metadata must leave the source intact and journal available.
      _p92WriteMeta(meta,metaRows[0]||0,plan.order,plan.id);counts.meta++;
      if(source){
        var now=_p92FindOrderOccurrences(_p91OrderSheets(ss,props),plan.id).filter(function(x){return x.sheet.getSheetId()===journal.sourceSheetId;});
        if(now.length!==1||JSON.stringify(now[0].sheet.getRange(now[0].row,1,1,15).getValues()[0])!==journal.sourceSnapshot)throw Error('Dòng nguồn thay đổi; chưa xoá: '+plan.id);
        var destination=_p92FindOrderOccurrences([target],plan.id);
        if(destination.length!==1)throw Error('Chưa xác nhận dòng đích: '+plan.id);
        now[0].sheet.deleteRow(now[0].row);counts.moved++;
      }
      if(journal)props.deleteProperty(plan.key);
      completed.push(plan.id);
    });
    // Resolve final positions AFTER all source deletions, including shifted rows.
    var positions=[];sheets=_p91OrderSheets(ss,props);
    completed.forEach(function(id){var found=_p92FindOrderOccurrences(sheets,id);if(found.length!==1)throw Error('Vị trí cuối không rõ: '+id);positions.push({id:id,source_sheet:found[0].sheet.getName(),source_row:found[0].row});});
    if(positions.length){
      var response=UrlFetchApp.fetch(P91_INGEST_URL,{method:'post',contentType:'application/json',headers:{'x-ingest-secret':secret},payload:JSON.stringify({action:'recordSheetPositions',updates:positions}),muteHttpExceptions:true});
      if(response.getResponseCode()!==200||JSON.parse(response.getContentText()||'{}').ok!==true)throw Error('Không ghi nhận được vị trí cuối.');
    }
    return Object.assign({ok:true,message:''},counts);
  }catch(e){_p91Log('ERROR','v9.3 '+e.message);return Object.assign({ok:false,message:e.message},counts);}
}

function _p92FindOrderOccurrences(sheets, id) {
  var found = [];

  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var last = sh.getLastRow();

    if (last < 2) continue;

    var matches = sh
      .getRange(2, 15, last - 1, 1)
      .createTextFinder(id)
      .matchEntireCell(true)
      .findAll();

    matches.forEach(function(r) {
      found.push({
        sheet: sh,
        row: r.getRow()
      });
    });

    if (found.length > 1) break;
  }

  return found;
}

function _p92FindMetaOccurrences(metaSheet, id) {
  var last = metaSheet.getLastRow();
  if (last < 2) return [];

  var matches = metaSheet
    .getRange(2, 1, last - 1, 1)
    .createTextFinder(id)
    .matchEntireCell(true)
    .findAll();

  return matches.map(function(r) {
    return r.getRow();
  });
}

function _p92ResolveMonthSheetName(ss, knownSheets, isoDate) {
  var m = String(isoDate || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return '';

  var key = m[2] + '/' + m[1];
  var candidates = [
    'Tháng ' + key,
    key,
    'Đơn ' + key,
    'Tháng ' + key.replace(/^0/, ''),
    key.replace(/^0/, '')
  ];

  for (var i = 0; i < candidates.length; i++) {
    if (ss.getSheetByName(candidates[i])) {
      return candidates[i];
    }
  }

  for (var j = 0; j < knownSheets.length; j++) {
    var name = knownSheets[j].getName();
    if (name.indexOf(key) >= 0) return name;
  }

  // New month; v9.1 safe creator will create exactly this name.
  return 'Tháng ' + key;
}

function _p92WriteMeta(metaSheet, existingRow, o, id) {
  var row = existingRow || Math.max(2, metaSheet.getLastRow() + 1);

  if (existingRow) {
    var currentId = String(
      metaSheet.getRange(existingRow, 1).getDisplayValue() || ''
    ).trim();

    if (currentId !== id) {
      throw new Error(
        'Meta identity đổi trong lúc sync tại A' +
        existingRow + ': expected=' + id + ', actual=' + currentId
      );
    }
  }

  if(metaSheet.getMaxColumns && metaSheet.getMaxColumns()<25)metaSheet.insertColumnsAfter(metaSheet.getMaxColumns(),25-metaSheet.getMaxColumns());
  if(metaSheet.getRange(1,18).getDisplayValue()!=='Số thiệp')metaSheet.getRange(1,18,1,8).setValues([['Số thiệp','Full Paid','Tiền Full Paid','Bill Full Paid','Người xác nhận','Thời gian xác nhận','Thời gian gỡ','Lý do gỡ']]);
  metaSheet.getRange(row, 1, 1, 25).setValues([[
    id,
    o.status || 'Chờ bó',
    Number(o.ship_fee || 0),
    Boolean(o.ship_confirmed),
    Boolean(o.card),
    o.card_text || '',
    Boolean(o.banner),
    o.banner_text || '',
    Number(o.charm_fee || 0),
    o.charm_text || '',
    Number(o.paper_fee || 0),
    o.paper_text || '',
    Number(o.vat || 0),
    o.phone || '',
    JSON.stringify(Array.isArray(o.image_urls) ? o.image_urls : []),
    'SYNC_WEB_PROD_V93',
    new Date(),
    Number(o.card_qty || (o.card ? 1 : 0)),
    Boolean(o.full_paid),
    Number(o.full_paid_total || 0),
    JSON.stringify(Array.isArray(o.full_paid_bill_urls) ? o.full_paid_bill_urls : []),
    o.full_paid_by || '',
    o.full_paid_at || '',
    o.full_paid_invalidated_at || '',
    o.full_paid_invalidated_reason || ''
  ]]);
}
