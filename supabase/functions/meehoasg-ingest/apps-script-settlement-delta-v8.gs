/**
 * MEEHOASG — SETTLEMENT DELTA SYNC
 * Version: 2026-09-30 v8
 *
 * Replaces v7 settlement full-scan sender for recurring sync.
 * Keeps the v6 Order-ID-safe main sync unchanged.
 *
 * Behavior:
 * - Reads MIG_SETTLEMENT_V6.
 * - Hashes each settlement row by Request ID.
 * - Sends ONLY new/changed rows to Supabase.
 * - Detects status changes such as PENDING -> APPROVED / REJECTED.
 * - 1-minute trigger is safe because unchanged rows are not re-sent.
 *
 * Existing Script Properties used:
 *   DATABASE_SPREADSHEET_ID
 *   SUPABASE_INGEST_SECRET
 *
 * New Script Property:
 *   SETTLEMENT_DELTA_HASHES_V8
 */

var SETTLEMENT_INGEST_URL =
  'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-settlement-ingest';

var SETTLEMENT_DELTA_STATE_KEY = 'SETTLEMENT_DELTA_HASHES_V8';

function installSettlementDeltaV8() {
  var props = PropertiesService.getScriptProperties();

  if (!String(props.getProperty('DATABASE_SPREADSHEET_ID') || '').trim()) {
    throw new Error('Thiếu DATABASE_SPREADSHEET_ID. Dừng để bảo vệ production.');
  }

  if (!_getIngestConfig(props).secret) {
    throw new Error('Thiếu SUPABASE_INGEST_SECRET. Dừng để bảo vệ production.');
  }

  initializeSettlementDeltaStateV8();

  var handlers = {
    syncLegacySettlementsToSupabase: true,
    syncLegacySettlementsDeltaV8: true
  };

  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction && handlers[t.getHandlerFunction()]) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('syncLegacySettlementsDeltaV8')
    .timeBased()
    .everyMinutes(1)
    .create();

  _log(
    'OK',
    'Settlement v8 đã cài: delta sync mỗi 1 phút; trigger full-scan v7 đã được gỡ.'
  );
}

function initializeSettlementDeltaStateV8() {
  var props = PropertiesService.getScriptProperties();
  var rows = _readSettlementRowsV8(props);
  var state = {};

  rows.forEach(function(item) {
    state[item.id] = item.hash;
  });

  props.setProperty(
    SETTLEMENT_DELTA_STATE_KEY,
    JSON.stringify(state)
  );

  _log(
    'OK',
    'Settlement v8 seed hoàn tất: ' +
    Object.keys(state).length +
    ' request hiện tại được ghi nhận, không gửi lại Supabase.'
  );
}

function syncLegacySettlementsDeltaV8() {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    _log(
      'WARN',
      'Settlement v8: bỏ qua lượt này vì execution trước vẫn đang chạy.'
    );
    return;
  }

  try {
    var props = PropertiesService.getScriptProperties();
    var cfg = _getIngestConfig(props);

    if (!cfg.secret) {
      _log('ERROR', 'Settlement v8: thiếu SUPABASE_INGEST_SECRET.');
      return;
    }

    var rows = _readSettlementRowsV8(props);
    var oldState = _readSettlementDeltaStateV8(props);
    var nextState = {};
    var changed = [];

    rows.forEach(function(item) {
      nextState[item.id] = item.hash;

      if (oldState[item.id] !== item.hash) {
        changed.push(item.payload);
      }
    });

    if (!changed.length) {
      props.setProperty(
        SETTLEMENT_DELTA_STATE_KEY,
        JSON.stringify(nextState)
      );

      _log(
        'INFO',
        'Settlement v8 delta: 0 thay đổi / ' +
        rows.length +
        ' request; không gửi Supabase.'
      );
      return;
    }

    var sent = 0;
    var failed = 0;
    var approved = 0;
    var batchSize = 80;

    for (var i = 0; i < changed.length; i += batchSize) {
      var batch = changed.slice(i, i + batchSize);

      try {
        var resp = UrlFetchApp.fetch(SETTLEMENT_INGEST_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: {
            'x-ingest-secret': cfg.secret
          },
          payload: JSON.stringify({
            settlements: batch
          }),
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
            'Settlement v8 batch lỗi HTTP ' +
            code +
            ': ' +
            resp.getContentText().slice(0, 180)
          );
        }
      } catch (e) {
        failed += batch.length;

        _log(
          'WARN',
          'Settlement v8 batch exception: ' + e.message
        );
      }
    }

    if (failed === 0) {
      props.setProperty(
        SETTLEMENT_DELTA_STATE_KEY,
        JSON.stringify(nextState)
      );
    }

    _log(
      failed ? 'WARN' : 'OK',
      'Settlement v8 delta: changed=' +
      changed.length +
      '/' +
      rows.length +
      ', sent=' +
      sent +
      ', failed=' +
      failed +
      ', approvedOrders=' +
      approved
    );
  } finally {
    lock.releaseLock();
  }
}

