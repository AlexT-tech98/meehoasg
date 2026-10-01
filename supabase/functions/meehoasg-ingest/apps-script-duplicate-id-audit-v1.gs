/**
 * MEEHOASG — DUPLICATE ORDER ID FORENSIC AUDIT
 * Version: 2026-10-01 v1
 *
 * READ-ONLY toward production data.
 * This function DOES NOT edit/delete/re-ID any order or metadata row.
 * It only creates/refreshes two audit tabs inside MEE_OPS_DATABASE:
 *   _AUDIT_DUP_ORDER_ID
 *   _AUDIT_DUP_META_ID
 *
 * Run only:
 *   auditDuplicateOrderIdsV1()
 */

var DUPAUDIT_ORDER_SS_ID = '1TsVOtDWrqlkjEUPGWmRudGEvGe38qLG0S62MOVDefpM';
var DUPAUDIT_DB_PROP = 'DATABASE_SPREADSHEET_ID';
var DUPAUDIT_ORDER_REPORT = '_AUDIT_DUP_ORDER_ID';
var DUPAUDIT_META_REPORT = '_AUDIT_DUP_META_ID';

function auditDuplicateOrderIdsV1() {
  var props = PropertiesService.getScriptProperties();
  var dbId = String(props.getProperty(DUPAUDIT_DB_PROP) || '').trim();
  if (!dbId) throw new Error('Thiếu DATABASE_SPREADSHEET_ID. Không thể tạo audit report.');

  var orderSs = SpreadsheetApp.openById(DUPAUDIT_ORDER_SS_ID);
  var dbSs = SpreadsheetApp.openById(dbId);
  var orderSheets = _dupAuditOrderSheets(orderSs, props);

  if (!orderSheets.length) throw new Error('Không tìm thấy tab đơn hàng tháng.');

  var orderOccurrences = {};
  var totalOrderRows = 0;

  orderSheets.forEach(function(sh) {
    var last = sh.getLastRow();
    if (last < 2) return;

    var rows = sh.getRange(2, 1, last - 1, 15).getValues();
    rows.forEach(function(row, idx) {
      var id = String(row[14] || '').trim();
      if (!id) return;
      totalOrderRows++;
      if (!orderOccurrences[id]) orderOccurrences[id] = [];
      orderOccurrences[id].push({
        sheetName: sh.getName(),
        row: idx + 2,
        values: row,
        fingerprint: _dupAuditHash(row.slice(0, 14))
      });
    });
  });

  var duplicateOrderIds = Object.keys(orderOccurrences)
    .filter(function(id) { return orderOccurrences[id].length > 1; })
    .sort();

  var orderOutput = [[
    'Duplicate ID', 'Group Type', 'Occurrences', 'Occurrence #',
    'Sheet', 'Row', 'Customer', 'Date', 'Time', 'Flower / Order note',
    'Image', 'Note', 'Packed', 'Delivered', 'Shipping', 'Contact / Address',
    'Total', 'Payment', 'Sale', 'Settled', 'Row Fingerprint'
  ]];

  duplicateOrderIds.forEach(function(id) {
    var group = orderOccurrences[id];
    var fingerprints = {};
    group.forEach(function(x) { fingerprints[x.fingerprint] = true; });
    var groupType = Object.keys(fingerprints).length === 1
      ? 'EXACT_DUPLICATE_DATA'
      : 'DIFFERENT_ORDER_DATA';

    group.forEach(function(x, i) {
      var r = x.values;
      orderOutput.push([
        id,
        groupType,
        group.length,
        i + 1,
        x.sheetName,
        x.row,
        r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9],
        r[10], r[11], r[12], r[13], x.fingerprint
      ]);
    });
  });

  var metaSheet = dbSs.getSheetByName('MIG_ORDER_META_V6') || dbSs.getSheetByName('ORDER_META');
  if (!metaSheet) throw new Error('Không tìm thấy MIG_ORDER_META_V6 hoặc ORDER_META.');

  var metaOccurrences = {};
  var metaLast = metaSheet.getLastRow();
  if (metaLast >= 2) {
    var metaRows = metaSheet.getRange(2, 1, metaLast - 1, 17).getValues();
    metaRows.forEach(function(row, idx) {
      var id = String(row[0] || '').trim();
      if (!id) return;
      if (!metaOccurrences[id]) metaOccurrences[id] = [];
      metaOccurrences[id].push({
        row: idx + 2,
        values: row,
        fingerprint: _dupAuditHash(row.slice(1))
      });
    });
  }

  var duplicateMetaIds = Object.keys(metaOccurrences)
    .filter(function(id) { return metaOccurrences[id].length > 1; })
    .sort();

  var metaOutput = [[
    'Duplicate ID', 'Group Type', 'Occurrences', 'Occurrence #', 'Source Sheet', 'Row',
    'Status', 'Ship Fee', 'Ship Confirmed', 'Card', 'Card Text', 'Banner', 'Banner Text',
    'Charm Fee', 'Charm Text', 'Paper Fee', 'Paper Text', 'VAT', 'Phone', 'Images JSON',
    'Updated By', 'Updated At', 'Row Fingerprint'
  ]];

  duplicateMetaIds.forEach(function(id) {
    var group = metaOccurrences[id];
    var fingerprints = {};
    group.forEach(function(x) { fingerprints[x.fingerprint] = true; });
    var groupType = Object.keys(fingerprints).length === 1
      ? 'EXACT_DUPLICATE_META'
      : 'DIFFERENT_META_DATA';

    group.forEach(function(x, i) {
      var r = x.values;
      metaOutput.push([
        id, groupType, group.length, i + 1, metaSheet.getName(), x.row,
        r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11],
        r[12], r[13], r[14], r[15], r[16], x.fingerprint
      ]);
    });
  });

  var orderReport = _dupAuditGetOrCreate(dbSs, DUPAUDIT_ORDER_REPORT);
  orderReport.clearContents();
  orderReport.getRange(1, 1, orderOutput.length, orderOutput[0].length).setValues(orderOutput);
  orderReport.setFrozenRows(1);

  var metaReport = _dupAuditGetOrCreate(dbSs, DUPAUDIT_META_REPORT);
  metaReport.clearContents();
  metaReport.getRange(1, 1, metaOutput.length, metaOutput[0].length).setValues(metaOutput);
  metaReport.setFrozenRows(1);

  _dupAuditFormatReport(orderReport, orderOutput[0].length);
  _dupAuditFormatReport(metaReport, metaOutput[0].length);

  var differentOrderIds = duplicateOrderIds.filter(function(id) {
    var hashes = {};
    orderOccurrences[id].forEach(function(x) { hashes[x.fingerprint] = true; });
    return Object.keys(hashes).length > 1;
  }).length;

  var exactOrderIds = duplicateOrderIds.length - differentOrderIds;

  Logger.log('[INFO] DUP AUDIT v1: orderSheets=' + orderSheets.length +
    ', rowsWithId=' + totalOrderRows +
    ', duplicateOrderIds=' + duplicateOrderIds.length +
    ', differentOrderDataIds=' + differentOrderIds +
    ', exactDuplicateDataIds=' + exactOrderIds +
    ', duplicateMetaIds=' + duplicateMetaIds.length + '.');

  Logger.log('[OK] Chỉ tạo audit report trong MEE_OPS_DATABASE: ' +
    DUPAUDIT_ORDER_REPORT + ' và ' + DUPAUDIT_META_REPORT +
    '. KHÔNG sửa/xoá/re-ID dữ liệu production.');

  return {
    ok: true,
    orderSheets: orderSheets.length,
    rowsWithId: totalOrderRows,
    duplicateOrderIds: duplicateOrderIds.length,
    differentOrderDataIds: differentOrderIds,
    exactDuplicateDataIds: exactOrderIds,
    duplicateMetaIds: duplicateMetaIds.length,
    orderReport: DUPAUDIT_ORDER_REPORT,
    metaReport: DUPAUDIT_META_REPORT
  };
}

function _dupAuditOrderSheets(ss, props) {
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

function _dupAuditHash(values) {
  var normalized = values.map(function(v) {
    if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
    return v === null || typeof v === 'undefined' ? '' : String(v).trim();
  });

  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(normalized),
    Utilities.Charset.UTF_8
  );

  return digest.map(function(b) {
    var v = b < 0 ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function _dupAuditGetOrCreate(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function _dupAuditFormatReport(sh, columns) {
  if (!sh || sh.getLastRow() < 1) return;
  sh.getRange(1, 1, 1, columns)
    .setFontWeight('bold')
    .setBackground('#E8EEF8');
  sh.autoResizeColumns(1, Math.min(columns, 10));
  sh.getDataRange().setVerticalAlignment('top');
}
