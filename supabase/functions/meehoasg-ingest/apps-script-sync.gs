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

// ─── TRIGGER CHÍNH: mỗi 1 - 5 phút ────────────────────────
function syncDelta() {
  syncSupabaseToSheet(); // 1. Tự động kéo đơn mới/sửa từ Web Supabase ghi vào Google Sheet
  _doSync(false);        // 2. Đồng bộ các cập nhật từ Sheet lên Supabase (nếu có ai sửa trên Sheet)
}

// ─── ĐỒNG BỘ NGƯỢC: SUPABASE → GOOGLE SHEET ───────────────

// ─── HELPER LẤY CẤU HÌNH THÔNG MINH (Tự khớp mọi biến thể tên, lọc bỏ rác) ───
function _getIngestConfig(props) {
  props = props || PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var url = "";
  var secret = "";

  // Thu thập danh sách các thuộc tính do người dùng cấu hình (bỏ qua cache CREATE_REQ_)
  var userConfigKeys = {};
  for (var k in all) {
    if (k.indexOf("CREATE_REQ_") === -1 && k.indexOf("MEE_CREATE_") === -1) {
      userConfigKeys[k] = all[k];
    }
  }

  // 1. Quét tìm URL và Secret thông minh
  for (var k in userConfigKeys) {
    var cleanK = String(k || "").trim().toUpperCase();
    var val = String(userConfigKeys[k] || "").trim();

    // Nhận diện URL: có chữ URL hoặc giá trị là link https://
    if (cleanK.indexOf("URL") >= 0 || val.indexOf("http") === 0) {
      if (!url) url = val;
    }

    // Nhận diện Secret: có chữ SECRET, INGEST, TOKEN hoặc KEY (trừ GEMINI)
    if (cleanK.indexOf("SECRET") >= 0 || cleanK.indexOf("INGEST") >= 0 || cleanK.indexOf("TOKEN") >= 0) {
      if (cleanK.indexOf("URL") === -1 && !secret && val) {
        secret = val;
      }
    }
  }

  // 2. Nếu vẫn chưa tìm thấy Secret, thử tìm bất kỳ key nào có chữ SECRET / KEY (trừ GEMINI)
  if (!secret) {
    for (var k in userConfigKeys) {
      var cleanK = String(k || "").trim().toUpperCase();
      var val = String(userConfigKeys[k] || "").trim();
      if ((cleanK.indexOf("SECRET") >= 0 || cleanK.indexOf("KEY") >= 0) && cleanK !== "GEMINI_API_KEY" && val) {
        secret = val;
        break;
      }
    }
  }

  // Fallback URL mặc định vì endpoint Supabase cố định theo project zxnfhshnavbmvdthrmrd
  if (!url || url.indexOf("http") !== 0) {
    url = "https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-ingest";
  }

  return {
    url: url,
    secret: secret,
    userConfig: userConfigKeys
  };
}


