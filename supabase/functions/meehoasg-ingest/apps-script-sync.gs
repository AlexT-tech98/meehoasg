/**
 * ═══════════════════════════════════════════════════════════
 *  MEEHOASG — Sync Sheet → Supabase  (ALL MONTHS)
 *  Phiên bản: 2026-09-29 v2 (Fix Time, Money, Images, KPI)
 * ═══════════════════════════════════════════════════════════
 *
 *  HƯỚNG DẪN CÀI ĐẶT:
 *  1. Paste toàn bộ file này vào Apps Script Editor
 *  2. Project Settings → Script Properties:
 *       SUPABASE_INGEST_URL    = https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-ingest
 *       SUPABASE_INGEST_SECRET = <secret>
 *       (Tùy chọn) DATABASE_SPREADSHEET_ID = <id sheet database nếu có riêng>
 *       (Tùy chọn) ORDER_SHEET_NAMES       = <09/2026,08/2026,...> (bỏ trống = tự tìm)
 *  3. Chạy hàm syncFull để đồng bộ lại toàn bộ dữ liệu chuẩn xác
 *  4. Bật Trigger: syncDelta chạy mỗi 1 hoặc 5 phút
 */

// ─── CẤU HÌNH ─────────────────────────────────────────────
var SPREADSHEET_ID = '1TsVOtDWrqlkjEUPGWmRudGEvGe38qLG0S62MOVDefpM';

var CFG = {
  ORDER_WIDTH:      15,                  // cột A→O
  META_SHEET_NAME:  'MIG_ORDER_META_V6', // tab ORDER_META
  BATCH_SIZE:       80,                  // đơn / request
  LOOKBACK:         30,                  // dòng quét lại (bắt update)
  LOG_SHEET:        'SYNC_LOG',
};

// ─── TRIGGER CHÍNH: mỗi 1 - 5 phút ────────────────────────
function syncDelta() { _doSync(false); }

// ─── BACKFILL: chạy 1 lần thủ công để nạp lại chuẩn ────────
function syncFull() {
  var props = PropertiesService.getScriptProperties();
  var keys  = props.getKeys();
  keys.filter(function(k){ return k.indexOf('SYNC_CURSOR_') === 0; })
      .forEach(function(k){ props.deleteProperty(k); });
  _doSync(true);
  _log('INFO', 'syncFull hoàn tất.');
}

// ─── CORE ─────────────────────────────────────────────────
function _doSync(full) {
  var props  = PropertiesService.getScriptProperties();
  var url    = props.getProperty('SUPABASE_INGEST_URL');
  var secret = props.getProperty('SUPABASE_INGEST_SECRET');
  if (!url || !secret) {
    _log('ERROR', 'Chưa set SUPABASE_INGEST_URL / SUPABASE_INGEST_SECRET');
    return;
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var orderSheetNames = _getOrderSheetNames(props, ss);
  if (!orderSheetNames.length) {
    _log('ERROR', 'Không tìm thấy tab đơn hàng nào.');
    return;
  }

  var meta = _buildMetaMap(ss, props);

  for (var s = 0; s < orderSheetNames.length; s++) {
    var sheetName = orderSheetNames[s];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) { _log('WARN', 'Tab không tồn tại: ' + sheetName); continue; }
    _syncSheet(sheet, meta, url, secret, props, full);
  }
}

// Lấy danh sách tên tab đơn hàng
function _getOrderSheetNames(props, ss) {
  var raw = props.getProperty('ORDER_SHEET_NAMES') || '';
  if (raw.trim()) {
    return raw.split(/[\n,]+/).map(function(x){ return x.trim(); }).filter(Boolean);
  }
  return ss.getSheets()
    .map(function(sh){ return sh.getName(); })
    .filter(function(n){
      return /\d{1,2}\/\d{4}/.test(n) || /^(?:Đơn\s*|Tháng\s*)\d/i.test(n);
    });
}

