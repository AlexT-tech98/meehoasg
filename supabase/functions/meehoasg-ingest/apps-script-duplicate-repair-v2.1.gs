/**
 * MEEHOASG — DUPLICATE ORDER ID REPAIR v2.1 SAFE
 * Date: 2026-10-01
 *
 * Scope verified from _AUDIT_DUP_ORDER_ID / _AUDIT_DUP_META_ID:
 * - 154 duplicate order IDs total
 * - 68 IDs = 2 real orders sharing one ID -> preserve the row currently represented in Supabase; re-ID the shadowed row
 * - 85 IDs = 1 real order + 1 empty/artifact row -> clear only the artifact Order ID
 * - 1 ID = exact duplicate row -> archive then clear the duplicate row A:O
 * - 1 duplicate meta ID -> keep newest meta row, archive then clear stale meta row
 *
 * IMPORTANT:
 * - Run previewDuplicateRepairV2() first.
 * - Run applyDuplicateRepairV2() only after preview returns READY.
 * - This file DOES NOT enable production cutover.
 * - v2.1 fixes audit sheet-name cells that Google Sheets auto-formatted as dates.
 * - v2.1 pauses the legacy order trigger during repair and restores it afterward.
 * - v2.1 also re-syncs the corrected September meta row after repair.
 */

var DUP_REPAIR_V2 = {
  MAIN_SHEET_ID: '1TsVOtDWrqlkjEUPGWmRudGEvGe38qLG0S62MOVDefpM',
  DB_SHEET_ID: '1t0ikb14Nb3ayz1KdY75Xmef2trIoSY0mlV0KrpxXueA',
  AUDIT_ORDER_SHEET: '_AUDIT_DUP_ORDER_ID',
  AUDIT_META_SHEET: '_AUDIT_DUP_META_ID',
  PLAN_SHEET: '_PLAN_DUP_REPAIR_V2',
  EXPECTED_GROUPS: 154,
  EXPECTED_TWO_REAL: 68,
  EXPECTED_ONE_REAL: 85,
  EXPECTED_EXACT_DUP: 1,
  EXPECTED_DUP_META: 1,
  EXACT_DUP_ID: 'MEE-260929144014-C7D54F94',
  EXACT_DUP_KEEP_ROW: 546,
  EXACT_DUP_CLEAR_ROW: 547,
  META_DUP_ID: 'MEE-260901133926-524871BB',
  META_KEEP_ROW: 152,
  META_CLEAR_ROW: 151,
  // Supabase live mapping audit: these 2 IDs map to occurrence #1; all other 2-real collisions map to occurrence #2.
  KEEP_OCCURRENCE_1: {
    'MEE-260824221604-DBFDF436': true,
    'MEE-260824221604-E6506C9C': true
  }
};

function previewDuplicateRepairV2() {
  var plan = _buildDuplicateRepairPlanV2_(true);
  _writeDuplicateRepairPlanV2_(plan);
  Logger.log('[READY] DUP REPAIR v2 preview: groups=' + plan.stats.groups +
    ', twoReal=' + plan.stats.twoReal +
    ', oneRealArtifact=' + plan.stats.oneReal +
    ', exactDuplicate=' + plan.stats.exactDup +
    ', duplicateMeta=' + plan.stats.dupMeta +
    ', reId=' + plan.stats.reId +
    ', clearArtifactId=' + plan.stats.clearArtifactId + '.');
  Logger.log('[OK] Chưa sửa dữ liệu production. Plan đã ghi vào ' + DUP_REPAIR_V2.PLAN_SHEET + '.');
}