function syncSupabaseToSheet() {
  var props = PropertiesService.getScriptProperties();
  var cfg = _getIngestConfig(props);
  var url = cfg.url;
  var secret = cfg.secret;

  if (!secret) {
    _log("WARN", "syncSupabaseToSheet: Không tìm thấy giá trị SUPABASE_INGEST_SECRET! Các thuộc tính tìm thấy trong Project Settings: " + JSON.stringify(cfg.availableKeys));
    return;
  }

  var lastSync = props.getProperty("LAST_SUPABASE_TO_SHEET_AT");
  var sinceParam = "";
  if (lastSync) {
    // Lùi 30 phút để không bao giờ bỏ sót đơn do lệch múi giờ máy chủ
    var d = new Date(new Date(lastSync).getTime() - 30 * 60 * 1000);
    sinceParam = d.toISOString();
  } else {
    var yesterday = new Date(Date.now() - 48 * 3600 * 1000);
    sinceParam = yesterday.toISOString();
  }

  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { "x-ingest-secret": secret },
      payload: JSON.stringify({ action: "getOrdersForSheet", since: sinceParam, limit: 150 }),
      muteHttpExceptions: true,
    });
  } catch(e) {
    _log("ERROR", "syncSupabaseToSheet kết nối thất bại: " + e.message);
    return;
  }

  if (resp.getResponseCode() !== 200) {
    _log("WARN", "syncSupabaseToSheet: Supabase trả mã " + resp.getResponseCode() + " - " + resp.getContentText());
    return;
  }

  var data = {};
  try { data = JSON.parse(resp.getContentText() || "{}"); } catch(e) {}
  var orders = data.orders || [];
  if (!orders.length) return;

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var metaSheet = ss.getSheetByName(CFG.META_SHEET_NAME) || ss.getSheetByName("ORDER_META");
  var updates = [];
  var insertedCount = 0;
  var updatedCount = 0;

  // Helper tìm tab Sheet phù hợp nhất bất kể tên tab là "Tháng 09/2026", "09/2026" hay "Đơn 09/2026"
  function _findOrderSheet(targetMonth, preferredName) {
    if (preferredName) {
      var s = ss.getSheetByName(preferredName);
      if (s) return s;
    }
    var candidates = [
      "Tháng " + targetMonth,
      targetMonth,
      "Đơn " + targetMonth,
      "Tháng " + targetMonth.replace(/^0/, ""),
      targetMonth.replace(/^0/, "")
    ];
    for (var i = 0; i < candidates.length; i++) {
      var s = ss.getSheetByName(candidates[i]);
      if (s) return s;
    }
    var all = ss.getSheets();
    for (var i = 0; i < all.length; i++) {
      var name = all[i].getName();
      if (name.indexOf(targetMonth) >= 0) return all[i];
    }
    return null;
  }

  // Nhóm đơn theo tháng (order_date: yyyy-MM-dd -> MM/yyyy)
  var byMonth = {};
  orders.forEach(function(o) {
    var m = (o.order_date || "").match(/^(\d{4})-(\d{2})/);
    var monthKey = m ? (m[2] + "/" + m[1]) : Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "MM/yyyy");
    if (!byMonth[monthKey]) byMonth[monthKey] = [];
    byMonth[monthKey].push(o);
  });

  Object.keys(byMonth).forEach(function(monthKey) {
    var monthOrders = byMonth[monthKey];
    var sampleOrder = monthOrders[0] || {};
    var sheet = _findOrderSheet(monthKey, sampleOrder.source_sheet);
    if (!sheet) {
      _log("WARN", "Không tìm thấy tab sheet cho tháng: " + monthKey);
      return;
    }

    var lastRow = sheet.getLastRow();
    var existingIds = {};
    if (lastRow >= 2) {
      var idValues = sheet.getRange(2, 15, lastRow - 1, 1).getValues();
      for (var r = 0; r < idValues.length; r++) {
        var existingId = String(idValues[r][0] || "").trim();
        if (existingId) existingIds[existingId] = r + 2;
      }
    }

    monthOrders.forEach(function(o) {
      var id = o.id;
      var targetRow = existingIds[id];
      // Nếu không tìm thấy bằng Order ID ở cột 15, sử dụng source_row làm fallback
      if (!targetRow && o.source_row && Number(o.source_row) >= 2 && Number(o.source_row) <= lastRow) {
        targetRow = Number(o.source_row);
      }

      var dParts = (o.order_date || "").split("-");
      var dateVal = dParts.length === 3 ? (dParts[2] + "/" + dParts[1] + "/" + dParts[0]) : o.order_date;
      var timeVal = o.order_time || "";
      var contactVal = _formatContactCell(o.phone, o.address);

      // Quan trọng: Checkbox trong Google Sheet dùng boolean true/false để tự động tick hoặc bỏ tick
      var isBo = (o.status === "Đã bó" || o.status === "Đã giao");
      var isGiao = (o.status === "Đã giao");
      var isSettled = Boolean(o.settled);
      var saleVal = _saleDisplayName(o.sale);

      if (targetRow) {
        sheet.getRange(targetRow, 7).setValue(isBo);       // Cột G: Đã bó (boolean true/false)
        sheet.getRange(targetRow, 8).setValue(isGiao);     // Cột H: Đã giao (boolean true/false)
        sheet.getRange(targetRow, 14).setValue(isSettled); // Cột N: Đã tất toán (boolean true/false)
        if (o.flower_total) sheet.getRange(targetRow, 11).setValue(o.flower_total);
        if (o.payment) sheet.getRange(targetRow, 12).setValue(o.payment);
        if (contactVal) sheet.getRange(targetRow, 10).setValue(contactVal);
        updatedCount++;
        _log("INFO", "Đã cập nhật dòng " + targetRow + " (" + (o.customer || id) + "): Trạng thái = " + o.status + " (Đã bó: " + isBo + ", Đã giao: " + isGiao + ")");
      } else {
        var newRow = [
          o.customer || "",
          dateVal,
          timeVal,
          o.flower || "",
          (o.image_urls && o.image_urls[0]) ? o.image_urls[0] : "",
          o.note || "",
          isBo,
          isGiao,
          o.shipping || "Shop book ship",
          contactVal,
          o.flower_total || 0,
          o.payment || "",
          saleVal,
          isSettled,
          id
        ];
        sheet.appendRow(newRow);
        var appendedRow = sheet.getLastRow();
        existingIds[id] = appendedRow;
        updates.push({ id: id, source_sheet: sheet.getName(), source_row: appendedRow });
        insertedCount++;

        if (metaSheet) {
          try {
            metaSheet.appendRow([
              id,
              Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "yyyy-MM-dd HH:mm:ss"),
              o.ship_fee || 0,
              o.ship_confirmed ? "x" : "",
              o.card ? "x" : "",
              o.card_text || "",
              o.banner ? "x" : "",
              o.banner_text || "",
              o.charm_fee || 0,
              o.charm_text || "",
              o.paper_fee || 0,
              o.paper_text || "",
              o.vat || 0,
              o.phone || "",
              JSON.stringify(o.image_urls || [])
            ]);
          } catch(err) {}
        }
      }
    });
  });

  if (updates.length > 0) {
    try {
      UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { "x-ingest-secret": secret },
        payload: JSON.stringify({ action: "recordSheetPositions", updates: updates }),
        muteHttpExceptions: true,
      });
    } catch(e) {}
  }

  props.setProperty("LAST_SUPABASE_TO_SHEET_AT", new Date().toISOString());
  if (insertedCount > 0 || updatedCount > 0) {
    _log("INFO", "syncSupabaseToSheet: Hoàn tất chèn " + insertedCount + " đơn mới, cập nhật " + updatedCount + " đơn vào Google Sheet.");
  }
}

