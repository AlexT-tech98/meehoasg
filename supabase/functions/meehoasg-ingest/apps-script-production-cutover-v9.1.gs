/**
 * MEEHOASG — PRODUCTION CUTOVER SYNC
 * Version: 2026-10-01 v9.1 SAFE
 *
 * SAFETY PRINCIPLES
 *   1) Order ID (column O) is the ONLY row identity.
 *   2) source_row is cache only and is NEVER used to choose a row to overwrite.
 *   3) If one Order ID exists in more than one legacy row, production cutover is BLOCKED.
 *   4) If one Order ID exists more than once in MIG_ORDER_META_V6/ORDER_META, cutover is BLOCKED.
 *   5) preflightProductionV91() only audits + logs. It does NOT edit orders or enable cutover.
 *   6) installProductionCutoverV91() re-runs the audit itself and refuses to enable production
 *      unless the data is clean at that exact moment.
 *
 * CURRENT SAFE PROCEDURE
 *   A. Run preflightProductionV91() first.
 *   B. Review log. Do NOT run installProductionCutoverV91() while BLOCKED.
 *   C. Only after duplicate data is repaired and preflight PASS, run installProductionCutoverV91().
 *
 * ROLLBACK
 *   Run rollbackToParallelV91() to stop Supabase -> legacy writeback and restore legacy triggers
 *   when those legacy functions are present in the Apps Script project.
 */

var P91_ORDER_SPREADSHEET_ID = '1TsVOtDWrqlkjEUPGWmRudGEvGe38qLG0S62MOVDefpM';
var P91_FEED_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-writeback-feed';
var P91_INGEST_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-ingest';
var P91_META_SHEET = 'MIG_ORDER_META_V6';
var P91_MODE_KEY = 'MEE_SYNC_MODE';
var P91_LAST_SYNC_KEY = 'P91_LAST_WEB_TO_SHEET_AT';
var P91_LOG_SHEET = 'SYNC_LOG';
var P91_PAGE_SIZE = 200;
var P91_MAX_PAGES = 20;
var P91_OVERLAP_MS = 15000;
var P91_DUPLICATE_LOG_LIMIT = 80;

/**
 * SAFE AUDIT ONLY.
 * Does not modify order rows, metadata rows, triggers, or sync mode.
 */
function preflightProductionV91() {
  var report = _p91AuditProductionReadiness();
  _p91Log('INFO', 'PREFLIGHT v9.1: orderSheets=' + report.orderSheets +
    ', rowsWithId=' + report.rowsWithId +
    ', uniqueOrderIds=' + report.uniqueOrderIds +
    ', duplicateOrderIds=' + report.duplicateOrderIds +
    ', duplicateMetaIds=' + report.duplicateMetaIds +
    ', mode=' + report.mode + '.');

  if (report.duplicateOrderIds > 0) {
    _p91LogDuplicateDetails('ORDER', report.orderDuplicates);
  }
  if (report.duplicateMetaIds > 0) {
    _p91LogDuplicateDetails('META', report.metaDuplicates);
  }

  if (report.ok) {
    _p91Log('OK', 'PREFLIGHT v9.1 PASS: không phát hiện Order ID trùng trong các tab đơn hoặc metadata. Cutover chưa được bật.');
  } else {
    _p91Log('WARN', 'PREFLIGHT v9.1 BLOCKED: dữ liệu còn ID trùng. KHÔNG bật production writeback.');
  }

  Logger.log(JSON.stringify(report));
  return report;
}

/**
 * Enable production only after a fresh, clean audit.
 */