function applyDuplicateRepairV2() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var triggerState = null;
  try {
    triggerState = _pauseLegacyOrderTriggerV2_();
    var plan = _buildDuplicateRepairPlanV2_(false);
    _writeDuplicateRepairPlanV2_(plan);

    var mainSs = SpreadsheetApp.openById(DUP_REPAIR_V2.MAIN_SHEET_ID);
    var dbSs = SpreadsheetApp.openById(DUP_REPAIR_V2.DB_SHEET_ID);
    var backupName = _createDuplicateRepairBackupV2_(dbSs, mainSs, plan);

    // 1) Clear IDs from empty/artifact rows only.
    plan.actions.forEach(function(a) {
      if (a.action !== 'CLEAR_ARTIFACT_ID') return;
      var sh = mainSs.getSheetByName(a.sheet);
      var currentId = String(sh.getRange(a.row, 15).getValue() || '').trim();
      if (currentId !== a.oldId) throw new Error('ABORT artifact row changed: ' + a.sheet + ' row ' + a.row + ' expected ' + a.oldId + ', got ' + currentId);
      var row = sh.getRange(a.row, 1, 1, 14).getValues()[0];
      if (_looksLikeRealOrderCurrentV2_(row)) throw new Error('ABORT artifact row now contains real order data: ' + a.sheet + ' row ' + a.row);
      sh.getRange(a.row, 15).clearContent();
    });

    // 2) Re-ID shadowed real orders. Business data is untouched.
    plan.actions.forEach(function(a) {
      if (a.action !== 'REID_SHADOW_ORDER') return;
      var sh = mainSs.getSheetByName(a.sheet);
      var currentId = String(sh.getRange(a.row, 15).getValue() || '').trim();
      if (currentId !== a.oldId) throw new Error('ABORT re-ID row changed: ' + a.sheet + ' row ' + a.row + ' expected ' + a.oldId + ', got ' + currentId);

      // Two historical rows had text dates that old sync could not parse.
      if (a.sheet === 'Tháng 05/2026' && a.row === 572) {
        sh.getRange(a.row, 2).setValue(new Date(2026, 4, 23)).setNumberFormat('dd/MM/yyyy');
      }
      if (a.sheet === 'Tháng 05/2026' && a.row === 573) {
        sh.getRange(a.row, 2).setValue(new Date(2026, 4, 27)).setNumberFormat('dd/MM/yyyy');
      }

      sh.getRange(a.row, 15).setValue(a.newId);
    });

    // 3) Exact duplicate: keep row 546, archive then clear row 547 A:O to avoid a LEGACY-* duplicate on next sync.
    var exact = plan.actions.filter(function(a){ return a.action === 'CLEAR_EXACT_DUP_ROW'; })[0];
    if (!exact) throw new Error('ABORT exact duplicate action missing.');
    var exactSh = mainSs.getSheetByName(exact.sheet);
    var keepVals = exactSh.getRange(DUP_REPAIR_V2.EXACT_DUP_KEEP_ROW, 1, 1, 15).getValues()[0];
    var clearVals = exactSh.getRange(DUP_REPAIR_V2.EXACT_DUP_CLEAR_ROW, 1, 1, 15).getValues()[0];
    if (!_rowsEqualV2_(keepVals, clearVals)) throw new Error('ABORT exact duplicate rows 546/547 are no longer identical.');
    exactSh.getRange(DUP_REPAIR_V2.EXACT_DUP_CLEAR_ROW, 1, 1, 15).clearContent();

    // 4) Duplicate meta: keep newest row 152, clear stale row 151 A:Q.
    var metaSh = dbSs.getSheetByName('MIG_ORDER_META_V6');
    if (!metaSh) throw new Error('Không tìm thấy MIG_ORDER_META_V6.');
    var oldMetaId = String(metaSh.getRange(DUP_REPAIR_V2.META_CLEAR_ROW, 1).getValue() || '').trim();
    var keepMetaId = String(metaSh.getRange(DUP_REPAIR_V2.META_KEEP_ROW, 1).getValue() || '').trim();
    if (oldMetaId !== DUP_REPAIR_V2.META_DUP_ID || keepMetaId !== DUP_REPAIR_V2.META_DUP_ID) {
      throw new Error('ABORT meta rows 151/152 changed; expected duplicate ' + DUP_REPAIR_V2.META_DUP_ID + '.');
    }
    metaSh.getRange(DUP_REPAIR_V2.META_CLEAR_ROW, 1, 1, 17).clearContent();

    SpreadsheetApp.flush();

    // 5) Hard verification before syncing.
    var orderDupAfter = _scanDuplicateOrderIdsV2_(mainSs);
    if (orderDupAfter.length) throw new Error('ABORT after repair: vẫn còn duplicate Order ID: ' + orderDupAfter.slice(0, 10).join(', '));
    var metaDupAfter = _scanDuplicateMetaIdsV2_(metaSh);
    if (metaDupAfter.length) throw new Error('ABORT after repair: vẫn còn duplicate Meta ID: ' + metaDupAfter.slice(0, 10).join(', '));

    // 6) Targeted resyncs.
    // May creates the 68 recovered shadow orders in Supabase.
    _targetedMayResyncV2_(mainSs);
    // September refreshes the corrected duplicate-meta order and current month rows.
    _targetedSeptemberMetaResyncV2_(mainSs);

    // 7) Regenerate audit reports if audit function is still present.
    if (typeof auditDuplicateOrderIdsV1 === 'function') {
      auditDuplicateOrderIdsV1();
    }

    Logger.log('[OK] DUP REPAIR v2 hoàn tất. Backup=' + backupName +
      ', reId=' + plan.stats.reId +
      ', clearedArtifactIds=' + plan.stats.clearArtifactId +
      ', exactDuplicateCleared=1, staleMetaCleared=1.');
    Logger.log('[OK] Duplicate Order ID sau repair = 0; Duplicate Meta ID sau repair = 0. Production cutover CHƯA được bật.');
  } finally {
    try { _restoreLegacyOrderTriggerV2_(triggerState); } catch (restoreErr) { Logger.log('[WARN] Không restore được syncDelta trigger: ' + restoreErr.message); }
    lock.releaseLock();
  }
}

