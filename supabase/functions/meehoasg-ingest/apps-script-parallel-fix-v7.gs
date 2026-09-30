/**
 * MEEHOASG — PARALLEL FIX ADD-ON
 * Version: 2026-09-30 v7
 *
 * Run order:
 *   1) Replace main sync with apps-script-sync.gs v6 first.
 *   2) Add this file to the SAME Apps Script project.
 *   3) Run installAndRepairParallelSync() ONCE.
 *
 * What this add-on does:
 *   - Sync legacy Payment Check / settlement rows:
 *       MEE_OPS_DATABASE/MIG_SETTLEMENT_V6 -> Supabase settlement_requests
 *   - Installs a dedicated 5-minute settlement sync trigger.
 *   - Recovers the two known stale production orders by Order ID only:
 *       MEE-260930163302-23FEA2F7 (Vũ Nhật Minh)
 *       MEE-260929205654-51071A45 (Hoài Mơ)
 *   - Updates Supabase source_sheet/source_row after recovery.
 *
 * IMPORTANT:
 *   - This file NEVER uses source_row to locate an order row.
 *   - Order ID in column O is the only row identity.
 */

var SETTLEMENT_INGEST_URL =
  'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-settlement-ingest';

function installAndRepairParallelSync() {
  var props = PropertiesService.getScriptProperties();
  var dbId = String(props.getProperty('DATABASE_SPREADSHEET_ID') || '').trim();
  if (!dbId) {
    throw new Error('Thiếu DATABASE_SPREADSHEET_ID. Dừng để bảo vệ production.');
  }

  _log('INFO', 'V7 bootstrap: bắt đầu Payment Check sync + stale mapping repair.');

  syncLegacySettlementsToSupabase();
  recoverKnownStaleProductionOrders();
  installLegacySettlementTrigger();

  _log('OK', 'V7 bootstrap hoàn tất.');
}

function installLegacySettlementTrigger() {
  var fn = 'syncLegacySettlementsToSupabase';
  var triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function(t) {
    if (t.getHandlerFunction && t.getHandlerFunction() === fn) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger(fn)
    .timeBased()
    .everyMinutes(5)
    .create();

  _log('OK', 'Đã cài trigger Payment Check legacy→Supabase mỗi 5 phút.');
}

function syncLegacySettlementsToSupabase() {
  var props = PropertiesService.getScriptProperties();
  var cfg = _getIngestConfig(props);

  if (!cfg.secret) {
    _log('ERROR', 'Settlement sync: thiếu SUPABASE_INGEST_SECRET.');
    return;
  }

  var dbSs = _getAuxSpreadsheet(props);
  if (!dbSs) return;

  var sh = dbSs.getSheetByName('MIG_SETTLEMENT_V6');
  if (!sh) {
    _log('WARN', 'Settlement sync: không tìm thấy MIG_SETTLEMENT_V6.');
    return;
  }

  var lastRow = sh.getLastRow();
  if (lastRow < 2) {
    _log('INFO', 'Settlement sync: chưa có dữ liệu.');
    return;
  }

  var rows = sh.getRange(2, 1, lastRow - 1, 19).getValues();
  var settlements = [];

  rows.forEach(function(r) {
    var id = String(r[0] || '').trim();
    var orderId = String(r[1] || '').trim();
    if (!id || !orderId) return;

    var bills = [];
    try {
      var parsed = JSON.parse(String(r[11] || '[]'));
      if (Array.isArray(parsed)) bills = parsed.filter(Boolean);
    } catch (e) {}

    settlements.push({
      id: id,
      order_id: orderId,
      sale_username: String(r[4] || '').trim(),
      sale_name: String(r[5] || '').trim(),
      flower_total: _money(r[6]),
      accessory_total: _money(r[7]),
      vat: _money(r[8]),
      ship_fee: _money(r[9]),
      required_amount: _money(r[10]),
      bill_urls: bills,
      note: String(r[12] || '').trim(),
      status: String(r[13] || 'PENDING').trim().toUpperCase(),
      submitted_at: _legacySettlementDate(r[14]),
      admin_username: String(r[15] || '').trim(),
      admin_name: String(r[16] || '').trim(),
      reviewed_at: _legacySettlementDate(r[17]),
      rejection_reason: String(r[18] || '').trim()
    });
  });

  if (!settlements.length) {
    _log('INFO', 'Settlement sync: không có request hợp lệ.');
    return;
  }

  var sent = 0;
  var failed = 0;
  var approved = 0;
  var batchSize = 80;

  for (var i = 0; i < settlements.length; i += batchSize) {
    var batch = settlements.slice(i, i + batchSize);

    try {
      var resp = UrlFetchApp.fetch(SETTLEMENT_INGEST_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-ingest-secret': cfg.secret },
        payload: JSON.stringify({ settlements: batch }),
        muteHttpExceptions: true
      });

      var code = resp.getResponseCode();
      var body = {};
      try {
        body = JSON.parse(resp.getContentText() || '{}');
      } catch (e) {}

      if (code === 200 && body.ok) {
        sent += Number(body.processed || batch.length);
        approved += Number(body.approvedOrders || 0);
      } else {
        failed += batch.length;
        _log(
          'WARN',
          'Settlement batch lỗi HTTP ' + code + ': ' +
          resp.getContentText().slice(0, 180)
        );
      }
    } catch (e) {
      failed += batch.length;
      _log('WARN', 'Settlement batch exception: ' + e.message);
    }
  }

  _log(
    failed ? 'WARN' : 'OK',
    'Settlement legacy→Supabase: tổng ' + settlements.length +
    ', sent=' + sent +
    ', failed=' + failed +
    ', approvedOrders=' + approved
  );
}