function installProductionCutoverV91() {
  var props = PropertiesService.getScriptProperties();
  var secret = _p91Secret(props);
  var dbId = String(props.getProperty('DATABASE_SPREADSHEET_ID') || '').trim();
  if (!secret) throw new Error('Thiếu SUPABASE_INGEST_SECRET. Dừng để bảo vệ production.');
  if (!dbId) throw new Error('Thiếu DATABASE_SPREADSHEET_ID. Dừng để bảo vệ production.');

  var report = _p91AuditProductionReadiness();
  if (!report.ok) {
    _p91Log('WARN', 'CUTOVER v9.1 BỊ CHẶN: duplicateOrderIds=' + report.duplicateOrderIds +
      ', duplicateMetaIds=' + report.duplicateMetaIds + '. Chạy preflightProductionV91() để xem chi tiết.');
    throw new Error('Cutover v9.1 bị chặn vì còn Order ID trùng. Không có trigger production nào được bật.');
  }

  SpreadsheetApp.openById(P91_ORDER_SPREADSHEET_ID);
  SpreadsheetApp.openById(dbId);

  props.setProperty(P91_MODE_KEY, 'PRODUCTION');
  if (!props.getProperty(P91_LAST_SYNC_KEY)) {
    props.setProperty(P91_LAST_SYNC_KEY, new Date(Date.now() - 5 * 60 * 1000).toISOString());
  }

  var remove = {
    syncDelta: true,
    syncLegacySettlementsDeltaV8: true,
    syncLegacySettlementsToSupabase: true,
    syncProductionV9: true,
    syncProductionV91: true
  };
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction ? t.getHandlerFunction() : '';
    if (remove[fn]) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('syncProductionV91').timeBased().everyMinutes(1).create();
  _p91Log('OK', 'CUTOVER v9.1 ACTIVE: Supabase là source of truth; legacy->Supabase automatic triggers đã dừng.');
}

function syncProductionV91() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    _p91Log('WARN', 'v9.1 bỏ qua lượt này vì execution trước vẫn đang chạy.');
    return;
  }

  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty(P91_MODE_KEY) || '').toUpperCase() !== 'PRODUCTION') {
      _p91Log('INFO', 'v9.1 không chạy vì MEE_SYNC_MODE chưa phải PRODUCTION.');
      return;
    }

    var secret = _p91Secret(props);
    if (!secret) throw new Error('Thiếu SUPABASE_INGEST_SECRET.');

    // Fail closed if duplicate IDs appear after cutover.
    var audit = _p91AuditProductionReadiness();
    if (!audit.ok) {
      _p91Log('ERROR', 'v9.1 DỪNG lượt sync: phát hiện duplicateOrderIds=' + audit.duplicateOrderIds +
        ', duplicateMetaIds=' + audit.duplicateMetaIds + '. Không ghi bất kỳ order nào.');
      return;
    }

    var last = String(props.getProperty(P91_LAST_SYNC_KEY) || '').trim();
    var sinceMs = last && !isNaN(Date.parse(last)) ? Date.parse(last) - P91_OVERLAP_MS : Date.now() - 5 * 60 * 1000;
    var since = new Date(sinceMs).toISOString();
    var until = new Date().toISOString();

    var allOrders = [];
    var offset = 0;
    var page = 0;
    var complete = false;

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
      _p91Log('WARN', 'v9.1 quá ' + (P91_MAX_PAGES * P91_PAGE_SIZE) + ' thay đổi trong một cửa sổ; không advance cursor để tránh mất dữ liệu.');
      return;
    }

    if (!allOrders.length) {
      props.setProperty(P91_LAST_SYNC_KEY, until);
      _p91Log('INFO', 'v9.1: 0 thay đổi từ Supabase.');
      return;
    }

    var result = _p91ApplyOrders(allOrders, props, secret);
    if (!result.ok) {
      _p91Log('WARN', 'v9.1 chưa hoàn tất; cursor giữ nguyên. ' + result.message);
      return;
    }

    props.setProperty(P91_LAST_SYNC_KEY, until);
    _p91Log('OK', 'v9.1 Supabase→legacy: fetched=' + allOrders.length +
      ', inserted=' + result.inserted +
      ', updated=' + result.updated +
      ', moved=' + result.moved +
      ', meta=' + result.meta + '.');
  } catch (e) {
    _p91Log('ERROR', 'v9.1 lỗi: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function rollbackToParallelV91() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(P91_MODE_KEY, 'PARALLEL');

  var remove = {
    syncProductionV9: true,
    syncProductionV91: true,
    syncDelta: true,
    syncLegacySettlementsDeltaV8: true,
    syncLegacySettlementsToSupabase: true
  };

  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction ? t.getHandlerFunction() : '';
    if (remove[fn]) ScriptApp.deleteTrigger(t);
  });

  if (typeof syncDelta === 'function') {
    ScriptApp.newTrigger('syncDelta').timeBased().everyMinutes(1).create();
  }
  if (typeof syncLegacySettlementsDeltaV8 === 'function') {
    ScriptApp.newTrigger('syncLegacySettlementsDeltaV8').timeBased().everyMinutes(1).create();
  } else if (typeof syncLegacySettlementsToSupabase === 'function') {
    ScriptApp.newTrigger('syncLegacySettlementsToSupabase').timeBased().everyMinutes(5).create();
  }

  _p91Log('WARN', 'ROLLBACK v9.1: đã dừng production writeback và khôi phục trigger legacy khi function còn tồn tại.');
}