function _syncSheet(sheet, meta, url, secret, props, full) {
  var sheetName = sheet.getName();
  var lastRow   = sheet.getLastRow();
  if (lastRow < 2) return;

  var cursorKey = 'SYNC_CURSOR_' + sheetName.replace(/[\/\s]/g, '_');
  var saved     = Number(props.getProperty(cursorKey) || '1');
  var startRow  = full ? 2 : Math.max(2, saved - CFG.LOOKBACK + 1);
  var count     = lastRow - startRow + 1;
  if (count <= 0) return;

  var values     = sheet.getRange(startRow, 1, count, CFG.ORDER_WIDTH).getValues();
  var richValues = sheet.getRange(startRow, 5, count, 1).getRichTextValues();
  var dispValues = sheet.getRange(startRow, 5, count, 1).getDisplayValues();

  var orders = [];
  for (var i = 0; i < values.length; i++) {
    var r        = values[i];
    var customer = String(r[0] || '').trim();
    var id       = String(r[14] || '').trim();

    // Bỏ qua dòng trống cả tên khách lẫn Order ID
    if (!customer && !id) continue;
    if (r[1] === '' || r[1] === null) continue;

    var d = _parseDate(r[1]);
    if (!d) continue;

    // Nếu dòng chưa có Order ID (tạo tay trên Sheet) -> tự cấp ID tương thích bản cũ
    if (!id) id = 'LEGACY-' + sheet.getSheetId() + '-' + (startRow + i);

    var m = meta[id] || {};
    var fallbackImgs = _imageUrlsFromRichText(richValues[i] && richValues[i][0], dispValues[i] && dispValues[i][0]);
    var metaImgs     = m.images || [];
    var combinedImgs = metaImgs.concat(fallbackImgs);
    var seenImg = {};
    var imgs = combinedImgs.filter(function(u) {
      if (!u || seenImg[u]) return false;
      seenImg[u] = true;
      return true;
    });

    orders.push({
      id:             id,
      sync_id:        id,
      source_sheet:   sheetName,
      source_row:     startRow + i,
      customer:       customer,
      order_date:     Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd'),
      order_time:     _time(r[2]),
      flower:         String(r[3]  || '').trim(),
      note:           String(r[5]  || '').trim(),
      shipping:       String(r[8]  || '').trim(),
      address:        _addr(r[9]),
      phone:          _phone(r[9]) || m.phone || '',
      flower_total:   _money(r[10]),
      payment:        String(r[11] || '').trim(),
      sale:           String(r[12] || '').trim(),
      settled:        _bool(r[13]),
      status:         _status(r),
      ship_fee:       _money(m.shipFee),
      ship_confirmed: _bool(m.shipConfirmed),
      card:           _bool(m.card),
      card_text:      String(m.cardText   || '').trim(),
      banner:         _bool(m.banner),
      banner_text:    String(m.bannerText || '').trim(),
      charm_fee:      _money(m.charmFee),
      charm_text:     String(m.charmText  || '').trim(),
      paper_fee:      _money(m.paperFee),
      paper_text:     String(m.paperText  || '').trim(),
      vat:            _money(m.vat),
      image_urls:     imgs,
    });
  }

  if (!orders.length) { props.setProperty(cursorKey, String(lastRow)); return; }

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
    '[' + sheetName + '] rows ' + startRow + '-' + lastRow +
    ' → ' + orders.length + ' đơn, sent=' + sent + ', failed=' + failed +
    (errMsg ? ' [' + errMsg + ']' : ''));
}

// ─── ĐỌC ORDER_META ────────────────────────────────────────
function _buildMetaMap(ss, props) {
  var map = {};
  try {
    var dbId = props.getProperty('DATABASE_SPREADSHEET_ID');
    var targetSs = ss;
    if (dbId) {
      try { targetSs = SpreadsheetApp.openById(dbId); } catch(err) { _log('WARN', 'Không mở được DATABASE_SPREADSHEET_ID: ' + err.message); }
    }
    var sh = targetSs.getSheetByName(CFG.META_SHEET_NAME) || targetSs.getSheetByName('ORDER_META') ||
             ss.getSheetByName(CFG.META_SHEET_NAME) || ss.getSheetByName('ORDER_META');
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

// Trích xuất link ảnh từ RichText & Hyperlink của cột Mẫu hoa
function _imageUrlsFromRichText(rt, txt) {
  var out = [];
  if (rt) {
    try {
      if (rt.getLinkUrl && rt.getLinkUrl()) out.push(rt.getLinkUrl());
      if (rt.getRuns) {
        rt.getRuns().forEach(function(run) {
          var u = run.getLinkUrl();
          if (u) out.push(u);
        });
      }
    } catch(e) {}
  }
  var source = (rt && rt.getText) ? rt.getText() : String(txt || '');
  var m = source.match(/https?:\/\/[^\s"'>]+/g);
  if (m) out = out.concat(m);
  var seen = {};
  return out.filter(function(u) {
    u = String(u || '').trim();
    if (!/^https?:\/\//i.test(u) || seen[u]) return false;
    seen[u] = true;
    return true;
  });
}

// ─── HELPER ────────────────────────────────────────────────
function _time(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Ho_Chi_Minh', 'HH:mm');
  var s = String(v || '').trim();
  if (s.indexOf('1899') >= 0 || s.indexOf('GMT') >= 0) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'HH:mm');
  }
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return ('0' + m[1]).slice(-2) + ':' + m[2];
  return s.slice(0, 5);
}

function _parseDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    var d = new Date((v - 25569) * 86400000);
    return isNaN(d.getTime()) ? null : d;
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

function _phone(v) {
  var m = String(v || '').match(/(?:SĐT|SDT)\s*:\s*([^\n]+)/i);
  return m ? m[1].trim() : '';
}

function _addr(v) {
  return String(v || '')
    .replace(/(?:SĐT|SDT)\s*:\s*[^\n]+\n?/i, '')
    .replace(/^Địa chỉ\s*:\s*/i, '').trim();
}

function _money(v) {
  if (typeof v === 'number') return isFinite(v) ? Math.round(v) : 0;
  var s = String(v || '').trim().replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.indexOf('.') >= 0 && s.indexOf(',') >= 0) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(?:[.,]\d{3})+$/.test(s)) {
    s = s.replace(/[.,]/g, '');
  } else {
    s = s.replace(',', '.');
  }
  var n = Number(s);
  return isFinite(n) ? Math.round(n) : 0;
}

function _bool(v) {
  return v === true || v === 1 ||
    ['true','yes','1','x'].indexOf(String(v || '').trim().toLowerCase()) >= 0;
}

function _status(r) {
  return _bool(r[7]) ? 'Đã giao' : _bool(r[6]) ? 'Đã bó' : 'Chờ bó';
}

function _log(level, msg) {
  var ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  var log = ss.getSheetByName(CFG.LOG_SHEET);
  if (!log) {
    log = ss.insertSheet(CFG.LOG_SHEET);
    log.getRange(1, 1, 1, 3).setValues([['Thời gian', 'Level', 'Nội dung']]);
  }
  log.appendRow([new Date(), level, msg]);
  Logger.log('[' + level + '] ' + msg);
}