function _readSettlementRowsV8(props) {
  var dbSs = _getAuxSpreadsheet(props);

  if (!dbSs) {
    throw new Error('Settlement v8: không mở được MEE_OPS_DATABASE.');
  }

  var sh = dbSs.getSheetByName('MIG_SETTLEMENT_V6');

  if (!sh) {
    throw new Error('Settlement v8: không tìm thấy MIG_SETTLEMENT_V6.');
  }

  var lastRow = sh.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  var values = sh
    .getRange(2, 1, lastRow - 1, 19)
    .getValues();

  var byId = {};

  values.forEach(function(r) {
    var id = String(r[0] || '').trim();
    var orderId = String(r[1] || '').trim();

    if (!id || !orderId) return;

    var bills = [];

    try {
      var parsed = JSON.parse(String(r[11] || '[]'));
      if (Array.isArray(parsed)) {
        bills = parsed
          .map(function(x) {
            return String(x || '').trim();
          })
          .filter(Boolean);
      }
    } catch (e) {}

    var payload = {
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
      status: String(r[13] || 'PENDING')
        .trim()
        .toUpperCase(),
      submitted_at: _legacySettlementDateV8(r[14]),
      admin_username: String(r[15] || '').trim(),
      admin_name: String(r[16] || '').trim(),
      reviewed_at: _legacySettlementDateV8(r[17]),
      rejection_reason: String(r[18] || '').trim()
    };

    byId[id] = {
      id: id,
      payload: payload,
      hash: _hashSettlementPayloadV8(payload)
    };
  });

  return Object.keys(byId)
    .sort()
    .map(function(id) {
      return byId[id];
    });
}

function _readSettlementDeltaStateV8(props) {
  var raw = String(
    props.getProperty(SETTLEMENT_DELTA_STATE_KEY) || ''
  ).trim();

  if (!raw) return {};

  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? parsed
      : {};
  } catch (e) {
    _log(
      'WARN',
      'Settlement v8: state hash hỏng; sẽ coi toàn bộ request là changed.'
    );
    return {};
  }
}

function _hashSettlementPayloadV8(payload) {
  var canonical = JSON.stringify(payload);

  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonical,
    Utilities.Charset.UTF_8
  );

  return digest
    .map(function(b) {
      var v = (b < 0 ? b + 256 : b)
        .toString(16);
      return ('0' + v).slice(-2);
    })
    .join('');
}

function _legacySettlementDateV8(v) {
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
    m[3] +
    '-' +
    ('0' + m[2]).slice(-2) +
    '-' +
    ('0' + m[1]).slice(-2) +
    'T' +
    ('0' + (m[4] || '00')).slice(-2) +
    ':' +
    (m[5] || '00') +
    ':' +
    (m[6] || '00') +
    '+07:00'
  );
}

function testSettlementDeltaV8Now() {
  syncLegacySettlementsDeltaV8();
}
