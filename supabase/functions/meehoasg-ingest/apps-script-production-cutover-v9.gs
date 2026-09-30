/**
 * MEEHOASG — PRODUCTION CUTOVER SYNC
 * Version: 2026-09-30 v9
 *
 * PURPOSE
 *   Supabase becomes the operational source of truth.
 *   Website/Supabase -> Order Sheet + MEE_OPS_DATABASE every minute.
 *   Legacy Sheet/old web app -> Supabase automatic sync is STOPPED in production mode.
 *
 * WHY
 *   Prevents a stale legacy row from overwriting a newer website edit during cutover.
 *   Row identity is ALWAYS Order ID (column O). source_row is cache only.
 *
 * REQUIRED Script Properties
 *   SUPABASE_INGEST_SECRET
 *   DATABASE_SPREADSHEET_ID
 *
 * OPTIONAL
 *   ORDER_SHEET_NAMES
 *
 * CUTOVER
 *   1) Paste this file into the existing Sync Apps Script project.
 *   2) Run installProductionCutoverV9() once.
 *   3) Run syncProductionV9() once manually and inspect SYNC_LOG.
 *
 * ROLLBACK
 *   Run rollbackToParallelV9() to stop production writeback trigger and restore
 *   legacy syncDelta + settlement delta triggers when intentionally returning to old app.
 */

var P9_ORDER_SPREADSHEET_ID = '1TsVOtDWrqlkjEUPGWmRudGEvGe38qLG0S62MOVDefpM';
var P9_FEED_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-writeback-feed';
var P9_INGEST_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-ingest';
var P9_META_SHEET = 'MIG_ORDER_META_V6';
var P9_MODE_KEY = 'MEE_SYNC_MODE';
var P9_LAST_SYNC_KEY = 'P9_LAST_WEB_TO_SHEET_AT';
var P9_LOG_SHEET = 'SYNC_LOG';
var P9_PAGE_SIZE = 200;
var P9_MAX_PAGES = 20;
var P9_OVERLAP_MS = 15000;

function installProductionCutoverV9() {
  var props = PropertiesService.getScriptProperties();
  var secret = _p9Secret(props);
  var dbId = String(props.getProperty('DATABASE_SPREADSHEET_ID') || '').trim();
  if (!secret) throw new Error('Thiếu SUPABASE_INGEST_SECRET. Dừng để bảo vệ production.');
  if (!dbId) throw new Error('Thiếu DATABASE_SPREADSHEET_ID. Dừng để bảo vệ production.');

  // Verify both spreadsheets are reachable before changing triggers.
  SpreadsheetApp.openById(P9_ORDER_SPREADSHEET_ID);
  SpreadsheetApp.openById(dbId);

  props.setProperty(P9_MODE_KEY, 'PRODUCTION');
  if (!props.getProperty(P9_LAST_SYNC_KEY)) {
    props.setProperty(P9_LAST_SYNC_KEY, new Date(Date.now() - 5 * 60 * 1000).toISOString());
  }

  var remove = {
    syncDelta: true,
    syncLegacySettlementsDeltaV8: true,
    syncLegacySettlementsToSupabase: true,
    syncProductionV9: true
  };
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction ? t.getHandlerFunction() : '';
    if (remove[fn]) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('syncProductionV9').timeBased().everyMinutes(1).create();
  _p9Log('OK', 'CUTOVER v9 ACTIVE: Supabase là source of truth; trigger legacy->Supabase và Settlement legacy delta đã dừng.');
}