function _buildDuplicateRepairPlanV2_(previewMode) {
  var dbSs = SpreadsheetApp.openById(DUP_REPAIR_V2.DB_SHEET_ID);
  var mainSs = SpreadsheetApp.openById(DUP_REPAIR_V2.MAIN_SHEET_ID);
  var audit = dbSs.getSheetByName(DUP_REPAIR_V2.AUDIT_ORDER_SHEET);
  var auditMeta = dbSs.getSheetByName(DUP_REPAIR_V2.AUDIT_META_SHEET);
  if (!audit || !auditMeta) throw new Error('Thiếu audit report. Chạy auditDuplicateOrderIdsV1() trước.');

  // IMPORTANT: the audit 'Sheet' column can be auto-formatted by Google Sheets as a Date.
  // getDisplayValues() preserves the visible tab label, e.g. 'Tháng 05/2026'.
  var vals = audit.getDataRange().getDisplayValues();
  if (vals.length < 2) throw new Error('Audit order report trống.');
  var groups = {};
  for (var i = 1; i < vals.length; i++) {
    var r = vals[i];
    var id = String(r[0] || '').trim();
    if (!id) continue;
    if (!groups[id]) groups[id] = [];
    groups[id].push({
      id: id,
      groupType: String(r[1] || '').trim(),
      occurrence: Number(r[3] || 0),
      sheet: String(r[4] || '').trim(),
      row: Number(r[5] || 0),
      customer: r[6], date: r[7], time: r[8], flower: r[9], image: r[10], note: r[11],
      shipping: r[14], contact: r[15], total: r[16], payment: r[17], sale: r[18],
      fingerprint: String(r[20] || ''),
      meaningful: _auditMeaningfulCountV2_(r)
    });
  }

  var ids = Object.keys(groups).sort();
  if (ids.length !== DUP_REPAIR_V2.EXPECTED_GROUPS) {
    throw new Error('ABORT audit changed: expected ' + DUP_REPAIR_V2.EXPECTED_GROUPS + ' duplicate IDs, got ' + ids.length + '.');
  }

  var existingIds = _collectAllOrderIdsV2_(mainSs);
  var actions = [];
  var twoReal = 0, oneReal = 0, exactDup = 0, reId = 0, clearArtifactId = 0;

  ids.forEach(function(id) {
    var g = groups[id].slice().sort(function(a,b){return a.occurrence-b.occurrence;});
    if (g.length !== 2) throw new Error('ABORT unexpected occurrence count for ' + id + ': ' + g.length);

    if (g[0].groupType === 'EXACT_DUPLICATE_DATA') {
      exactDup++;
      if (id !== DUP_REPAIR_V2.EXACT_DUP_ID || g[0].sheet !== 'Tháng 09/2026') {
        throw new Error('ABORT unexpected exact duplicate: ' + id);
      }
      actions.push({action:'CLEAR_EXACT_DUP_ROW', oldId:id, newId:'', sheet:'Tháng 09/2026', row:DUP_REPAIR_V2.EXACT_DUP_CLEAR_ROW, note:'Keep row 546; clear duplicate row 547 A:O after backup'});
      return;
    }

    var real = g.filter(function(x){ return x.meaningful >= 6; });
    var artifact = g.filter(function(x){ return x.meaningful < 6; });

    if (real.length === 1 && artifact.length === 1) {
      oneReal++;
      clearArtifactId++;
      actions.push({action:'CLEAR_ARTIFACT_ID', oldId:id, newId:'', sheet:artifact[0].sheet, row:artifact[0].row, note:'Empty/artifact row; preserve real order row ' + real[0].row});
      return;
    }

    if (real.length === 2) {
      twoReal++;
      var keepOccurrence = DUP_REPAIR_V2.KEEP_OCCURRENCE_1[id] ? 1 : 2;
      var keep = g.filter(function(x){return x.occurrence === keepOccurrence;})[0];
      var shadow = g.filter(function(x){return x.occurrence !== keepOccurrence;})[0];
      if (!keep || !shadow) throw new Error('ABORT cannot resolve keep/shadow for ' + id);
      var newId = _makeUniqueRepairIdV2_(shadow, id, existingIds);
      existingIds[newId] = true;
      reId++;
      actions.push({action:'REID_SHADOW_ORDER', oldId:id, newId:newId, sheet:shadow.sheet, row:shadow.row, note:'Keep old ID at row ' + keep.row + ' (Supabase mapped occurrence ' + keepOccurrence + '); recover shadow real order'});
      return;
    }

    throw new Error('ABORT unclassified duplicate group: ' + id + ' real=' + real.length + ' artifact=' + artifact.length);
  });

  if (twoReal !== DUP_REPAIR_V2.EXPECTED_TWO_REAL || oneReal !== DUP_REPAIR_V2.EXPECTED_ONE_REAL || exactDup !== DUP_REPAIR_V2.EXPECTED_EXACT_DUP) {
    throw new Error('ABORT classification changed: twoReal=' + twoReal + ', oneReal=' + oneReal + ', exact=' + exactDup + '.');
  }

  // Validate every planned source row still contains the audited ID before any write.
  actions.forEach(function(a) {
    if (a.action === 'CLEAR_EXACT_DUP_ROW') return;
    var sh = mainSs.getSheetByName(a.sheet);
    if (!sh) throw new Error('Missing order sheet ' + a.sheet);
    var current = String(sh.getRange(a.row, 15).getValue() || '').trim();
    if (current !== a.oldId) throw new Error('ABORT row changed since audit: ' + a.sheet + ' row ' + a.row + ', expected=' + a.oldId + ', current=' + current);
  });

  // Validate exact duplicate is still exact now.
  var exSh = mainSs.getSheetByName('Tháng 09/2026');
  var exKeep = exSh.getRange(DUP_REPAIR_V2.EXACT_DUP_KEEP_ROW, 1, 1, 15).getValues()[0];
  var exClear = exSh.getRange(DUP_REPAIR_V2.EXACT_DUP_CLEAR_ROW, 1, 1, 15).getValues()[0];
  if (!_rowsEqualV2_(exKeep, exClear)) throw new Error('ABORT exact duplicate rows 546/547 changed after audit.');

  // Validate meta audit.
  var metaVals = auditMeta.getDataRange().getValues();
  var metaRows = [];
  for (var m = 1; m < metaVals.length; m++) if (String(metaVals[m][0] || '').trim()) metaRows.push(metaVals[m]);
  var metaIds = {};
  metaRows.forEach(function(r){var id=String(r[0]||'').trim(); metaIds[id]=(metaIds[id]||0)+1;});
  var dupMetaIds = Object.keys(metaIds).filter(function(id){return metaIds[id]>1;});
  if (dupMetaIds.length !== DUP_REPAIR_V2.EXPECTED_DUP_META || dupMetaIds[0] !== DUP_REPAIR_V2.META_DUP_ID) {
    throw new Error('ABORT meta audit changed. Duplicate meta IDs=' + dupMetaIds.join(','));
  }

  return {
    actions: actions,
    stats: {
      groups: ids.length,
      twoReal: twoReal,
      oneReal: oneReal,
      exactDup: exactDup,
      dupMeta: dupMetaIds.length,
      reId: reId,
      clearArtifactId: clearArtifactId
    }
  };
}