function previewProductionV91() {
  var props = PropertiesService.getScriptProperties();
  var secret = _p91Secret(props);
  if (!secret) throw new Error('Thiếu SUPABASE_INGEST_SECRET.');
  var last = String(props.getProperty(P91_LAST_SYNC_KEY) || '').trim();
  var since = last && !isNaN(Date.parse(last))
    ? new Date(Date.parse(last) - P91_OVERLAP_MS).toISOString()
    : new Date(Date.now() - 5 * 60 * 1000).toISOString();
  var until = new Date().toISOString();
  var feed = _p91FetchFeed(secret, since, until, 0, P91_PAGE_SIZE);
  Logger.log(JSON.stringify({ since: since, until: until, count: (feed.orders || []).length, hasMore: !!feed.hasMore }));
  return feed;
}

function _p91AuditProductionReadiness() {
  var props = PropertiesService.getScriptProperties();
  var secret = _p91Secret(props);
  var dbId = String(props.getProperty('DATABASE_SPREADSHEET_ID') || '').trim();
  if (!secret) throw new Error('Thiếu SUPABASE_INGEST_SECRET.');
  if (!dbId) throw new Error('Thiếu DATABASE_SPREADSHEET_ID.');

  var ss = SpreadsheetApp.openById(P91_ORDER_SPREADSHEET_ID);
  var sheets = _p91OrderSheets(ss, props);
  if (!sheets.length) throw new Error('Không tìm thấy tab đơn hàng tháng.');

  var orderIndex = _p91BuildOrderIndex(sheets);
  var metaSheet = _p91MetaSheet(props);
  if (!metaSheet) throw new Error('Không tìm thấy ' + P91_META_SHEET + ' hoặc ORDER_META trong MEE_OPS_DATABASE.');
  var metaIndex = _p91BuildMetaIndex(metaSheet);

  var duplicateOrderIds = Object.keys(orderIndex.duplicates).length;
  var duplicateMetaIds = Object.keys(metaIndex.duplicates).length;

  return {
    ok: duplicateOrderIds === 0 && duplicateMetaIds === 0,
    mode: String(props.getProperty(P91_MODE_KEY) || 'PARALLEL'),
    orderSheets: sheets.length,
    rowsWithId: orderIndex.rowsWithId,
    uniqueOrderIds: Object.keys(orderIndex.byId).length,
    duplicateOrderIds: duplicateOrderIds,
    duplicateMetaIds: duplicateMetaIds,
    orderDuplicates: orderIndex.duplicates,
    metaDuplicates: metaIndex.duplicates
  };
}

function _p91LogDuplicateDetails(kind, duplicates) {
  var ids = Object.keys(duplicates || {});
  var limit = Math.min(ids.length, P91_DUPLICATE_LOG_LIMIT);
  for (var i = 0; i < limit; i++) {
    var id = ids[i];
    var places = (duplicates[id] || []).map(function(x) {
      if (kind === 'ORDER') return x.sheetName + '!O' + x.row;
      return x.sheetName + '!A' + x.row;
    });
    _p91Log('WARN', 'DUPLICATE_' + kind + ': ' + id + ' -> ' + places.join(', '));
  }
  if (ids.length > limit) {
    _p91Log('WARN', 'DUPLICATE_' + kind + ': còn ' + (ids.length - limit) + ' ID trùng khác chưa in chi tiết để tránh log quá dài.');
  }
}

