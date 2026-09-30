/**
 * MEEHOASG — LEGACY SETTLEMENT SYNC ADD-ON
 * Parallel test phase only: MEE_OPS_DATABASE/MIG_SETTLEMENT_V6 -> Supabase
 *
 * Requires existing Script Properties from apps-script-sync.gs:
 *   DATABASE_SPREADSHEET_ID
 *   SUPABASE_INGEST_SECRET (or existing fallback secret name)
 */

var SETTLEMENT_INGEST_URL = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-settlement-ingest';

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

  // Full scan intentionally: settlement status can change in-place days later
  // (PENDING -> APPROVED/REJECTED), so row cursor alone is unsafe.
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

  var sent = 0, failed = 0, approved = 0;
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
      try { body = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
      if (code === 200 && body.ok) {
        sent += Number(body.processed || batch.length);
        approved += Number(body.approvedOrders || 0);
      } else {
        failed += batch.length;
        _log('WARN', 'Settlement batch lỗi HTTP ' + code + ': ' + resp.getContentText().slice(0, 160));
      }
    } catch (e) {
      failed += batch.length;
      _log('WARN', 'Settlement batch exception: ' + e.message);
    }
  }

  _log(failed ? 'WARN' : 'OK', 'Settlement legacy→Supabase: tổng ' + settlements.length + ', sent=' + sent + ', failed=' + failed + ', approvedOrders=' + approved);
}

function _legacySettlementDate(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, 'Asia/Ho_Chi_Minh', "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  var s = String(v || '').trim();
  if (!s) return '';
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return s;
  return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + 'T' + ('0' + (m[4] || '00')).slice(-2) + ':' + (m[5] || '00') + ':' + (m[6] || '00') + '+07:00';
}