function _writeDuplicateRepairPlanV2_(plan) {
  var dbSs = SpreadsheetApp.openById(DUP_REPAIR_V2.DB_SHEET_ID);
  var sh = dbSs.getSheetByName(DUP_REPAIR_V2.PLAN_SHEET);
  if (!sh) sh = dbSs.insertSheet(DUP_REPAIR_V2.PLAN_SHEET);
  sh.clearContents();
  var out = [['Action','Old ID','New ID','Sheet','Row','Note']];
  plan.actions.forEach(function(a){out.push([a.action,a.oldId,a.newId,a.sheet,a.row,a.note]);});
  out.push(['CLEAR_STALE_META',DUP_REPAIR_V2.META_DUP_ID,'','MIG_ORDER_META_V6',DUP_REPAIR_V2.META_CLEAR_ROW,'Keep newest meta row 152']);
  sh.getRange(1,1,out.length,out[0].length).setValues(out);
  sh.setFrozenRows(1);
}

function _createDuplicateRepairBackupV2_(dbSs, mainSs, plan) {
  var stamp = Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyyMMdd_HHmmss');
  var name = 'BK_DUP_REPAIR_V2_' + stamp;
  var sh = dbSs.insertSheet(name);
  var out = [['Type','Source Sheet','Row','Old ID','New ID','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','Note']];

  plan.actions.forEach(function(a) {
    var src = mainSs.getSheetByName(a.sheet);
    var rowVals = src.getRange(a.row,1,1,15).getValues()[0];
    out.push(['ORDER',a.sheet,a.row,a.oldId,a.newId].concat(rowVals).concat([a.note]));
  });

  var meta = dbSs.getSheetByName('MIG_ORDER_META_V6');
  [DUP_REPAIR_V2.META_CLEAR_ROW, DUP_REPAIR_V2.META_KEEP_ROW].forEach(function(rn){
    var v = meta.getRange(rn,1,1,17).getValues()[0];
    out.push(['META','MIG_ORDER_META_V6',rn,String(v[0]||''),''].concat(v.slice(0,15)).concat(['META columns P/Q saved in tail: '+String(v[15]||'')+' | '+String(v[16]||'')]));
  });

  sh.getRange(1,1,out.length,out[0].length).setValues(out);
  sh.setFrozenRows(1);
  return name;
}

