/**
 * MEEHOASG — Đồng bộ Sheet → Supabase
 * Dán toàn bộ file này vào Apps Script project cũ (tab mới, không xóa code cũ).
 * Sau đó bật trigger: syncNewOrdersToSupabase chạy mỗi 5 phút.
 *
 * Script Properties cần set (Project Settings → Script Properties):
 *   SUPABASE_INGEST_URL  = https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-ingest
 *   SUPABASE_INGEST_SECRET = <chuỗi bí mật — đặt cùng với INGEST_SECRET bên Supabase>
 *
 * Không ghi URL hay secret vào code. Không commit file này lên Git.
 */

// ─── Hằng số ────────────────────────────────────────────────
var SYNC_PROP_LAST_ROW   = 'SYNC_LAST_ROW_';   // prefix + sheetName
var SYNC_PROP_LAST_TIME  = 'SYNC_LAST_RUN';
var SYNC_LOG_SHEET       = 'SYNC_LOG';
var ORDER_SHEET_GID      = 1561905505;           // tab Tháng 9/2026
var ORDER_WIDTH          = 15;                   // cột A→O
var INGEST_BATCH         = 100;                  // đơn/request
var LOOKBACK_ROWS        = 50;                   // quét lại N dòng để bắt update

// ─── Hàm chính: chạy bởi trigger ────────────────────────────
function syncNewOrdersToSupabase() {
  var props   = PropertiesService.getScriptProperties();
  var url     = props.getProperty('SUPABASE_INGEST_URL');
  var secret  = props.getProperty('SUPABASE_INGEST_SECRET');
  if (!url || !secret) {
    logSync_('ERROR', 'Chưa set SUPABASE_INGEST_URL hoặc SUPABASE_INGEST_SECRET.');
    return;
  }

  // Đọc sheet đơn hàng tháng 9
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getSheetByGid_(ss, ORDER_SHEET_GID);
  if (!sheet) {
    logSync_('ERROR', 'Không tìm thấy sheet gid=' + ORDER_SHEET_GID);
    return;
  }

  var sheetName = sheet.getName();
  var lastRow   = sheet.getLastRow();
  if (lastRow < 2) { logSync_('INFO', sheetName + ': không có dữ liệu.'); return; }

  // Tìm dòng bắt đầu quét (lấy từ property, trừ LOOKBACK_ROWS để bắt update)
  var propKey    = SYNC_PROP_LAST_ROW + sheetName;
  var savedLast  = Number(props.getProperty(propKey) || '1');
  var startRow   = Math.max(2, savedLast - LOOKBACK_ROWS + 1);
  var rowCount   = lastRow - startRow + 1;
  if (rowCount <= 0) { logSync_('INFO', sheetName + ': không có dòng mới.'); return; }

  // Đọc dữ liệu chính (A:O) và ORDER_META
  var values   = sheet.getRange(startRow, 1, rowCount, ORDER_WIDTH).getValues();
  var metaMap  = buildMetaMap_(ss);

  // Cũng cần đọc rich text ảnh từ cột E nếu có
  var richCol5 = null;
  try { richCol5 = sheet.getRange(startRow, 5, rowCount, 1).getRichTextValues(); } catch(e) {}

  var orders = [];
  for (var i = 0; i < values.length; i++) {
    var r   = values[i];
    var id  = String(r[14] || '').trim();
    var rawDate = r[1];
    if (!id || rawDate === '' || rawDate === null) continue;

    var d = parseDateCell_(rawDate, sheetName);
    if (!d) continue;

    var meta = metaMap[id] || {};
    var images = meta.images || [];
    // Thử đọc ảnh từ rich text nếu có
    if (!images.length && richCol5 && richCol5[i]) {
      images = extractRichUrls_(richCol5[i][0]);
    }

    orders.push({
      id:             id,
      source_sheet:   sheetName,
      source_row:     startRow + i,
      customer:       String(r[0] || '').trim(),
      order_date:     Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd'),
      order_time:     String(r[2] || '').trim(),
      flower:         String(r[3] || '').trim(),
      note:           String(r[5] || '').trim(),
      shipping:       String(r[8] || '').trim(),
      address:        extractAddress_(r[9]),
      phone:          extractPhone_(r[9]) || meta.phone || '',
      flower_total:   parseMoney_(r[10]),
      payment:        String(r[11] || '').trim(),
      sale:           String(r[12] || '').trim(),
      settled:        parseBool_(r[13]),
      status:         deriveStatus_(r),
      ship_fee:       parseMoney_(meta.shipFee),
      ship_confirmed: parseBool_(meta.shipConfirmed),
      card:           parseBool_(meta.card),
      card_text:      String(meta.cardText || '').trim(),
      banner:         parseBool_(meta.banner),
      banner_text:    String(meta.bannerText || '').trim(),
      charm_fee:      parseMoney_(meta.charmFee),
      charm_text:     String(meta.charmText || '').trim(),
      paper_fee:      parseMoney_(meta.paperFee),
      paper_text:     String(meta.paperText || '').trim(),
      vat:            parseMoney_(meta.vat),
      image_urls:     images,
    });
  }

  // Gửi theo batch
  var sent = 0, failed = 0;
  for (var b = 0; b < orders.length; b += INGEST_BATCH) {
    var batch = orders.slice(b, b + INGEST_BATCH);
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-ingest-secret': secret },
        payload: JSON.stringify({ orders: batch }),
        muteHttpExceptions: true,
      });
      var code = res.getResponseCode();
      var body = JSON.parse(res.getContentText() || '{}');
      if (code === 200 && body.ok) { sent += body.processed || batch.length; }
      else { failed += batch.length; logSync_('ERROR', 'Batch lỗi ' + code + ': ' + res.getContentText().slice(0, 200)); }
    } catch(e) {
      failed += batch.length;
      logSync_('ERROR', 'Fetch exception: ' + e.message);
    }
  }

  // Cập nhật con trỏ dòng
  props.setProperty(propKey, String(lastRow));
  props.setProperty(SYNC_PROP_LAST_TIME, new Date().toISOString());
  logSync_('OK', sheetName + ': quét ' + orders.length + ' đơn, gửi ' + sent + ', lỗi ' + failed + ' (rows ' + startRow + '–' + lastRow + ')');
}

