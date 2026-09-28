/**
 * Add this file to the EXISTING Meehoa Manager Apps Script project. It uses
 * Code.gs's production sheet selectors and order parser. Existing deployment
 * and employee login are unaffected until the trigger is enabled.
 * Script properties: SUPABASE_INGEST_URL and SUPABASE_INGEST_SECRET.
 */
var MEE_SYNC_BATCH = 80;
var MEE_SYNC_DEADLINE_MS = 4 * 60 * 1000;

function syncNewOrdersToSupabase() { return meeSyncOrders_(false); }
function backfillAllOrders() { return meeSyncOrders_(true); }

function meeSyncOrders_(full) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Đồng bộ khác đang chạy.');
  try {
    var started = Date.now(), props = PropertiesService.getScriptProperties();
    var url = props.getProperty('SUPABASE_INGEST_URL');
    var secret = props.getProperty('SUPABASE_INGEST_SECRET');
    if (!url || !secret) throw new Error('Thiếu SUPABASE_INGEST_URL hoặc SUPABASE_INGEST_SECRET.');
    var allSheets = orderSheets_(); // Configured live order tabs, not backups.
    var meta = metaMap_();          // Canonical MIG_ORDER_META_V6 in DATABASE_SPREADSHEET_ID.
    var syncIds = meeSyncIds_(allSheets);
    var selected = full ? allSheets : meeSyncActiveSheets_(allSheets, props);
    var sheetCursor = full ? Number(props.getProperty('MEE_BACKFILL_SHEET') || 0) : 0;
    var rowCursor = full ? Number(props.getProperty('MEE_BACKFILL_ROW') || 2) : 2;
    var stats = { sent: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, sheets: [] };

    for (var si = sheetCursor; si < selected.length; si++) {
      var sh = selected[si], last = orderDataLastRow_(sh), row = (si === sheetCursor ? rowCursor : 2);
      if (last < 2) { stats.sheets.push(sh.getName()); continue; }
      for (; row <= last; row += MEE_SYNC_BATCH) {
        if (Date.now() - started > MEE_SYNC_DEADLINE_MS) {
          if (full) meeSaveBackfillCursor_(props, si, row);
          meeSyncLog_('PARTIAL', 'Đã gửi ' + stats.sent + ' đơn; tiếp tục tại ' + sh.getName() + ' dòng ' + row);
          return { ok: true, done: false, stats: stats };
        }
        var count = Math.min(MEE_SYNC_BATCH, last - row + 1);
        var values = sh.getRange(row, 1, count, APP.ORDER_WIDTH).getValues();
        var rich = sh.getRange(row, 5, count, 1).getRichTextValues();
        var orders = [];
        for (var i = 0; i < values.length; i++) {
          var raw = values[i], id = clean_(raw[14]), date = sheetDateValue_(raw[1]);
          if (!id || !date) { stats.skipped++; continue; }
          var fallback = imageUrlsFromRichText_(rich[i][0], raw[4]);
          var order = orderObject_(raw, sh, row + i, meta, {}, fallback, date);
          orders.push({
            id: id, sync_id: syncIds[sh.getSheetId() + ':' + (row + i)] || id,
            source_sheet: sh.getName(), source_row: row + i,
            customer: order.customer, phone: order.phone,
            order_date: order.date, order_time: order.time,
            flower: order.flower, note: order.note,
            shipping: order.shipping, address: order.address,
            flower_total: order.flowerTotal, payment: order.payment,
            sale: order.sale, status: order.status,
            settled: order.settled, ship_fee: order.shipFee,
            ship_confirmed: order.shipConfirmed,
            card: order.card, card_text: order.cardText,
            banner: order.banner, banner_text: order.bannerText,
            charm_fee: order.charmFee, charm_text: order.charmText,
            paper_fee: order.paperFee, paper_text: order.paperText,
            vat: order.vat, image_urls: order.driveUrls
          });
        }
        if (orders.length) {
          var response = UrlFetchApp.fetch(url, {
            method: 'post', contentType: 'application/json',
            headers: { 'x-ingest-secret': secret },
            payload: JSON.stringify({ orders: orders }), muteHttpExceptions: true
          });
          var body;
          try { body = JSON.parse(response.getContentText()); } catch (e) { body = {}; }
          if (response.getResponseCode() !== 200 || body.ok !== true || body.processed !== orders.length)
            throw new Error('Batch ' + sh.getName() + ':' + row + ' bị từ chối (HTTP ' + response.getResponseCode() + ').');
          stats.sent += orders.length;
          stats.inserted += Number(body.inserted || 0);
          stats.updated += Number(body.updated || 0);
          stats.unchanged += Number(body.unchanged || 0);
        }
        if (full) meeSaveBackfillCursor_(props, si, row + count);
      }
      stats.sheets.push(sh.getName());
    }
    if (full) { props.deleteProperty('MEE_BACKFILL_SHEET'); props.deleteProperty('MEE_BACKFILL_ROW'); }
    props.setProperty('MEE_LAST_SYNC_AT', new Date().toISOString());
    meeSyncLog_('OK', 'Đã quét ' + stats.sheets.join(', ') + '; gửi ' + stats.sent +
      ', thêm ' + stats.inserted + ', cập nhật ' + stats.updated + ', không đổi ' + stats.unchanged + '.');
    return { ok: true, done: true, stats: stats };
  } catch (error) {
    meeSyncLog_('ERROR', String(error && error.message || error));
    throw error;
  } finally { lock.releaseLock(); }
}

function meeSaveBackfillCursor_(props, sheetIndex, row) {
  props.setProperty('MEE_BACKFILL_SHEET', String(sheetIndex));
  props.setProperty('MEE_BACKFILL_ROW', String(row));
}

function meeSyncActiveSheets_(allSheets, props) {
  var now = new Date(), month = now.getFullYear() * 12 + now.getMonth();
  var current = [], older = [];
  allSheets.forEach(function(sh) {
    var match = sh.getName().match(/(\d{1,2})\/(\d{4})/);
    if (!match) { current.push(sh); return; }
    var value = Number(match[2]) * 12 + Number(match[1]) - 1;
    if (value >= month - 1) current.push(sh); else older.push(sh);
  });
  if (older.length) {
    var next = Number(props.getProperty('MEE_OLDER_SHEET_CURSOR') || 0) % older.length;
    current.push(older[next]);
    props.setProperty('MEE_OLDER_SHEET_CURSOR', String((next + 1) % older.length));
  }
  return current;
}

function meeSyncIds_(sheets) {
  var seen = {}, ids = {};
  sheets.forEach(function(sh) {
    var last = orderDataLastRow_(sh);
    if (last < 2) return;
    var values = sh.getRange(2, 15, last - 1, 1).getDisplayValues();
    values.forEach(function(entry, index) {
      var id = clean_(entry[0]), row = index + 2;
      if (!id) return;
      ids[sh.getSheetId() + ':' + row] = seen[id] ? id + '-DUP-' + row : id;
      seen[id] = true;
    });
  });
  return ids;
}

function meeSyncLog_(level, message) {
  Logger.log('MEE_SYNC ' + level + ': ' + message);
  try {
    var ss = orderSs_(), sh = ss.getSheetByName('SYNC_LOG');
    if (!sh) {
      sh = ss.insertSheet('SYNC_LOG');
      sh.getRange(1, 1, 1, 3).setValues([['Thời gian', 'Level', 'Nội dung']]);
      sh.setFrozenRows(1);
    }
    sh.appendRow([new Date(), level, message]);
  } catch (ignored) { Logger.log('MEE_SYNC logging failed: ' + ignored.message); }
}