function _targetedMayResyncV2_(mainSs) {
  if (typeof _getIngestConfig !== 'function' || typeof _buildMetaMap !== 'function' || typeof _syncSheet !== 'function') {
    throw new Error('Thiếu các hàm sync v6 trong Mã.gs. Không thể targeted resync.');
  }
  var props = PropertiesService.getScriptProperties();
  var cfg = _getIngestConfig(props);
  if (!cfg.secret) throw new Error('Không tìm thấy SUPABASE_INGEST_SECRET.');
  var may = mainSs.getSheetByName('Tháng 05/2026');
  if (!may) throw new Error('Không tìm thấy Tháng 05/2026.');
  var meta = _buildMetaMap(props);
  var cursorKey = 'SYNC_CURSOR_' + may.getName().replace(/[\/\s]/g,'_');
  // With LOOKBACK=30, saved=331 => startRow=302, covering every recovered May row through 573.
  props.setProperty(cursorKey, '331');
  _syncSheet(may, meta, cfg.url, cfg.secret, props, false);
}

function _targetedSeptemberMetaResyncV2_(mainSs) {
  if (typeof _getIngestConfig !== 'function' || typeof _buildMetaMap !== 'function' || typeof _syncSheet !== 'function') {
    throw new Error('Thiếu các hàm sync v6 trong Mã.gs. Không thể targeted September resync.');
  }
  var props = PropertiesService.getScriptProperties();
  var cfg = _getIngestConfig(props);
  if (!cfg.secret) throw new Error('Không tìm thấy SUPABASE_INGEST_SECRET.');
  var sep = mainSs.getSheetByName('Tháng 09/2026');
  if (!sep) throw new Error('Không tìm thấy Tháng 09/2026.');
  var meta = _buildMetaMap(props);
  var cursorKey = 'SYNC_CURSOR_' + sep.getName().replace(/[\/\s]/g,'_');
  // LOOKBACK=30, saved=319 => startRow=290, including the corrected meta order row 290.
  props.setProperty(cursorKey, '319');
  _syncSheet(sep, meta, cfg.url, cfg.secret, props, false);
}