function syncProductionV9() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    _p9Log('WARN', 'v9 bỏ qua lượt này vì execution trước vẫn đang chạy.');
    return;
  }

  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty(P9_MODE_KEY) || '').toUpperCase() !== 'PRODUCTION') {
      _p9Log('INFO', 'v9 không chạy vì MEE_SYNC_MODE chưa phải PRODUCTION.');
      return;
    }

    var secret = _p9Secret(props);
    if (!secret) throw new Error('Thiếu SUPABASE_INGEST_SECRET.');

    var last = String(props.getProperty(P9_LAST_SYNC_KEY) || '').trim();
    var sinceMs = last && !isNaN(Date.parse(last)) ? Date.parse(last) - P9_OVERLAP_MS : Date.now() - 5 * 60 * 1000;
    var since = new Date(sinceMs).toISOString();
    var until = new Date().toISOString();

    var allOrders = [];
    var offset = 0;
    var page = 0;
    var complete = false;

    while (page < P9_MAX_PAGES) {
      var feed = _p9FetchFeed(secret, since, until, offset, P9_PAGE_SIZE);
      var rows = feed.orders || [];
      allOrders = allOrders.concat(rows);
      page++;
      if (!feed.hasMore || rows.length < P9_PAGE_SIZE) {
        complete = true;
        break;
      }
      offset += rows.length;
    }

    if (!complete) {
      _p9Log('WARN', 'v9 quá ' + (P9_MAX_PAGES * P9_PAGE_SIZE) + ' thay đổi trong một cửa sổ; không advance cursor để tránh mất dữ liệu.');
      return;
    }

    if (!allOrders.length) {
      props.setProperty(P9_LAST_SYNC_KEY, until);
      _p9Log('INFO', 'v9: 0 thay đổi từ Supabase.');
      return;
    }

    var result = _p9ApplyOrders(allOrders, props, secret);
    if (!result.ok) {
      _p9Log('WARN', 'v9 chưa hoàn tất; cursor giữ nguyên. ' + result.message);
      return;
    }

    props.setProperty(P9_LAST_SYNC_KEY, until);
    _p9Log('OK', 'v9 Supabase→legacy: fetched=' + allOrders.length + ', inserted=' + result.inserted + ', updated=' + result.updated + ', moved=' + result.moved + ', meta=' + result.meta + ', duplicateIds=' + result.duplicates + '.');
  } catch (e) {
    _p9Log('ERROR', 'v9 lỗi: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function rollbackToParallelV9() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(P9_MODE_KEY, 'PARALLEL');

  var remove = { syncProductionV9: true, syncDelta: true, syncLegacySettlementsDeltaV8: true };
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction ? t.getHandlerFunction() : '';
    if (remove[fn]) ScriptApp.deleteTrigger(t);
  });

  if (typeof syncDelta === 'function') {
    ScriptApp.newTrigger('syncDelta').timeBased().everyMinutes(1).create();
  }
  if (typeof syncLegacySettlementsDeltaV8 === 'function') {
    ScriptApp.newTrigger('syncLegacySettlementsDeltaV8').timeBased().everyMinutes(1).create();
  }
  _p9Log('WARN', 'ROLLBACK v9: đã dừng production writeback và khôi phục trigger legacy khi function còn tồn tại.');
}

function previewProductionV9() {
  var props = PropertiesService.getScriptProperties();
  var secret = _p9Secret(props);
  if (!secret) throw new Error('Thiếu SUPABASE_INGEST_SECRET.');
  var last = String(props.getProperty(P9_LAST_SYNC_KEY) || '').trim();
  var since = last && !isNaN(Date.parse(last)) ? new Date(Date.parse(last) - P9_OVERLAP_MS).toISOString() : new Date(Date.now() - 5 * 60 * 1000).toISOString();
  var until = new Date().toISOString();
  var feed = _p9FetchFeed(secret, since, until, 0, P9_PAGE_SIZE);
  Logger.log(JSON.stringify({ since: since, until: until, count: (feed.orders || []).length, hasMore: !!feed.hasMore }));
  return feed;
}