// ─── HÀM TEST ĐỒNG BỘ THỦ CÔNG ĐƠN KHÁNH LINH HOẶC ĐƠN GẦN NHẤT ───

// ─── HÀM CÀI ĐẶT NHANH CẤU HÌNH VÀO SCRIPT PROPERTIES (Chạy 1 lần) ───
// Anh chỉ cần điền chuỗi INGEST_SECRET anh đã đặt trên Supabase vào biến secret dưới đây rồi bấm Chạy (Run).
function caiDatKetNoi(secret) {
  secret = secret || "YOUR_SECRET_HERE";
  var props = PropertiesService.getScriptProperties();
  props.setProperty("SUPABASE_INGEST_URL", "https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-ingest");
  if (secret && secret !== "YOUR_SECRET_HERE") {
    props.setProperty("SUPABASE_INGEST_SECRET", secret.trim());
    _log("INFO", "Đã cấu hình thành công SUPABASE_INGEST_URL và SUPABASE_INGEST_SECRET!");
  } else {
    _log("WARN", "Chưa điền chuỗi secret! Vui lòng thay YOUR_SECRET_HERE bằng chuỗi secret của anh.");
  }
}

function testSyncKhanhLinhNow() {
  _log("INFO", "=== Bắt đầu test đồng bộ đơn từ Supabase về Google Sheet ===");
  var props = PropertiesService.getScriptProperties();
  var cfg = _getIngestConfig(props);

  var summary = [];
  for (var k in cfg.userConfig) {
    var v = String(cfg.userConfig[k] || "");
    var masked = v.length > 8 ? (v.slice(0, 4) + "..." + v.slice(-4) + " (" + v.length + " ký tự)") : (v ? (v.length + " ký tự") : "RỖNG");
    summary.push(k + ": " + masked);
  }
  _log("INFO", "Thuộc tính cấu hình tìm thấy trong Cài đặt: " + JSON.stringify(summary));

  if (!cfg.secret) {
    _log("WARN", "CHƯA TÌM THẤY SECRET! Vui lòng xem danh sách thuộc tính ở trên để kiểm tra tên hoặc giá trị của Secret.");
    return;
  }

  _log("INFO", "Đã nhận Secret thành công! URL: " + cfg.url);
  props.deleteProperty("LAST_SUPABASE_TO_SHEET_AT"); // Xóa cursor để quét lại toàn bộ đơn gần nhất
  syncSupabaseToSheet();
}

function _formatContactCell(phone, addr) {
  var p = String(phone || '').trim();
  var a = String(addr || '').trim();
  if (p && a) return 'SĐT: ' + p + '\nĐịa chỉ: ' + a;
  if (p) return 'SĐT: ' + p;
  return a;
}

var SALE_DISPLAY_NAMES = {
  'huynhxuyen': 'Huỳnh Xuyến',
  'huynhthu': 'Huỳnh Thư',
  'huynhlan': 'Huỳnh Lan',
  'hien': 'Hiền Lê',
  'tien': 'Minh Tiến',
  'cmui': 'C Mụi',
  'pu': 'Pu'
};
function _saleDisplayName(s) {
  if (!s) return 'C Mụi';
  var key = String(s).toLowerCase().trim();
  return SALE_DISPLAY_NAMES[key] || s;
}


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
  var cfg    = _getIngestConfig(props);
  var url    = cfg.url;
  var secret = cfg.secret;
  if (!secret) {
    _log("ERROR", "Chưa tìm thấy SUPABASE_INGEST_SECRET trong Script Properties: " + JSON.stringify(cfg.availableKeys));
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