// ─── Nhập bù toàn bộ một tab (chạy thủ công 1 lần) ──────────
function backfillAllOrders() {
  var props  = PropertiesService.getScriptProperties();
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var sheet  = getSheetByGid_(ss, ORDER_SHEET_GID);
  if (!sheet) { logSync_('ERROR', 'Không tìm thấy sheet gid=' + ORDER_SHEET_GID); return; }

  // Reset con trỏ để syncNewOrdersToSupabase quét từ dòng 2
  var propKey = SYNC_PROP_LAST_ROW + sheet.getName();
  props.setProperty(propKey, '1');
  syncNewOrdersToSupabase();
  logSync_('INFO', 'backfillAllOrders hoàn tất.');
}

// ─── Hàm phụ trợ ────────────────────────────────────────────
function getSheetByGid_(ss, gid) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  return null;
}

function buildMetaMap_(ss) {
  var map = {};
  try {
    var metaSheet = ss.getSheetByName('MIG_ORDER_META_V6') ||
                    ss.getSheetByName('ORDER_META');
    if (!metaSheet) return map;
    var last = metaSheet.getLastRow();
    if (last < 2) return map;
    // Cột: A=OrderID, B=Status, C=ShipFee, D=ShipConfirmed, E=Card, F=CardText,
    //       G=Banner, H=BannerText, I=CharmFee, J=CharmText, K=PaperFee, L=PaperText,
    //       M=VAT, N=Phone, O=ImagesJSON, P=UpdatedBy, Q=UpdatedAt
    var rows = metaSheet.getRange(2, 1, last - 1, 17).getValues();
    rows.forEach(function(r) {
      var id = String(r[0] || '').trim();
      if (!id) return;
      var imgs = [];
      try { imgs = JSON.parse(r[14] || '[]'); } catch(e) {}
      map[id] = {
        status:       String(r[1]  || '').trim(),
        shipFee:      r[2],
        shipConfirmed:r[3],
        card:         r[4],
        cardText:     r[5],
        banner:       r[6],
        bannerText:   r[7],
        charmFee:     r[8],
        charmText:    r[9],
        paperFee:     r[10],
        paperText:    r[11],
        vat:          r[12],
        phone:        String(r[13] || '').trim(),
        images:       Array.isArray(imgs) ? imgs.filter(Boolean) : [],
      };
    });
  } catch(e) { logSync_('WARN', 'buildMetaMap: ' + e.message); }
  return map;
}

function extractRichUrls_(richCell) {
  if (!richCell) return [];
  var urls = [];
  try {
    var runs = richCell.getRuns ? richCell.getRuns() : [];
    runs.forEach(function(run) {
      var link = run.getLinkUrl ? run.getLinkUrl() : null;
      if (link) urls.push(link);
    });
  } catch(e) {}
  return urls;
}

function extractPhone_(contact) {
  var m = String(contact || '').match(/(?:SĐT|SDT)\s*:\s*([^\n]+)/i);
  return m ? m[1].trim() : '';
}
function extractAddress_(contact) {
  return String(contact || '')
    .replace(/(?:SĐT|SDT)\s*:\s*[^\n]+\n?/i, '')
    .replace(/^Địa chỉ\s*:\s*/i, '')
    .trim();
}
function parseMoney_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var n = Number(String(v || '0').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}
function parseBool_(v) {
  return v === true || v === 1 || ['true','yes','1','x'].indexOf(String(v || '').trim().toLowerCase()) >= 0;
}
function deriveStatus_(r) {
  if (parseBool_(r[7])) return 'Đã giao';
  if (parseBool_(r[6])) return 'Đã bó';
  return 'Chờ bó';
}
function parseDateCell_(v, sheetName) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    // Google Sheets serial date
    var d = new Date((v - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
  return null;
}

function logSync_(level, msg) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var log = ss.getSheetByName(SYNC_LOG_SHEET);
    if (!log) {
      log = ss.insertSheet(SYNC_LOG_SHEET);
      log.getRange(1,1,1,3).setValues([['Thời gian','Level','Nội dung']]);
    }
    log.appendRow([new Date(), level, msg]);
  } catch(e) {}
  Logger.log('[' + level + '] ' + msg);
}