function _legacySettlementDate(v) {
  if (!v) return '';

  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(
      v,
      'Asia/Ho_Chi_Minh',
      "yyyy-MM-dd'T'HH:mm:ssXXX"
    );
  }

  var s = String(v || '').trim();
  if (!s) return '';

  var m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (!m) return s;

  return (
    m[3] + '-' +
    ('0' + m[2]).slice(-2) + '-' +
    ('0' + m[1]).slice(-2) + 'T' +
    ('0' + (m[4] || '00')).slice(-2) + ':' +
    (m[5] || '00') + ':' +
    (m[6] || '00') +
    '+07:00'
  );
}

function recoverKnownStaleProductionOrders() {
  var props = PropertiesService.getScriptProperties();
  var cfg = _getIngestConfig(props);
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  var recovery = [
    {
      id: 'MEE-260930163302-23FEA2F7',
      sheet: 'Tháng 09/2026',
      customer: 'vũ nhật minh',
      date: '30/09/2026',
      time: '20:00',
      flower: 'ohara đtien như mẫu',
      image: 'https://drive.google.com/uc?export=view&id=14D5_QEAze1MQScEGZCGfH3LeQoWNLwiZ',
      note: '',
      status: 'Đã giao',
      shipping: 'Ghé lấy',
      contact: 'SĐT: 0372806179',
      flowerTotal: 350000,
      payment: 'Đã thanh toán đủ (Full)',
      sale: 'C Mụi',
      settled: false
    },
    {
      id: 'MEE-260929205654-51071A45',
      sheet: 'Tháng 09/2026',
      customer: 'Hoài Mơ',
      date: '30/09/2026',
      time: '20:30',
      flower: 'Lam tinh phối phăng tone xanh - trắng 400k + đính nơ voan XANH lên hoa ảnh 3 - gói trễ thui khách để mai mới tặng',
      image: 'https://drive.google.com/uc?export=view&id=178gNR7yMZl8CNyua5gsFxlZC59AaOo5Q',
      note: 'happy birthday babi iu ❤️',
      status: 'Đã giao',
      shipping: 'Ghé lấy',
      contact: 'SĐT: 0969557496',
      flowerTotal: 400000,
      payment: 'Đã cọc 200.000 đ',
      sale: 'Huỳnh Xuyến',
      settled: false
    }
  ];

  var updates = [];
  var appended = 0;
  var alreadyPresent = 0;

  recovery.forEach(function(o) {
    var sh = ss.getSheetByName(o.sheet);
    if (!sh) {
      _log('ERROR', 'RECOVERY: không tìm thấy tab ' + o.sheet + ' cho ' + o.id);
      return;
    }

    var lastRow = sh.getLastRow();
    var existingRow = 0;

    if (lastRow >= 2) {
      var ids = sh.getRange(2, 15, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0] || '').trim() === o.id) {
          existingRow = i + 2;
          break;
        }
      }
    }

    if (existingRow) {
      updates.push({
        id: o.id,
        source_sheet: sh.getName(),
        source_row: existingRow
      });
      alreadyPresent++;
      _log(
        'INFO',
        'RECOVERY: ' + o.id +
        ' đã có ở row ' + existingRow +
        '; không append duplicate.'
      );
      return;
    }

    var packed = o.status === 'Đã bó' || o.status === 'Đã giao';
    var delivered = o.status === 'Đã giao';

    sh.appendRow([
      o.customer,
      o.date,
      o.time,
      o.flower,
      o.image,
      o.note,
      packed,
      delivered,
      o.shipping,
      o.contact,
      o.flowerTotal,
      o.payment,
      o.sale,
      o.settled,
      o.id
    ]);

    var newRow = sh.getLastRow();
    var actualId = String(sh.getRange(newRow, 15).getValue() || '').trim();
    if (actualId !== o.id) {
      throw new Error(
        'RECOVERY verify fail tại row ' + newRow +
        ': expected ' + o.id +
        ', got ' + actualId
      );
    }

    updates.push({
      id: o.id,
      source_sheet: sh.getName(),
      source_row: newRow
    });

    appended++;
    _log(
      'OK',
      'RECOVERY: phục hồi ' + o.id +
      ' vào ' + sh.getName() +
      ' row ' + newRow
    );
  });

  SpreadsheetApp.flush();

  if (updates.length && cfg.secret) {
    var resp = UrlFetchApp.fetch(cfg.url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-ingest-secret': cfg.secret },
      payload: JSON.stringify({
        action: 'recordSheetPositions',
        updates: updates
      }),
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      throw new Error(
        'RECOVERY: không cập nhật được source_row Supabase. HTTP ' +
        resp.getResponseCode() + ': ' +
        resp.getContentText().slice(0, 180)
      );
    }
  }

  _auditRecoveredOrderIds(recovery);

  _log(
    'OK',
    'RECOVERY hoàn tất: appended=' + appended +
    ', alreadyPresent=' + alreadyPresent +
    ', positionUpdates=' + updates.length
  );
}

function _auditRecoveredOrderIds(recovery) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  recovery.forEach(function(o) {
    var sh = ss.getSheetByName(o.sheet);
    if (!sh || sh.getLastRow() < 2) return;

    var ids = sh.getRange(2, 15, sh.getLastRow() - 1, 1).getValues();
    var found = [];

    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() === o.id) {
        found.push(i + 2);
      }
    }

    if (found.length !== 1) {
      throw new Error(
        'AUDIT: ' + o.id +
        ' phải xuất hiện đúng 1 lần trong cột O, hiện found=' +
        JSON.stringify(found)
      );
    }

    _log(
      'OK',
      'AUDIT: ' + o.id +
      ' unique tại row ' + found[0]
    );
  });
}