function _p91FetchFeed(secret, since, until, offset, limit) {
  var resp = UrlFetchApp.fetch(P91_FEED_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-secret': secret },
    payload: JSON.stringify({ since: since, until: until, offset: offset || 0, limit: limit || P91_PAGE_SIZE }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var body = {};
  try { body = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
  if (code !== 200 || !body.ok) {
    throw new Error('writeback feed HTTP ' + code + ': ' + resp.getContentText().slice(0, 180));
  }
  return body;
}

function _p91ApplyOrders(orders, props, secret) {
  var ss = SpreadsheetApp.openById(P91_ORDER_SPREADSHEET_ID);
  var orderSheets = _p91OrderSheets(ss, props);
  var index = _p91BuildOrderIndex(orderSheets);
  var metaSheet = _p91MetaSheet(props);
  if (!metaSheet) return { ok: false, message: 'Không mở được MIG_ORDER_META_V6/ORDER_META.' };
  var metaIndex = _p91BuildMetaIndex(metaSheet);

  if (Object.keys(index.duplicates).length || Object.keys(metaIndex.duplicates).length) {
    return {
      ok: false,
      message: 'Phát hiện ID trùng trong legacy; v9.1 từ chối ghi để tránh chọn sai row.',
      inserted: 0,
      updated: 0,
      moved: 0,
      meta: 0
    };
  }

  var inserted = 0;
  var updated = 0;
  var moved = 0;
  var metaCount = 0;
  var positions = [];
  var deletions = {};
  var hadError = false;

  for (var i = 0; i < orders.length; i++) {
    var o = orders[i] || {};
    var id = String(o.id || '').trim();
    if (!id) continue;

    // Never choose a row when identity is ambiguous.
    if (index.duplicates[id] || metaIndex.duplicates[id]) {
      hadError = true;
      _p91Log('ERROR', 'v9.1 SKIP ' + id + ': ID đang trùng trong legacy.');
      continue;
    }

    var target = _p91FindOrCreateMonthSheet(ss, orderSheets, o.order_date);
    if (!target) {
      hadError = true;
      _p91Log('WARN', 'v9.1 không tìm/tạo được tab tháng cho ' + id + ' date=' + String(o.order_date || ''));
      continue;
    }

    var location = index.byId[id] || null;
    var rowValues = _p91OrderRow(o, id);
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

    _p91UpsertMeta(metaSheet, metaIndex, o, id);
    metaCount++;
    positions.push({ id: id, source_sheet: target.getName(), source_row: targetRow });
  }

  Object.keys(deletions).forEach(function(key) {
    var item = deletions[key];
    item.rows.sort(function(a, b) { return b - a; }).forEach(function(row) {
      try {
        item.sheet.deleteRow(row);
      } catch (e) {
        hadError = true;
        _p91Log('WARN', 'Không xoá được row cũ ' + row + ' ở ' + item.sheet.getName() + ': ' + e.message);
      }
    });
  });

  if (positions.length) {
    var rec = UrlFetchApp.fetch(P91_INGEST_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-ingest-secret': secret },
      payload: JSON.stringify({ action: 'recordSheetPositions', updates: positions }),
      muteHttpExceptions: true
    });
    if (rec.getResponseCode() !== 200) {
      hadError = true;
      _p91Log('WARN', 'recordSheetPositions HTTP ' + rec.getResponseCode());
    }
  }

  return {
    ok: !hadError,
    message: hadError ? 'Có lỗi ghi/xoá/record position; xem SYNC_LOG.' : '',
    inserted: inserted,
    updated: updated,
    moved: moved,
    meta: metaCount
  };
}

function _p91OrderSheets(ss, props) {
  var raw = String(props.getProperty('ORDER_SHEET_NAMES') || '').trim();
  if (raw) {
    return raw.split(/[\n,]+/).map(function(name) {
      return ss.getSheetByName(String(name || '').trim());
    }).filter(Boolean);
  }

  return ss.getSheets().filter(function(sh) {
    var n = sh.getName();
    return /\d{1,2}\/\d{4}/.test(n) || /^(?:Đơn\s*|Tháng\s*)\d/i.test(n);
  });
}

function _p91BuildOrderIndex(sheets) {
  var occurrences = {};
  var rowsWithId = 0;

  sheets.forEach(function(sheet) {
    var last = sheet.getLastRow();
    if (last < 2) return;
    var values = sheet.getRange(2, 15, last - 1, 1).getValues();
    values.forEach(function(r, idx) {
      var id = String(r[0] || '').trim();
      if (!id) return;
      rowsWithId++;
      if (!occurrences[id]) occurrences[id] = [];
      occurrences[id].push({ sheet: sheet, sheetName: sheet.getName(), row: idx + 2 });
    });
  });

  var byId = {};
  var duplicates = {};
  Object.keys(occurrences).forEach(function(id) {
    var list = occurrences[id];
    if (list.length === 1) {
      byId[id] = { sheet: list[0].sheet, row: list[0].row };
    } else {
      duplicates[id] = list.map(function(x) {
        return { sheetName: x.sheetName, row: x.row };
      });
    }
  });

  return { byId: byId, duplicates: duplicates, rowsWithId: rowsWithId };
}

function _p91FindOrCreateMonthSheet(ss, knownSheets, isoDate) {
  var m = String(isoDate || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  var key = m[2] + '/' + m[1];
  var candidates = [
    'Tháng ' + key,
    key,
    'Đơn ' + key,
    'Tháng ' + key.replace(/^0/, ''),
    key.replace(/^0/, '')
  ];

  for (var i = 0; i < candidates.length; i++) {
    var found = ss.getSheetByName(candidates[i]);
    if (found) return found;
  }

  for (var j = 0; j < knownSheets.length; j++) {
    if (knownSheets[j].getName().indexOf(key) >= 0) return knownSheets[j];
  }

  var name = 'Tháng ' + key;
  var created = ss.insertSheet(name);
  var headers = ['Tên','Ngày','Giờ nhận hoa','Mẫu đặt hàng','Hình mẫu','Note','Đã bó','Đã giao','Vận chuyển','Địa chỉ','Tổng tiền','TTTT','Sale','Tất toán','Order ID'];
  created.getRange(1, 1, 1, 15).setValues([headers]);
  created.setFrozenRows(1);

  if (knownSheets.length) {
    try {
      knownSheets[knownSheets.length - 1].getRange(1, 1, 1, 15)
        .copyTo(created.getRange(1, 1, 1, 15), { formatOnly: true });
    } catch (e) {}
  }

  knownSheets.push(created);
  _p91Log('OK', 'v9.1 tự tạo tab tháng mới: ' + name);
  return created;
}

function _p91OrderRow(o, id) {
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
    _p91Contact(o.phone, o.address),
    Number(o.flower_total || 0),
    o.payment || '',
    _p91SaleDisplay(o.sale),
    Boolean(o.settled),
    id
  ];
}

function _p91MetaSheet(props) {
  var dbId = String(props.getProperty('DATABASE_SPREADSHEET_ID') || '').trim();
  if (!dbId) return null;
  var db = SpreadsheetApp.openById(dbId);
  return db.getSheetByName(P91_META_SHEET) || db.getSheetByName('ORDER_META');
}

function _p91BuildMetaIndex(sheet) {
  var occurrences = {};
  var last = sheet.getLastRow();
  if (last >= 2) {
    var values = sheet.getRange(2, 1, last - 1, 1).getValues();
    values.forEach(function(r, idx) {
      var id = String(r[0] || '').trim();
      if (!id) return;
      if (!occurrences[id]) occurrences[id] = [];
      occurrences[id].push({ sheetName: sheet.getName(), row: idx + 2 });
    });
  }

  var byId = {};
  var duplicates = {};
  Object.keys(occurrences).forEach(function(id) {
    var list = occurrences[id];
    if (list.length === 1) {
      byId[id] = list[0].row;
    } else {
      duplicates[id] = list;
    }
  });

  return { byId: byId, duplicates: duplicates };
}

function _p91UpsertMeta(sheet, metaIndex, o, id) {
  if (metaIndex.duplicates[id]) {
    throw new Error('Meta ID trùng, từ chối ghi: ' + id);
  }

  var row = metaIndex.byId[id] || 0;
  if (!row) {
    row = Math.max(2, sheet.getLastRow() + 1);
    metaIndex.byId[id] = row;
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
    'SYNC_WEB_PROD_V91',
    new Date()
  ]];

  sheet.getRange(row, 1, 1, 17).setValues(values);
}

function _p91Secret(props) {
  var all = props.getProperties();
  if (all.SUPABASE_INGEST_SECRET) return String(all.SUPABASE_INGEST_SECRET).trim();
  if (all.INGEST_SECRET) return String(all.INGEST_SECRET).trim();
  if (all.MEEHOA_CONNECTOR_SECRET) return String(all.MEEHOA_CONNECTOR_SECRET).trim();
  return '';
}

function _p91Contact(phone, address) {
  var p = String(phone || '').trim();
  var a = String(address || '').trim();
  if (p && a) return 'SĐT: ' + p + '\nĐịa chỉ: ' + a;
  if (p) return 'SĐT: ' + p;
  return a;
}

function _p91SaleDisplay(value) {
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

function _p91Log(level, message) {
  try {
    var ss = SpreadsheetApp.openById(P91_ORDER_SPREADSHEET_ID);
    var sh = ss.getSheetByName(P91_LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(P91_LOG_SHEET);
      sh.getRange(1, 1, 1, 3).setValues([['Thời gian','Level','Nội dung']]);
    }
    sh.appendRow([new Date(), level, message]);
  } catch (e) {}
  Logger.log('[' + level + '] ' + message);
}
