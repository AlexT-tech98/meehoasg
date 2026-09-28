/**
 * ═══════════════════════════════════════════════════════════
 *  MEEHOASG — Sync Sheet → Supabase (FULL VERSION)
 *  Phiên bản: 2026-09-28
 * ═══════════════════════════════════════════════════════════
 *
 *  HƯỚNG DẪN CÀI ĐẶT:
 *  1. Trong Apps Script: File → New → Script → đặt tên "SyncToSupabase"
 *  2. Paste toàn bộ file này vào
 *  3. Project Settings → Script Properties → Add:
 *       SUPABASE_INGEST_URL   = https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-ingest
 *       SUPABASE_INGEST_SECRET = <secret bạn đặt trong Supabase>
 *  4. Triggers → Add Trigger:
 *       Function: syncDelta  |  Time-driven  |  Every 5 minutes
 *  5. Chạy thủ công 1 lần: chọn syncFull → Run (để nhập bù toàn bộ)
 *
 *  GHI CHÚ:
 *  - syncDelta: chỉ quét dòng mới + N dòng lookback (dùng cho trigger)
 *  - syncFull:  quét toàn bộ tab (chạy 1 lần để backfill)
 *  - Log mỗi lần chạy ghi vào tab SYNC_LOG trong Sheet
 */

// ─── CẤU HÌNH ─────────────────────────────────────────────
// ID của Google Sheet chứa đơn hàng (lấy từ URL của Sheet)
var SPREADSHEET_ID = '1TsVOtDWrqlkjEUPGWmRudGEvGe38qLG0S62MOVDefpM';

var CFG = {
  GID_ORDER_CURRENT: 1561905505,   // gid tab đơn hiện tại (Tháng 9)
  ORDER_WIDTH: 15,                  // số cột A→O
  META_SHEET_NAME: 'MIG_ORDER_META_V6',
  BATCH_SIZE: 80,                   // đơn/request
  LOOKBACK: 30,                     // dòng quét lại để bắt update
  LOG_SHEET: 'SYNC_LOG',
};

// ─── TRIGGER CHÍNH: chạy mỗi 5 phút ──────────────────────
function syncDelta() {
  _doSync(false);
}

// ─── BACKFILL: chạy 1 lần thủ công ───────────────────────
function syncFull() {
  PropertiesService.getScriptProperties().deleteProperty('SYNC_CURSOR_' + CFG.GID_ORDER_CURRENT);
  _doSync(true);
  _log('INFO', 'syncFull hoàn tất.');
}

// ─── CORE ──────────────────────────────────────────────────
function _doSync(full) {
  var props  = PropertiesService.getScriptProperties();
  var url    = props.getProperty('SUPABASE_INGEST_URL');
  var secret = props.getProperty('SUPABASE_INGEST_SECRET');
  if (!url || !secret) { _log('ERROR', 'Chưa set SUPABASE_INGEST_URL / SUPABASE_INGEST_SECRET'); return; }

  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = _sheetByGid(ss, CFG.GID_ORDER_CURRENT);
  if (!sheet) { _log('ERROR', 'Không tìm thấy sheet gid=' + CFG.GID_ORDER_CURRENT); return; }

  var sheetName = sheet.getName();
  var lastRow   = sheet.getLastRow();
  if (lastRow < 2) { _log('INFO', sheetName + ': trống.'); return; }

  var cursorKey = 'SYNC_CURSOR_' + CFG.GID_ORDER_CURRENT;
  var saved     = Number(props.getProperty(cursorKey) || '1');
  var startRow  = full ? 2 : Math.max(2, saved - CFG.LOOKBACK + 1);
  var count     = lastRow - startRow + 1;
  if (count <= 0) { _log('INFO', sheetName + ': không có dòng mới.'); return; }

  var values = sheet.getRange(startRow, 1, count, CFG.ORDER_WIDTH).getValues();
  var meta   = _buildMetaMap(ss);

  var orders = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i], id = String(r[14] || '').trim();
    if (!id || r[1] === '' || r[1] === null) continue;
    var d = _parseDate(r[1], sheetName);
    if (!d) continue;
    var m = meta[id] || {};
    var imgs = m.images || [];
    orders.push({
      id:             id,
      sync_id:        id,
      source_sheet:   sheetName,
      source_row:     startRow + i,
      customer:       String(r[0]  || '').trim(),
      order_date:     Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd'),
      order_time:     String(r[2]  || '').trim(),
      flower:         String(r[3]  || '').trim(),
      note:           String(r[5]  || '').trim(),
      shipping:       String(r[8]  || '').trim(),
      address:        _addr(r[9]),
      phone:          _phone(r[9]) || m.phone || '',
      flower_total:   _money(r[10]),
      payment:        String(r[11] || '').trim(),
      sale:           String(r[12] || '').trim(),   // ingest function sẽ map → username
      settled:        _bool(r[13]),
      status:         _status(r),
      ship_fee:       _money(m.shipFee),
      ship_confirmed: _bool(m.shipConfirmed),
      card:           _bool(m.card),
      card_text:      String(m.cardText  || '').trim(),
      banner:         _bool(m.banner),
      banner_text:    String(m.bannerText || '').trim(),
      charm_fee:      _money(m.charmFee),
      charm_text:     String(m.charmText || '').trim(),
      paper_fee:      _money(m.paperFee),
      paper_text:     String(m.paperText || '').trim(),
      vat:            _money(m.vat),
      image_urls:     imgs,
    });
  }

  // Gửi theo batch
  var sent = 0, failed = 0, errMsg = '';
  for (var b = 0; b < orders.length; b += CFG.BATCH_SIZE) {
    var batch = orders.slice(b, b + CFG.BATCH_SIZE);
    try {
      var resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-ingest-secret': secret },
        payload: JSON.stringify({ orders: batch }),
        muteHttpExceptions: true,
      });
      var code = resp.getResponseCode();
      var body = {};
      try { body = JSON.parse(resp.getContentText() || '{}'); } catch(e) {}
      if (code === 200 && body.ok) {
        sent += (body.processed || batch.length);
      } else {
        failed += batch.length;
        errMsg = 'HTTP ' + code + ': ' + resp.getContentText().slice(0, 120);
      }
    } catch(ex) {
      failed += batch.length;
      errMsg = ex.message;
    }
  }

  props.setProperty(cursorKey, String(lastRow));
  _log(failed > 0 ? 'WARN' : 'OK',
    sheetName + ' rows ' + startRow + '-' + lastRow + ' → ' +
    orders.length + ' đơn, sent=' + sent + ', failed=' + failed +
    (errMsg ? ' [' + errMsg + ']' : ''));
}

