/**
 * MEEHOASG — PRODUCTION WRITEBACK v9.2 FAST
 * Version: 2026-10-01
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

function _p92ApplyChangedOrders(orders, props, secret) {
  var ss = SpreadsheetApp.openById(P91_ORDER_SPREADSHEET_ID);
  var orderSheets = _p91OrderSheets(ss, props);
  var metaSheet = _p91MetaSheet(props);

  if (!metaSheet) {
    return { ok: false, message: 'Không mở được MIG_ORDER_META_V6/ORDER_META.' };
  }

  // Deduplicate changed IDs in the feed.
  var byId = {};
  orders.forEach(function(o) {
    var id = String((o || {}).id || '').trim();
    if (id) byId[id] = o;
  });

  var ids = Object.keys(byId);
  var plans = [];
  var targetCache = {};

  // PREVALIDATE ALL CHANGED IDs BEFORE WRITING ANYTHING.
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var o = byId[id];

    var orderOccurrences = _p92FindOrderOccurrences(orderSheets, id);

    if (orderOccurrences.length > 1) {
      return {
        ok: false,
        message: 'Order ID trùng trong legacy: ' + id +
          ' -> ' + orderOccurrences.map(function(x) {
            return x.sheet.getName() + '!O' + x.row;
          }).join(', ')
      };
    }

    var metaOccurrences = _p92FindMetaOccurrences(metaSheet, id);

    if (metaOccurrences.length > 1) {
      return {
        ok: false,
        message: 'Meta ID trùng trong legacy: ' + id +
          ' -> rows ' + metaOccurrences.join(', ')
      };
    }

    var targetName = _p92ResolveMonthSheetName(ss, orderSheets, o.order_date);

    if (!targetName) {
      return {
        ok: false,
        message: 'Không xác định được tab tháng cho ' +
          id + ' date=' + String(o.order_date || '')
      };
    }

    plans.push({
      id: id,
      order: o,
      location: orderOccurrences.length ? orderOccurrences[0] : null,
      metaRow: metaOccurrences.length ? metaOccurrences[0] : 0,
      targetName: targetName
    });
  }

  var inserted = 0;
  var updated = 0;
  var moved = 0;
  var metaCount = 0;
  var positions = [];
  var deletions = {};
  var hadError = false;

  for (var p = 0; p < plans.length; p++) {
    var plan = plans[p];
    var id2 = plan.id;
    var o2 = plan.order;

    var target = targetCache[plan.targetName];

    if (!target) {
      target = ss.getSheetByName(plan.targetName);

      if (!target) {
        // Reuse the safe v9.1 creator only after every changed ID has passed validation.
        target = _p91FindOrCreateMonthSheet(ss, orderSheets, o2.order_date);
      }

      if (!target) {
        hadError = true;
        _p91Log('ERROR', 'v9.2 không tạo được target sheet cho ' + id2);
        continue;
      }

      targetCache[plan.targetName] = target;
    }

    var rowValues = _p91OrderRow(o2, id2);
    var targetRow = 0;

    if (plan.location &&
        plan.location.sheet.getSheetId() === target.getSheetId()) {

      // Last-second identity guard.
      var currentId = String(
        plan.location.sheet.getRange(plan.location.row, 15).getDisplayValue() || ''
      ).trim();

      if (currentId !== id2) {
        hadError = true;
        _p91Log(
          'ERROR',
          'v9.2 SKIP ' + id2 +
          ': cột O thay đổi trong lúc sync tại ' +
          plan.location.sheet.getName() + '!O' + plan.location.row
        );
        continue;
      }

      targetRow = plan.location.row;
      target.getRange(targetRow, 1, 1, 15).setValues([rowValues]);
      updated++;

    } else if (plan.location) {

      target.appendRow(rowValues);
      targetRow = target.getLastRow();
      moved++;

      var sid = String(plan.location.sheet.getSheetId());

      if (!deletions[sid]) {
        deletions[sid] = {
          sheet: plan.location.sheet,
          rows: []
        };
      }

      deletions[sid].rows.push(plan.location.row);

    } else {

      target.appendRow(rowValues);
      targetRow = target.getLastRow();
      inserted++;
    }

    try {
      _p92WriteMeta(metaSheet, plan.metaRow, o2, id2);
      metaCount++;
    } catch (e) {
      hadError = true;
      _p91Log('ERROR', 'v9.2 meta lỗi ' + id2 + ': ' + e.message);
      continue;
    }

    positions.push({
      id: id2,
      source_sheet: target.getName(),
      source_row: targetRow
    });
  }

  // Delete moved source rows from bottom to top.
  Object.keys(deletions).forEach(function(key) {
    var item = deletions[key];

    item.rows
      .sort(function(a, b) { return b - a; })
      .forEach(function(row) {
        try {
          item.sheet.deleteRow(row);
        } catch (e) {
          hadError = true;
          _p91Log(
            'WARN',
            'v9.2 không xoá được row cũ ' +
            row + ' ở ' + item.sheet.getName() + ': ' + e.message
          );
        }
      });
  });

  if (positions.length) {
    var rec = UrlFetchApp.fetch(P91_INGEST_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-ingest-secret': secret },
      payload: JSON.stringify({
        action: 'recordSheetPositions',
        updates: positions
      }),
      muteHttpExceptions: true
    });

    if (rec.getResponseCode() !== 200) {
      hadError = true;
      _p91Log(
        'WARN',
        'v9.2 recordSheetPositions HTTP ' + rec.getResponseCode()
      );
    }
  }

  return {
    ok: !hadError,
    message: hadError
      ? 'Có lỗi ghi/xoá/meta/record position; xem SYNC_LOG.'
      : '',
    inserted: inserted,
    updated: updated,
    moved: moved,
    meta: metaCount
  };
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

  metaSheet.getRange(row, 1, 1, 17).setValues([[
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
    'SYNC_WEB_PROD_V92',
    new Date()
  ]]);
}