function _p9FetchFeed(secret, since, until, offset, limit) {
  var resp = UrlFetchApp.fetch(P9_FEED_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': secret },
    payload: JSON.stringify({ since: since, until: until, offset: offset || 0, limit: limit || P9_PAGE_SIZE }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var body = {};
  try { body = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
  if (code !== 200 || !body.ok) throw new Error('writeback feed HTTP ' + code + ': ' + resp.getContentText().slice(0, 180));
  return body;
}

function _p9ApplyOrders(orders, props, secret) {
  var ss = SpreadsheetApp.openById(P9_ORDER_SPREADSHEET_ID);
  var orderSheets = _p9OrderSheets(ss, props);
  var index = _p9BuildOrderIndex(orderSheets);
  var metaSheet = _p9MetaSheet(props);
  if (!metaSheet) return { ok: false, message: 'Không mở được MIG_ORDER_META_V6.' };
  var metaIndex = _p9BuildMetaIndex(metaSheet);

  var inserted = 0, updated = 0, moved = 0, metaCount = 0, duplicates = Object.keys(index.duplicates).length;
  var positions = [];
  var deletions = {};
  var hadError = false;

  for (var i = 0; i < orders.length; i++) {
    var o = orders[i] || {};
    var id = String(o.id || '').trim();
    if (!id) continue;

    var target = _p9FindOrCreateMonthSheet(ss, orderSheets, o.order_date);
    if (!target) {
      hadError = true;
      _p9Log('WARN', 'v9 không tìm/tạo được tab tháng cho ' + id + ' date=' + String(o.order_date || ''));
      continue;
    }

    var location = index.byId[id] || null;
    var rowValues = _p9OrderRow(o, id);
    var targetRow = 0;

    if (location && location.sheet.getSheetId() === target.getSheetId()) {
      targetRow = location.row;
      target.getRange(targetRow, 1, 1, 15).setValues([rowValues]);
      updated++;
    } else if (location) {
      target.appendRow(rowValues);
      targetRow = target.getLastRow();
      moved++;
      var sid = String(location.sheet.getSheetId());
      if (!deletions[sid]) deletions[sid] = { sheet: location.sheet, rows: [] };
      deletions[sid].rows.push(location.row);
      index.byId[id] = { sheet: target, row: targetRow };
    } else {
      target.appendRow(rowValues);
      targetRow = target.getLastRow();
      inserted++;
      index.byId[id] = { sheet: target, row: targetRow };
    }

    _p9UpsertMeta(metaSheet, metaIndex, o, id);
    metaCount++;
    positions.push({ id: id, source_sheet: target.getName(), source_row: targetRow });
  }

  // Delete moved source rows only after every write has completed, descending per sheet,
  // so cached row numbers collected at the start remain valid during this run.
  Object.keys(deletions).forEach(function(key) {
    var item = deletions[key];
    item.rows.sort(function(a, b) { return b - a; }).forEach(function(row) {
      try { item.sheet.deleteRow(row); }
      catch (e) { hadError = true; _p9Log('WARN', 'Không xoá được row cũ ' + row + ' ở ' + item.sheet.getName() + ': ' + e.message); }
    });
  });

  if (positions.length) {
    var rec = UrlFetchApp.fetch(P9_INGEST_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-ingest-secret': secret },
      payload: JSON.stringify({ action: 'recordSheetPositions', updates: positions }),
      muteHttpExceptions: true
    });
    if (rec.getResponseCode() !== 200) {
      hadError = true;
      _p9Log('WARN', 'recordSheetPositions HTTP ' + rec.getResponseCode());
    }
  }

  return { ok: !hadError, message: hadError ? 'Có lỗi ghi/xoá/record position; xem SYNC_LOG.' : '', inserted: inserted, updated: updated, moved: moved, meta: metaCount, duplicates: duplicates };
}

function _p9OrderSheets(ss, props) {
  var raw = String(props.getProperty('ORDER_SHEET_NAMES') || '').trim();
  if (raw) {
    return raw.split(/[\n,]+/).map(function(name) { return ss.getSheetByName(String(name || '').trim()); }).filter(Boolean);
  }
  return ss.getSheets().filter(function(sh) {
    var n = sh.getName();
    return /\d{1,2}\/\d{4}/.test(n) || /^(?:Đơn\s*|Tháng\s*)\d/i.test(n);
  });
}

function _p9BuildOrderIndex(sheets) {
  var byId = {}, duplicates = {};
  sheets.forEach(function(sheet) {
    var last = sheet.getLastRow();
    if (last < 2) return;
    var values = sheet.getRange(2, 15, last - 1, 1).getValues();
    values.forEach(function(r, idx) {
      var id = String(r[0] || '').trim();
      if (!id) return;
      if (byId[id]) {
        duplicates[id] = true;
        return;
      }
      byId[id] = { sheet: sheet, row: idx + 2 };
    });
  });
  return { byId: byId, duplicates: duplicates };
}

function _p9FindOrCreateMonthSheet(ss, knownSheets, isoDate) {
  var m = String(isoDate || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  var key = m[2] + '/' + m[1];
  var candidates = ['Tháng ' + key, key, 'Đơn ' + key, 'Tháng ' + key.replace(/^0/, ''), key.replace(/^0/, '')];
  for (var i = 0; i < candidates.length; i++) {
    var found = ss.getSheetByName(candidates[i]);
    if (found) return found;
  }
  for (var j = 0; j < knownSheets.length; j++) {
    if (knownSheets[j].getName().indexOf(key) >= 0) return knownSheets[j];
  }

  // Month rollover safeguard: create the missing month sheet with the standard A:O header.
  var name = 'Tháng ' + key;
  var created = ss.insertSheet(name);
  var headers = ['Tên','Ngày','Giờ nhận hoa','Mẫu đặt hàng','Hình mẫu','Note','Đã bó','Đã giao','Vận chuyển','Địa chỉ','Tổng tiền','TTTT','Sale','Tất toán','Order ID'];
  created.getRange(1, 1, 1, 15).setValues([headers]);
  created.setFrozenRows(1);
  if (knownSheets.length) {
    try {
      knownSheets[knownSheets.length - 1].getRange(1, 1, 1, 15).copyTo(created.getRange(1, 1, 1, 15), { formatOnly: true });
    } catch (e) {}
  }
  knownSheets.push(created);
  _p9Log('OK', 'v9 tự tạo tab tháng mới: ' + name);
  return created;
}

function _p9OrderRow(o, id) {
  var d = String(o.order_date || '').split('-');
  var dateValue = d.length === 3 ? (d[2] + '/' + d[1] + '/' + d[0]) : String(o.order_date || '');
  var images = Array.isArray(o.image_urls) ? o.image_urls : [];
  return [
    o.customer || '',
    dateValue,
    o.order_time || '',
    o.flower || '',
    images[0] || '',
    o.note || '',
    o.status === 'Đã bó' || o.status === 'Đã giao',
    o.status === 'Đã giao',
    o.shipping || 'Shop book ship',
    _p9Contact(o.phone, o.address),
    Number(o.flower_total || 0),
    o.payment || '',
    _p9SaleDisplay(o.sale),
    Boolean(o.settled),
    id
  ];
}

function _p9MetaSheet(props) {
  var dbId = String(props.getProperty('DATABASE_SPREADSHEET_ID') || '').trim();
  if (!dbId) return null;
  var db = SpreadsheetApp.openById(dbId);
  return db.getSheetByName(P9_META_SHEET) || db.getSheetByName('ORDER_META');
}

function _p9BuildMetaIndex(sheet) {
  var map = {};
  var last = sheet.getLastRow();
  if (last < 2) return map;
  var values = sheet.getRange(2, 1, last - 1, 1).getValues();
  values.forEach(function(r, idx) {
    var id = String(r[0] || '').trim();
    if (id && !map[id]) map[id] = idx + 2;
  });
  return map;
}

function _p9UpsertMeta(sheet, index, o, id) {
  var row = index[id] || 0;
  if (!row) {
    row = Math.max(2, sheet.getLastRow() + 1);
    index[id] = row;
  }
  var values = [[
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
    'SYNC_WEB_PROD',
    new Date()
  ]];
  sheet.getRange(row, 1, 1, 17).setValues(values);
}

function _p9Secret(props) {
  var all = props.getProperties();
  if (all.SUPABASE_INGEST_SECRET) return String(all.SUPABASE_INGEST_SECRET).trim();
  if (all.INGEST_SECRET) return String(all.INGEST_SECRET).trim();
  if (all.MEEHOA_CONNECTOR_SECRET) return String(all.MEEHOA_CONNECTOR_SECRET).trim();
  return '';
}

function _p9Contact(phone, address) {
  var p = String(phone || '').trim(), a = String(address || '').trim();
  if (p && a) return 'SĐT: ' + p + '\nĐịa chỉ: ' + a;
  if (p) return 'SĐT: ' + p;
  return a;
}

function _p9SaleDisplay(value) {
  var map = {
    'huynhxuyen': 'Huỳnh Xuyến',
    'huynhthu': 'Huỳnh Thư',
    'huynhlan': 'Huỳnh Lan',
    'hien': 'Hiền Lê',
    'tien': 'Minh Tiến',
    'cmui': 'C Mụi',
    'pu': 'Pu'
  };
  var raw = String(value || '').trim();
  return map[raw.toLowerCase()] || raw || 'C Mụi';
}

function _p9Log(level, message) {
  try {
    var ss = SpreadsheetApp.openById(P9_ORDER_SPREADSHEET_ID);
    var sh = ss.getSheetByName(P9_LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(P9_LOG_SHEET);
      sh.getRange(1, 1, 1, 3).setValues([['Thời gian','Level','Nội dung']]);
    }
    sh.appendRow([new Date(), level, message]);
  } catch (e) {}
  Logger.log('[' + level + '] ' + message);
}