function _pauseLegacyOrderTriggerV2_() {
  var hadSyncDelta = false;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction ? t.getHandlerFunction() : '';
    if (fn === 'syncDelta') {
      hadSyncDelta = true;
      ScriptApp.deleteTrigger(t);
    }
  });
  if (hadSyncDelta) Logger.log('[INFO] Tạm dừng trigger syncDelta trong lúc repair.');
  return { hadSyncDelta: hadSyncDelta };
}

function _restoreLegacyOrderTriggerV2_(state) {
  if (!state || !state.hadSyncDelta) return;
  var exists = false;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction ? t.getHandlerFunction() : '';
    if (fn === 'syncDelta') exists = true;
  });
  if (!exists) {
    ScriptApp.newTrigger('syncDelta').timeBased().everyMinutes(1).create();
    Logger.log('[OK] Đã khôi phục trigger syncDelta mỗi 1 phút sau repair.');
  }
}

function _auditMeaningfulCountV2_(r) {
  var idx = [6,7,8,9,10,11,14,15,16,17,18];
  var n = 0;
  idx.forEach(function(i){ if (!_isBlankV2_(r[i])) n++; });
  return n;
}

function _looksLikeRealOrderCurrentV2_(rowAtoN) {
  // Artifact rows found by audit were empty except 2 rows with a stray contact number.
  var customer = rowAtoN[0], date = rowAtoN[1], flower = rowAtoN[3], total = rowAtoN[10], payment = rowAtoN[11], sale = rowAtoN[12];
  var keyCount = 0;
  [customer,date,flower,total,payment,sale].forEach(function(v){if(!_isBlankV2_(v)) keyCount++;});
  return keyCount >= 2 || (!_isBlankV2_(date) && (!_isBlankV2_(customer) || !_isBlankV2_(flower)));
}

function _collectAllOrderIdsV2_(mainSs) {
  var set = {};
  mainSs.getSheets().forEach(function(sh){
    var name = sh.getName();
    if (!(/\d{1,2}\/\d{4}/.test(name) || /^(?:Đơn\s*|Tháng\s*)\d/i.test(name))) return;
    var lr = sh.getLastRow();
    if (lr < 2) return;
    var ids = sh.getRange(2,15,lr-1,1).getValues();
    ids.forEach(function(r){var id=String(r[0]||'').trim(); if(id)set[id]=true;});
  });
  return set;
}

