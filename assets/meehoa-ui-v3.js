/* MEEHOA OPS UI V3 — Canonical SVG Icons, Auto-grow Textareas, In-App Flat Navy Dialogs & Admin Trash */
(function(){
  'use strict';

  function qs(s, r){ return (r || document).querySelector(s); }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function vnd(v){ return new Intl.NumberFormat('vi-VN').format(Number(v) || 0) + ' ₫'; }
  function dateVN(s){
    var p = String(s || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(s || '—');
  }
  function dateTimeVN(iso){
    if(!iso) return '—';
    var d = new Date(iso);
    if(!Number.isFinite(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat('vi-VN', {
      day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false
    }).format(d);
  }

  var SVG_PATHS = {
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 13.5"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92z"/>',
    truck: '<rect x="1" y="3" width="15" height="13" rx="1"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    pickup: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    customerBook: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    flower: '<circle cx="12" cy="12" r="2.5"/><path d="M12 4.5a2.5 2.5 0 1 1 3.5 3.5A2.5 2.5 0 1 1 19 12a2.5 2.5 0 1 1-3.5 3.5A2.5 2.5 0 1 1 12 19.5a2.5 2.5 0 1 1-3.5-3.5A2.5 2.5 0 1 1 5 12a2.5 2.5 0 1 1 3.5-3.5A2.5 2.5 0 1 1 12 4.5z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    restore: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    table: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'
  };

  function icon(name, sizeClass){
    var body = SVG_PATHS[name] || '';
    if(!body) return '';
    return '<span class="mee3-ico' + (sizeClass ? ' ' + sizeClass : '') + '" aria-hidden="true"><svg viewBox="0 0 24 24">' + body + '</svg></span>';
  }

  function shippingIcon(shipping){
    var s = String(shipping || '');
    if(/Ghé lấy/i.test(s)) return icon('pickup', 'mee3-ico-sm');
    if(/Khách tự book/i.test(s)) return icon('customerBook', 'mee3-ico-sm');
    return icon('truck', 'mee3-ico-sm');
  }

  function autoGrow(el){
    if(!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    var next = Math.max(40, Math.min(240, el.scrollHeight || 40));
    el.style.height = next + 'px';
    el.style.overflowY = (el.scrollHeight || 0) > 240 ? 'auto' : 'hidden';
  }

  function bindAutoGrow(root){
    if(!root) return;
    Array.from(root.querySelectorAll('textarea')).forEach(function(ta){
      if(!ta.dataset.meeAutoGrow){
        ta.dataset.meeAutoGrow = '1';
        ta.addEventListener('input', function(){ autoGrow(ta); });
      }
      autoGrow(ta);
    });
  }

  function closeDialog(){
    var layer = qs('.mee3-dialog-layer');
    if(layer) layer.remove();
  }

  function mountDialog(title, bodyHtml, footHtml, opts){
    closeDialog();
    opts = opts || {};
    var layer = document.createElement('div');
    layer.className = 'mee3-dialog-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', title);
    layer.innerHTML =
      '<div class="mee3-dialog">' +
        '<div class="mee3-dialog-head"><h3>' + esc(title) + '</h3><button type="button" class="close" data-mee3-dialog-close aria-label="Đóng">×</button></div>' +
        '<div class="mee3-dialog-body">' + bodyHtml + '</div>' +
        '<div class="mee3-dialog-foot">' + footHtml + '</div>' +
      '</div>';
    layer.addEventListener('click', function(e){
      if(e.target === layer || (e.target.closest && e.target.closest('[data-mee3-dialog-close]'))) closeDialog();
    });
    document.body.appendChild(layer);
    return layer;
  }

  /* TC-14 / TC-15 / TC-16: Mandatory-reason Delete Confirmation Dialog (replaces window.confirm) */
  var DELETE_REASONS = [
    { code: 'CUSTOMER_CANCELLED', label: 'Khách hủy đơn' },
    { code: 'CREATED_BY_MISTAKE', label: 'Tạo nhầm đơn' },
    { code: 'DUPLICATE_ORDER', label: 'Đơn bị trùng' },
    { code: 'OTHER', label: 'Khác (nhập lý do cụ thể)' }
  ];

  function openDeleteDialog(order, onConfirm){
    if(!order) return;
    var hasPaid = Number(order.paid || 0) > 0;
    var body =
      '<div>Chuyển đơn <b>' + esc(order.customer || order.id) + '</b> (' + esc(order.id) + ') vào <b>Thùng rác</b>?</div>' +
      '<div style="font-size:12.5px;color:var(--v3-muted)">Đơn sẽ ẩn khỏi danh sách hoạt động nhưng được lưu giữ nguyên vẹn dữ liệu, ảnh và lịch sử để Admin khôi phục khi cần.</div>' +
      (hasPaid ? '<div class="mee3-trash-audit-badge">' + icon('alert', 'mee3-ico-sm') + ' Lưu ý: Đơn đã ghi nhận thanh toán ' + esc(vnd(order.paid)) + '. Dữ liệu thanh toán sẽ được giữ nguyên để đối chiếu.</div>' : '') +
      '<div class="mee3-reason-options" role="radiogroup" aria-label="Lý do xóa đơn">' +
        DELETE_REASONS.map(function(opt, idx){
          return '<label class="mee3-reason-option"><input type="radio" name="mee3DeleteReasonCode" value="' + esc(opt.code) + '"' + (idx === 0 ? ' checked' : '') + '><span>' + esc(opt.label) + '</span></label>';
        }).join('') +
      '</div>' +
      '<div data-mee3-other-wrap class="hidden"><label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px">Nhập lý do cụ thể *</label><textarea class="mee3-reason-textarea" data-mee3-reason-text placeholder="Nhập lý do xóa đơn (bắt buộc)…"></textarea></div>' +
      '<div class="mee3-dialog-error hidden" data-mee3-dialog-err></div>';
    var foot =
      '<button type="button" class="btn secondary" data-mee3-dialog-close>Hủy</button>' +
      '<button type="button" class="btn danger" data-mee3-confirm-delete>Xác nhận xóa đơn</button>';
    var layer = mountDialog('Xác nhận xóa đơn hàng', body, foot);
    var otherWrap = qs('[data-mee3-other-wrap]', layer);
    var textEl = qs('[data-mee3-reason-text]', layer);
    var errEl = qs('[data-mee3-dialog-err]', layer);
    var confirmBtn = qs('[data-mee3-confirm-delete]', layer);

    function selectedCode(){
      var checked = qs('input[name="mee3DeleteReasonCode"]:checked', layer);
      return checked ? checked.value : 'CUSTOMER_CANCELLED';
    }
    function syncOther(){
      var isOther = selectedCode() === 'OTHER';
      if(otherWrap) otherWrap.classList.toggle('hidden', !isOther);
      if(isOther && textEl) textEl.focus();
      if(errEl){ errEl.textContent = ''; errEl.classList.add('hidden'); }
    }
    Array.from(layer.querySelectorAll('input[name="mee3DeleteReasonCode"]')).forEach(function(r){
      r.addEventListener('change', syncOther);
    });
    syncOther();

    confirmBtn.addEventListener('click', function(){
      var code = selectedCode();
      var preset = DELETE_REASONS.find(function(x){ return x.code === code; });
      var reason = code === 'OTHER' ? String(textEl && textEl.value || '').trim() : (preset ? preset.label : '');
      if(!reason){
        errEl.textContent = 'Vui lòng nhập lý do xóa đơn hàng.';
        errEl.classList.remove('hidden');
        if(textEl) textEl.focus();
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Đang xóa…';
      Promise.resolve(onConfirm({ reasonCode: code, reason: reason })).then(function(ok){
        if(ok !== false) closeDialog();
        else { confirmBtn.disabled = false; confirmBtn.textContent = 'Xác nhận xóa đơn'; }
      }).catch(function(err){
        errEl.textContent = (err && err.message) || 'Không xóa được đơn.';
        errEl.classList.remove('hidden');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Xác nhận xóa đơn';
      });
    });
  }

  /* TC-12: In-App Conflict Compare Dialog (replaces window.alert) */
  function openCompareDialog(latestOrder){
    if(!latestOrder) return;
    var body =
      '<div style="font-size:12.5px;color:var(--v3-muted)">Bản mới nhất đang lưu trên hệ thống (form bạn đang sửa vẫn được giữ nguyên):</div>' +
      '<dl class="mee3-compare-grid">' +
        '<dt>Khách hàng</dt><dd>' + esc(latestOrder.customer || '—') + '</dd>' +
        '<dt>Thời gian</dt><dd>' + esc(dateVN(latestOrder.date) + ' · ' + (latestOrder.time || '—')) + '</dd>' +
        '<dt>Mẫu hoa</dt><dd>' + esc(latestOrder.flower || '—') + '</dd>' +
        '<dt>Địa chỉ</dt><dd>' + esc(latestOrder.address || '—') + '</dd>' +
        '<dt>Lưu ý đơn hàng</dt><dd>' + esc(latestOrder.note || '—') + '</dd>' +
        (latestOrder.orderSource ? '<dt>Nguồn đơn</dt><dd>' + esc(latestOrder.orderSource) + '</dd>' : '') +
        (latestOrder.tagNoteFree ? '<dt>Tag note free</dt><dd>' + esc(latestOrder.tagNoteFree) + '</dd>' : '') +
        '<dt>Trạng thái</dt><dd>' + esc(latestOrder.status || '—') + '</dd>' +
      '</dl>' +
      '<div style="font-size:12px;color:var(--v3-muted)">Đóng form rồi mở lại đơn để cập nhật trên phiên bản mới nhất.</div>';
    var foot = '<button type="button" class="btn primary" data-mee3-dialog-close>Đã hiểu</button>';
    mountDialog('Phiên bản mới nhất của đơn', body, foot);
  }

  /* TC-14: In-App Restore Dialog */
  function openRestoreDialog(order, onConfirm){
    if(!order) return;
    var body =
      '<div>Khôi phục đơn <b>' + esc(order.customer || order.id) + '</b> (' + esc(order.id) + ') về danh sách hoạt động?</div>' +
      '<div style="font-size:12.5px;color:var(--v3-muted)">Đơn sẽ được khôi phục nguyên bản (cùng mã đơn, không tạo bản sao), giữ toàn bộ lịch sử xóa và dữ liệu ảnh/thanh toán.</div>' +
      '<div><label style="display:block;font-size:12px;font-weight:700;margin-bottom:4px">Ghi chú khôi phục (tùy chọn)</label><textarea class="mee3-reason-textarea" style="min-height:56px" data-mee3-restore-note placeholder="Ví dụ: Khách đặt lại đơn…"></textarea></div>' +
      '<div class="mee3-dialog-error hidden" data-mee3-dialog-err></div>';
    var foot =
      '<button type="button" class="btn secondary" data-mee3-dialog-close>Hủy</button>' +
      '<button type="button" class="btn primary" data-mee3-confirm-restore>Khôi phục đơn</button>';
    var layer = mountDialog('Khôi phục đơn hàng', body, foot);
    var noteEl = qs('[data-mee3-restore-note]', layer);
    var errEl = qs('[data-mee3-dialog-err]', layer);
    var btn = qs('[data-mee3-confirm-restore]', layer);
    btn.addEventListener('click', function(){
      btn.disabled = true;
      btn.textContent = 'Đang khôi phục…';
      var reason = String(noteEl && noteEl.value || '').trim();
      Promise.resolve(onConfirm(reason)).then(function(ok){
        if(ok !== false) closeDialog();
        else { btn.disabled = false; btn.textContent = 'Khôi phục đơn'; }
      }).catch(function(err){
        errEl.textContent = (err && err.message) || 'Không khôi phục được đơn.';
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Khôi phục đơn';
      });
    });
  }

  /* Admin Trash State & Renderer (TC-14, TC-15) */
  var trashState = { active: false, loading: false, q: '', page: 1, paymentAuditOnly: false, data: null, error: '' };

  async function loadTrash(force){
    if(!window.S || !S.user || S.user.role !== 'ADMIN') return;
    trashState.loading = true;
    trashState.error = '';
    if(window.renderOrders) window.renderOrders();
    try{
      var r = await window.gas('getDeletedOrders', { q: trashState.q, page: trashState.page, pageSize: 40, paymentAuditOnly: trashState.paymentAuditOnly });
      if(!r || !r.ok) throw new Error((r && r.message) || 'Không tải được Thùng rác.');
      trashState.data = r;
    }catch(e){
      trashState.error = (e && e.message) || 'Không tải được Thùng rác.';
      if(window.toast) window.toast(trashState.error, 1);
    }finally{
      trashState.loading = false;
      if(S.page === 'orders' && window.renderOrders) window.renderOrders();
    }
  }

  function renderTrashMarkup(){
    var d = trashState.data || { items: [], total: 0 };
    var items = d.items || [];
    var auditSum = d.paymentAuditSummary || { count: 0, totalCollected: 0, totalDebt: 0 };
    var cards = items.map(function(o){
      var hist = (o.deletionHistory || []).slice(0, 4).map(function(h){
        var verb = h.eventType === 'RESTORE' ? 'Khôi phục' : 'Xóa';
        return '<div>• <b>' + verb + '</b> bởi ' + esc(h.actorName || h.actorUsername || '—') + ' (' + esc(h.actorRole || '') + ') · ' + esc(dateTimeVN(h.occurredAt)) + (h.reason ? ' — ' + esc(h.reason) : '') + '</div>';
      }).join('');
      return '<article class="mee3-trash-card" data-trash-order="' + esc(o.id) + '">' +
        '<div class="mee3-card-head">' +
          '<span class="mee3-card-time">' + icon('calendar', 'mee3-ico-sm') + ' ' + esc(dateVN(o.date)) + ' · <b>' + esc(o.time || '—') + '</b></span>' +
          '<span class="mee3-badge mee3-badge-danger">Đã xóa</span>' +
        '</div>' +
        '<div>' +
          '<div class="mee3-card-customer">' + esc(o.customer || 'Khách vãng lai') + '</div>' +
          '<div class="mee3-card-meta-line">' + esc(o.id) + ' · Sale: ' + esc(o.sale || '—') + ' · Tiền hoa: <b>' + esc(vnd(o.flowerTotal)) + '</b></div>' +
          '<div class="mee3-card-flower" style="margin-top:4px">' + esc(o.flower || '') + '</div>' +
        '</div>' +
        '<div class="mee3-trash-reason-box">' +
          '<div><b>Lý do xóa:</b> ' + esc(o.deletedReason || 'Không ghi rõ') + '</div>' +
          '<div style="font-size:11.5px;margin-top:2px;opacity:.88">Xóa bởi: <b>' + esc(o.deletedBy || '—') + '</b>' + (o.deletedByRole ? ' (' + esc(o.deletedByRole) + ')' : '') + ' · ' + esc(dateTimeVN(o.deletedAt)) + '</div>' +
        '</div>' +
        (o.hasPaymentAudit ? '<div class="mee3-trash-audit-badge">' + icon('alert', 'mee3-ico-sm') + ' Đã ghi nhận thanh toán ' + esc(vnd(o.paid)) + ' (' + esc(o.payment || '—') + ') · Cần đối chiếu</div>' : '') +
        (hist ? '<div class="mee3-trash-history"><b style="color:var(--v3-text-soft)">Lịch sử xóa / khôi phục:</b>' + hist + '</div>' : '') +
        '<div class="mee3-trash-actions">' +
          '<button type="button" class="btn secondary" onclick="MEEOPS7.openDrawer(\'' + esc(o.id) + '\',\'trash\')">Xem chi tiết</button>' +
          '<button type="button" class="btn primary" data-mee3-restore-order="' + esc(o.id) + '">' + icon('restore', 'mee3-ico-sm') + ' Khôi phục đơn</button>' +
        '</div>' +
      '</article>';
    }).join('');

    var auditFilterBtn = auditSum.count > 0
      ? '<button type="button" class="mee3-trash-filter-btn' + (trashState.paymentAuditOnly ? ' is-active' : '') + '" onclick="window.MEE_UI_V3.toggleTrashPaymentAudit()">' + icon('alert', 'mee3-ico-sm') + ' Có phát sinh thu tiền (' + auditSum.count + ' · ' + esc(vnd(auditSum.totalCollected)) + ')</button>'
      : '';

    return '<div class="mee3-trash-shell">' +
      '<div class="mee3-trash-banner">' +
        '<div><b>Thùng rác đơn hàng (' + Number(d.total || 0) + ')</b><div style="font-size:12px;color:var(--v3-muted)">Chỉ Admin được xem và khôi phục. Không có xóa vĩnh viễn để đảm bảo an toàn kiểm toán.</div></div>' +
        '<div class="mee3-trash-search">' +
          auditFilterBtn +
          '<input type="search" id="mee3TrashSearch" value="' + esc(trashState.q) + '" placeholder="Tìm mã đơn, khách, người xóa, lý do…" onkeydown="if(event.key===\'Enter\')window.MEE_UI_V3.searchTrash(this.value)">' +
          '<button type="button" class="btn secondary" onclick="window.MEE_UI_V3.searchTrash((document.getElementById(\'mee3TrashSearch\')||{}).value||\'\')">Tìm</button>' +
          '<button type="button" class="btn secondary" onclick="window.MEE_UI_V3.closeTrash()">← Quay lại Đơn hàng</button>' +
        '</div>' +
      '</div>' +
      (trashState.loading ? '<div class="empty">Đang tải Thùng rác…</div>' :
        trashState.error ? '<div class="empty">' + esc(trashState.error) + '</div>' :
        (cards ? '<div class="mee3-trash-list">' + cards + '</div>' : '<div class="empty">' + (trashState.paymentAuditOnly ? 'Không có đơn đã xóa nào có phát sinh thu tiền.' : 'Thùng rác đang trống.') + '</div>')) +
    '</div>';
  }

  async function restoreOrderById(id){
    var items = (trashState.data && trashState.data.items) || [];
    var order = items.find(function(x){ return x.id === id; });
    if(!order) return;
    openRestoreDialog(order, async function(reason){
      var reqId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('res-' + Date.now());
      var r = await window.gas('restoreOrder', {
        orderId: order.id,
        expectedUpdatedAt: order.updatedAt || '',
        reason: reason,
        requestId: reqId
      });
      if(!r || !r.ok) throw new Error((r && r.message) || 'Không khôi phục được đơn.');
      if(window.toast) window.toast(r.message || 'Đã khôi phục đơn hàng.');
      if(window.S && S.dirty){
        S.dirty.add('getOrders');
        S.dirty.add('getProductionOrders');
        S.dirty.add('getDashboardSummary');
        S.dirty.add('getDebtReview');
      }
      await loadTrash(true);
      return true;
    });
  }

  function init(){
    document.body.classList.add('mee-ui-v3');
    window.MEE_ICONS = { icon: icon, shipping: shippingIcon };
    window.MEE_AUTOGROW = { grow: autoGrow, bind: bindAutoGrow };
    window.MEE_UI_V3 = {
      icon: icon,
      shippingIcon: shippingIcon,
      autoGrow: autoGrow,
      bindAutoGrow: bindAutoGrow,
      closeDialog: closeDialog,
      openDeleteDialog: openDeleteDialog,
      openCompareDialog: openCompareDialog,
      openRestoreDialog: openRestoreDialog,
      trashState: trashState,
      isTrashOpen: function(){ return !!(trashState.active && window.S && S.user && S.user.role === 'ADMIN'); },
      openTrash: function(){
        if(!window.S || !S.user || S.user.role !== 'ADMIN') return;
        trashState.active = true;
        trashState.page = 1;
        loadTrash(true);
      },
      closeTrash: function(){
        trashState.active = false;
        if(window.S && S.page === 'orders'){
          if(window.loadOrdersPage) window.loadOrdersPage(true);
          else if(window.renderOrders) window.renderOrders();
        }
      },
      searchTrash: function(q){
        trashState.q = String(q || '').trim();
        trashState.page = 1;
        loadTrash(true);
      },
      toggleTrashPaymentAudit: function(){
        trashState.paymentAuditOnly = !trashState.paymentAuditOnly;
        trashState.page = 1;
        loadTrash(true);
      },
      renderTrashMarkup: renderTrashMarkup,
      restoreOrderById: restoreOrderById
    };

    if(!document.documentElement.dataset.mee3TrashBind){
      document.documentElement.dataset.mee3TrashBind = '1';
      document.addEventListener('click', function(e){
        var btn = e.target && e.target.closest ? e.target.closest('[data-mee3-restore-order]') : null;
        if(!btn) return;
        e.preventDefault();
        restoreOrderById(btn.getAttribute('data-mee3-restore-order'));
      });
    }
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