// ─── ĐỌC ORDER_META ────────────────────────────────────────
function _buildMetaMap(ss) {
  var map = {};
  try {
    var sh = ss.getSheetByName(CFG.META_SHEET_NAME) || ss.getSheetByName('ORDER_META');
    if (!sh || sh.getLastRow() < 2) return map;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 17).getValues();
    rows.forEach(function(r) {
      var id = String(r[0] || '').trim();
      if (!id) return;
      var imgs = [];
      try { imgs = JSON.parse(r[14] || '[]'); } catch(e) {}
      map[id] = {
        shipFee: r[2], shipConfirmed: r[3],
        card: r[4], cardText: r[5],
        banner: r[6], bannerText: r[7],
        charmFee: r[8], charmText: r[9],
        paperFee: r[10], paperText: r[11],
        vat: r[12], phone: String(r[13] || '').trim(),
        images: Array.isArray(imgs) ? imgs.filter(Boolean) : [],
      };
    });
  } catch(e) { _log('WARN', '_buildMetaMap: ' + e.message); }
  return map;
}

// ─── HELPER ────────────────────────────────────────────────
function _sheetByGid(ss, gid) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === gid) return sheets[i];
  return null;
}
function _parseDate(v, sheetName) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') { var d = new Date((v - 25569) * 86400000); return isNaN(d.getTime()) ? null : d; }
  var s = String(v).trim(), m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}
function _phone(v) { var m = String(v || '').match(/(?:SĐT|SDT)\s*:\s*([^\n]+)/i); return m ? m[1].trim() : ''; }
function _addr(v) { return String(v || '').replace(/(?:SĐT|SDT)\s*:\s*[^\n]+\n?/i, '').replace(/^Địa chỉ\s*:\s*/i, '').trim(); }
function _money(v) { if (typeof v === 'number') return isFinite(v) ? v : 0; var n = Number(String(v || '0').replace(/[^\d.,-]/g, '').replace(',', '.')); return isFinite(n) ? n : 0; }
function _bool(v) { return v === true || v === 1 || ['true','yes','1','x'].indexOf(String(v || '').trim().toLowerCase()) >= 0; }
function _status(r) { return _bool(r[7]) ? 'Đã giao' : _bool(r[6]) ? 'Đã bó' : 'Chờ bó'; }
function _log(level, msg) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var log = ss.getSheetByName(CFG.LOG_SHEET);
  if (!log) { log = ss.insertSheet(CFG.LOG_SHEET); log.getRange(1,1,1,3).setValues([['Thời gian','Level','Nội dung']]); }
  log.appendRow([new Date(), level, msg]);
  Logger.log('[' + level + '] ' + msg);
}