function _makeUniqueRepairIdV2_(shadow, oldId, existingIds) {
  var mainSs = SpreadsheetApp.openById(DUP_REPAIR_V2.MAIN_SHEET_ID);
  var sh = mainSs.getSheetByName(shadow.sheet);
  if (!sh) throw new Error('Không tìm thấy order sheet từ audit: [' + shadow.sheet + '] cho ' + oldId + ' row ' + shadow.row);
  var row = sh.getRange(shadow.row,1,1,15).getValues()[0];
  var d = _repairDateV2_(row[1], shadow.row);
  var t = _repairTimePartsV2_(row[2]);
  var prefix = Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'yyMMdd') + t.hh + t.mm + t.ss;
  var baseSeed = oldId + '|' + shadow.sheet + '|' + shadow.row + '|' + String(row[0]||'') + '|' + String(row[3]||'');
  for (var i=0;i<20;i++) {
    var hex = _sha8V2_(baseSeed + '|' + i);
    var id = 'MEE-' + prefix + '-' + hex;
    if (!existingIds[id]) return id;
  }
  throw new Error('Không tạo được unique repair ID cho ' + oldId + ' row ' + shadow.row);
}

function _repairDateV2_(v, rowNum) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) return v;
  var s = String(v || '').trim();
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
  // The two known corrupted text dates.
  if (rowNum === 572) return new Date(2026,4,23);
  if (rowNum === 573) return new Date(2026,4,27);
  throw new Error('Không parse được ngày ở row ' + rowNum + ': ' + s);
}

function _repairTimePartsV2_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return {hh:Utilities.formatDate(v,'Asia/Ho_Chi_Minh','HH'), mm:Utilities.formatDate(v,'Asia/Ho_Chi_Minh','mm'), ss:'00'};
  }
  var s = String(v || '').trim();
  var m = s.match(/(\d{1,2})[:hH](\d{2})/);
  if (m) return {hh:_pad2V2_(Number(m[1])), mm:_pad2V2_(Number(m[2])), ss:'00'};
  return {hh:'00',mm:'00',ss:'00'};
}

function _sha8V2_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  var out = '';
  for (var i=0;i<bytes.length;i++) {
    var x = bytes[i]; if (x < 0) x += 256;
    out += ('0' + x.toString(16)).slice(-2);
  }
  return out.slice(0,8).toUpperCase();
}

function _scanDuplicateOrderIdsV2_(mainSs) {
  var count = {};
  mainSs.getSheets().forEach(function(sh){
    var name=sh.getName();
    if (!(/\d{1,2}\/\d{4}/.test(name) || /^(?:Đơn\s*|Tháng\s*)\d/i.test(name))) return;
    var lr=sh.getLastRow(); if(lr<2)return;
    sh.getRange(2,15,lr-1,1).getValues().forEach(function(r){var id=String(r[0]||'').trim(); if(id)count[id]=(count[id]||0)+1;});
  });
  return Object.keys(count).filter(function(id){return count[id]>1;}).sort();
}

function _scanDuplicateMetaIdsV2_(metaSh) {
  var count = {}, lr=metaSh.getLastRow();
  if(lr<2)return [];
  metaSh.getRange(2,1,lr-1,1).getValues().forEach(function(r){var id=String(r[0]||'').trim(); if(id)count[id]=(count[id]||0)+1;});
  return Object.keys(count).filter(function(id){return count[id]>1;}).sort();
}

function _rowsEqualV2_(a,b) {
  if (a.length !== b.length) return false;
  for (var i=0;i<a.length;i++) {
    if (_normV2_(a[i]) !== _normV2_(b[i])) return false;
  }
  return true;
}

function _normV2_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) return String(v.getTime());
  if (v === null || typeof v === 'undefined') return '';
  return String(v).trim();
}

function _isBlankV2_(v) {
  return v === null || typeof v === 'undefined' || String(v).trim() === '';
}

function _pad2V2_(n) { return ('0' + n).slice(-2); }
