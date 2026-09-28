// Supabase Edge Function replacing google.script.run. Platform JWT verification
// stays enabled; application roles use separate opaque sessions.
const BUILD = '2026.09.28-supabase-v3';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const PASSWORD_SALT = Deno.env.get('LEGACY_PASSWORD_SALT') || 'MEE-FLOWER-V4';
const ALLOWED_ORIGIN = 'https://ops.meehoasg.com';
const ALLOWED_ORIGINS = ['https://ops.meehoasg.com', 'https://meehoasg.com'];
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function clean(value) { return String(value ?? '').trim(); }
function norm(value) { return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function usernameNorm(value) { return norm(value).replace(/đ/g, 'd').replace(/\s+/g, ''); }
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let raw = String(value ?? '0').replace(/[^\d.,-]/g, '');
  if (raw.includes(',') && raw.includes('.')) raw = raw.replaceAll('.', '').replace(',', '.');
  else if (/^-?\d{1,3}(?:[.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, '');
  else raw = raw.replace(',', '.');
  const n = Number(raw); return Number.isFinite(n) ? n : 0;
}
function cleanTime(value) {
  const raw = clean(value);
  if (!raw) return "";
  if (raw.includes("1899") || raw.includes("GMT")) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      const h = String(d.getHours()).padStart(2, "0");
      const m = String(d.getMinutes()).padStart(2, "0");
      return `${h}:${m}`;
    }
  }
  const m = raw.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  return raw.slice(0, 5);
}
function bool(value) { return value === true || value === 1 || ['true', 'yes', '1', 'x'].includes(norm(value)); }
function dateToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function publicUser(user) { return { username: user.username, name: user.display_name, role: user.role, active: user.active }; }
function fail(message, code) { return { ok: false, message, ...(code ? { code } : {}) }; }
function hex(bytes) { return [...bytes].map(n => n.toString(16).padStart(2, '0')).join(''); }
async function sha256(text) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))); }
function same(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
function token() { return hex(crypto.getRandomValues(new Uint8Array(32))); }

async function db(table, query = {}, method = 'GET', body) {
  const url = new URL(SUPABASE_URL + '/rest/v1/' + table);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: method === 'GET' ? 'count=exact' : query.on_conflict ? 'return=representation,resolution=merge-duplicates' : 'return=representation'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Database ' + res.status + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : [];
}
async function all(table, query = {}) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const part = await db(table, { ...query, limit: '1000', offset: String(offset) });
    out.push(...part);
    if (part.length < 1000) return out;
  }
}
async function one(table, query) { return (await db(table, { ...query, limit: '1' }))[0] || null; }
async function audit(user, orderId, action, before, after) {
  try { await db('activity_log', {}, 'POST', { username: user.username, display_name: user.display_name, role: user.role, order_id: orderId || null, action, before_data: before || null, after_data: after || null }); } catch (_) {}
}
async function requireUser(payload, roles) {
  const raw = clean(payload.token);
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
  const session = await one('app_sessions', { token_hash: 'eq.' + await sha256(raw), select: 'username,expires_at' });
  if (!session || Date.parse(session.expires_at) <= Date.now()) throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
  const user = await one('app_users', { username: 'eq.' + session.username });
  if (!user || !user.active) throw new Error('Tài khoản đã bị khóa.');
  if (roles && !roles.includes(user.role)) throw new Error('Không có quyền thực hiện.');
  return user;
}
async function login(payload) {
  const username = usernameNorm(payload.username), password = String(payload.password || '');
  if (!username || !password) return fail('Sai tài khoản hoặc mật khẩu.');
  const attempt = await one('login_attempts', { username: 'eq.' + username });
  if (attempt?.blocked_until && Date.parse(attempt.blocked_until) > Date.now()) return fail('Đăng nhập quá nhiều lần. Vui lòng thử lại sau.');
  const user = await one('app_users', { username: 'eq.' + username });
  const expected = await sha256(PASSWORD_SALT + '|' + password);
  const valid = user && user.active && same(user.password_hash, expected);
  if (!valid) {
    const count = (attempt?.attempts || 0) + 1;
    await db('login_attempts', { on_conflict: 'username' }, 'POST', { username, attempts: count, blocked_until: count >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null, updated_at: new Date().toISOString() });
    return fail('Sai tài khoản hoặc mật khẩu.');
  }
  if (attempt) await db('login_attempts', { username: 'eq.' + username }, 'DELETE');
  const raw = token();
  await db('app_sessions', {}, 'POST', { token_hash: await sha256(raw), username, expires_at: new Date(Date.now() + SESSION_MS).toISOString() });
  return { ok: true, token: raw, user: publicUser(user) };
}
function accessoryTotal(order) { return (order.card ? 10000 : 0) + (order.banner ? 35000 : 0) + num(order.charm_fee) + num(order.paper_fee); }
function contactFields(row) {
  const contact = clean(row.address);
  const phoneInContact = contact.match(/(?:SĐT|SDT)\s*:\s*([^\n]+)/i);
  return {
    phone: clean(row.phone) || (phoneInContact ? clean(phoneInContact[1]) : ''),
    address: contact.replace(/(?:SĐT|SDT)\s*:\s*[^\n]+\n?/i, '').replace(/^Địa chỉ\s*:\s*/i, '').trim()
  };
}
function paidAmount(payment, base, settled) {
  if (settled > 0) return settled;
  const text = norm(payment);
  if (!text || /chua/.test(text)) return 0;
  if (/full|đa tt|da tt|đa thanh toan|da thanh toan|thanh toan đu|thanh toan du/.test(text)) return base;
  const match = text.replace(/\s/g, '').match(/([0-9.,]+)(k|tr|trieu)?/);
  if (!match) return 0;
  let amount = num(match[1]);
  if (match[2] === 'tr' || match[2] === 'trieu') amount *= 1000000;
  else if (match[2] === 'k' || (amount > 0 && amount <= 1000)) amount *= 1000;
  return Math.max(0, amount);
}
function decorate(row, user, settlement) {
  const contact = contactFields(row);
  const accessory = accessoryTotal(row), ship = norm(row.shipping).includes('shop') ? num(row.ship_fee) : 0;
  const base = num(row.flower_total) + accessory + num(row.vat);
  const total = base + ship;
  const paid = paidAmount(row.payment, base, row.settled ? total : 0);
  const status = settlement?.status || 'NONE';
  const locked = !!row.settled || ['PENDING', 'APPROVED'].includes(status);
  // Owner check: so username (sau mapping) và display_name (đơn cũ chưa mapping)
  const saleNorm = norm(row.sale || '');
  const owner = saleNorm === norm(user.username) || saleNorm === norm(user.display_name);
  const canEdit = !locked && (user.role !== 'SALE' || owner);
  return {
    id: row.id, sourceSheet: row.source_sheet || '', sourceRow: row.source_row || 0,
    customer: row.customer, phone: contact.phone, date: row.order_date, time: cleanTime(row.order_time),
    flower: row.flower, imageUrls: row.image_urls || [], driveUrls: row.image_urls || [],
    note: row.note, shipping: row.shipping, address: contact.address,
    flowerTotal: num(row.flower_total), payment: row.payment, paid, sale: row.sale,
    settled: row.settled, status: row.status, shipFee: num(row.ship_fee),
    shipConfirmed: row.ship_confirmed, shipFeePending: norm(row.shipping).includes('shop') && !row.ship_confirmed,
    card: row.card, cardText: row.card_text, banner: row.banner, bannerText: row.banner_text,
    charmFee: num(row.charm_fee), charmText: row.charm_text, paperFee: num(row.paper_fee),
    paperText: row.paper_text, vat: num(row.vat), accessoryTotal: accessory,
    totalDue: total, debt: row.settled ? 0 : Math.max(0, total - paid),
    hasAccessories: accessory > 0, settlementStatus: status,
    settlementRequestId: settlement?.id || '', settlementReason: settlement?.rejection_reason || '',
    locked, canEdit, canShip: !locked, canOperate: !locked && ['ADMIN', 'THO_OPS'].includes(user.role),
    canSubmitSettlement: !locked && row.status === 'Đã giao' && (user.role === 'ADMIN' || owner),
    detailLoaded: true
  };
}
async function settlementMap(ids) {
  if (!ids.length) return {};
  const unique = [...new Set(ids)];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));
  const parts = await Promise.all(chunks.map(chunk =>
    all('settlement_requests', { order_id: 'in.(' + chunk.map(id => '"' + id.replaceAll('"', '') + '"').join(',') + ')', order: 'submitted_at.desc' })));
  const rows = parts.flat();
  const map = {};
  for (const row of rows) if (!map[row.order_id]) map[row.order_id] = row;
  return map;
}
async function orderRows(start, end) {
  return all('orders', { and: '(order_date.gte.' + start + ',order_date.lte.' + end + ')', order: 'order_date.asc,order_time.asc' });
}
async function decoratedRange(start, end, user) {
  const rows = await orderRows(start, end), settlements = await settlementMap(rows.map(r => r.id));
  return Promise.all(rows.map(async row => decorate(await visibleOrder(row), user, settlements[row.id])));
}
async function dashboard(payload, user) {
  const start = clean(payload.start) || dateToday(), end = clean(payload.end) || start;
  const orders = await decoratedRange(start, end, user);
  const summary = { orders: 0, revenue: 0, debt: 0, cms: 0, 'Chờ bó': 0, 'Đã bó': 0, 'Đã giao': 0, unsettled: 0, alerts: 0 };
  const groups = { nearUnpacked: [], packedOverdue: [] };
  const now = Date.now();
  for (const o of orders) {
    summary.orders++; summary.revenue += o.flowerTotal; summary.debt += o.debt; summary.cms += o.flowerTotal * .08;
    summary[o.status] = (summary[o.status] || 0) + 1; if (!o.settled) summary.unsettled++;
    const due = Date.parse(o.date + 'T' + (o.time || '00:00') + ':00+07:00');
    if (o.status === 'Chờ bó' && due >= now && due - now <= 3600000) groups.nearUnpacked.push(o);
    if (o.status === 'Đã bó' && due < now) groups.packedOverdue.push(o);
  }
  groups.nearUnpacked = groups.nearUnpacked.slice(0, 20);
  groups.packedOverdue = groups.packedOverdue.slice(0, 20);
  summary.nearUnpacked = groups.nearUnpacked.length; summary.packedOverdue = groups.packedOverdue.length;
  summary.alerts = summary.nearUnpacked + summary.packedOverdue;
  return { ok: true, range: { start, end }, summary, attentionGroups: groups, attention: [...groups.nearUnpacked, ...groups.packedOverdue] };
}
async function getOrders(payload, user) {
  const start = clean(payload.start) || dateToday(), end = clean(payload.end) || start;
  const q = norm(payload.q), page = Math.max(1, Math.floor(num(payload.page) || 1)), pageSize = Math.min(200, Math.max(20, Math.floor(num(payload.pageSize) || 80)));
  const allOrders = await decoratedRange(start, end, user);
  // SALE chỉ thấy đơn của mình
  const visibleOrders = user.role === 'SALE'
    ? allOrders.filter(o => norm(o.sale) === norm(user.username) || norm(o.sale) === norm(user.display_name))
    : allOrders;
  const filtered = q ? visibleOrders.filter(o => norm([o.customer, o.phone, o.id, o.flower, o.sale].join(' ')).includes(q)) : visibleOrders;
  const items = filtered.slice((page - 1) * pageSize, page * pageSize);
  return { ok: true, range: { start, end }, page, pageSize, total: filtered.length, items, hasMore: page * pageSize < filtered.length };
}
async function getProduction(payload, user) {
  const date = clean(payload.date) || dateToday();
  return { ok: true, date, orders: await decoratedRange(date, date, user) };
}
async function getDebt(payload, user) {
  const start = clean(payload.start) || dateToday(), end = clean(payload.end) || start;
  const sale = user.role === 'ADMIN' ? norm(payload.sale) : null;
  const items = (await decoratedRange(start, end, user)).filter(o => {
    if (o.status !== 'Đã giao' || o.settled) return false;
    if (user.role === 'ADMIN') return !sale || norm(o.sale) === sale;
    return norm(o.sale) === norm(user.username) || norm(o.sale) === norm(user.display_name);
  });
  return { ok: true, range: { start, end }, items, summary: { orders: items.length, debt: items.reduce((n, o) => n + o.debt, 0), shipFeePending: items.filter(o => o.shipFeePending).length }, scope: user.role === 'ADMIN' ? 'ADMIN' : 'SELF' };
}
async function initial(user, token) {
  const day = dateToday(), payload = { start: day, end: day, date: day, page: 1, pageSize: 80 };
  if (user.role === 'ADMIN') return { page: 'dashboard', data: await dashboard(payload, user), at: Date.now() };
  if (user.role === 'THO_OPS') return { page: 'production', data: await getProduction(payload, user), at: Date.now() };
  return { page: 'orders', data: await getOrders(payload, user), at: Date.now() };
}
async function loginAndBootstrap(payload) {
  const result = await login(payload);
  if (!result.ok) return result;
  const user = await one('app_users', { username: 'eq.' + result.user.username });
  return { ...result, options: { shipping: ['Shop book ship', 'Khách tự book', 'Ghé lấy'], statuses: ['Chờ bó', 'Đã bó', 'Đã giao'] }, initial: await initial(user, result.token) };
}
async function usersList() {
  const rows = await all('app_users', { select: 'username,display_name,role,active', order: 'display_name.asc' });
  return { ok: true, items: rows.map(publicUser), employeeOptions: [...new Set(rows.filter(u => u.active).map(u => u.display_name))] };
}
async function options() {
  const rows = await all('app_users', { select: 'display_name,active' });
  return { ok: true, options: { sales: [...new Set(rows.filter(u => u.active).map(u => u.display_name))], shipping: ['Shop book ship', 'Khách tự book', 'Ghé lấy'], statuses: ['Chờ bó', 'Đã bó', 'Đã giao'] } };
}
function checkOrderInput(d) {
  if (!clean(d.customer)) return 'Thiếu tên khách.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(d.date))) return 'Ngày nhận không hợp lệ.';
  if (!/^\d{1,2}:\d{2}$/.test(clean(d.time))) return 'Thiếu giờ nhận.';
  if (!clean(d.flower)) return 'Thiếu mẫu hoa.';
  if (num(d.flowerTotal) < 0) return 'Giá trị hoa không hợp lệ.';
  if (!clean(d.shipping)) return 'Thiếu hình thức vận chuyển.';
  if (bool(d.card) && !clean(d.cardText)) return 'Thiệp đã chọn nhưng chưa có nội dung.';
  if (bool(d.banner) && !clean(d.bannerText)) return 'Banner đã chọn nhưng chưa có nội dung.';
  return '';
}
function orderData(d, current, user) {
  return {
    customer: clean(d.customer), phone: clean(d.phone), order_date: clean(d.date),
    order_time: clean(d.time), flower: clean(d.flower), note: clean(d.note),
    shipping: clean(d.shipping), address: clean(d.address),
    flower_total: num(d.flowerTotal), payment: clean(d.payment),
    sale: user.role === 'SALE' ? user.username : clean(d.sale || current?.sale || user.username),
    card: bool(d.card), card_text: clean(d.cardText), banner: bool(d.banner),
    banner_text: clean(d.bannerText), charm_fee: num(d.charmFee),
    charm_text: clean(d.charmText), paper_fee: num(d.paperFee),
    paper_text: clean(d.paperText), vat: num(d.vat),
    image_urls: current?.image_urls || (Array.isArray(d.imageUrls) ? d.imageUrls : Array.isArray(d.driveUrls) ? d.driveUrls : []),
    updated_at: new Date().toISOString()
  };
}
function newId(prefix) { return prefix + '-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase(); }
async function uploadImages(files, bucket) {
  const urls = [];
  for (const file of files || []) {
    const match = String(file.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/);
    if (!match) throw new Error('File ảnh không hợp lệ.');
    const binary = atob(match[2]), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Mỗi ảnh tối đa 5 MB.');
    const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
    const path = crypto.randomUUID() + '.' + extension;
    const response = await fetch(SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + path, {
      method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': match[1], 'x-upsert': 'false' }, body: bytes
    });
    if (!response.ok) throw new Error('Không lưu được ảnh: ' + (await response.text()).slice(0, 200));
    urls.push('supabase://' + bucket + '/' + path);
  }
  return urls;
}
async function billDisplayUrls(urls) {
  const out = [];
  for (const url of urls || []) {
    const match = String(url).match(/^supabase:\/\/(order-images|settlement-bills)\/(.+)$/);
    if (!match) { out.push(url); continue; }
    const bucket = match[1], path = match[2];
    const response = await fetch(SUPABASE_URL + '/storage/v1/object/sign/' + bucket + '/' + path, {
      method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 })
    });
    if (!response.ok) continue;
    const signed = await response.json();
    out.push(SUPABASE_URL + '/storage/v1' + signed.signedURL);
  }
  return out;
}
async function visibleOrder(row) {
  const image_urls = await billDisplayUrls(row.image_urls || []);
  return { ...row, image_urls };
}
async function getOrder(payload, user) {
  const row = await one('orders', { id: 'eq.' + clean(payload.orderId) });
  if (!row) return fail('Không tìm thấy đơn.');
  const settlement = (await settlementMap([row.id]))[row.id];
  return { ok: true, order: decorate(await visibleOrder(row), user, settlement) };
}
async function createOrder(payload, user) {
  const input = payload.order || {}, bad = checkOrderInput(input);
  if (bad) return fail(bad);
  const requestId = clean(payload.requestId);
  if (!requestId) return fail('Thiếu mã chống tạo trùng.');
  const prior = await one('orders', { request_id: 'eq.' + requestId });
  if (prior) return { ok: true, idempotent: true, orderId: prior.id, order: decorate(await visibleOrder(prior), user), message: 'Đã tạo đơn.' };
  const id = newId('MEE');
  const savedImages = await uploadImages(input.imageFiles, 'order-images');
  const row = { id, request_id: requestId, ...orderData(input, null, user), status: 'Chờ bó' };
  row.image_urls = [...new Set([...(row.image_urls || []), ...savedImages])];
  const created = (await db('orders', {}, 'POST', row))[0];
  await audit(user, id, 'CREATE_ORDER', null, { flowerTotal: row.flower_total });
  return { ok: true, orderId: id, sourceSheet: '', sourceRow: 0, order: decorate(await visibleOrder(created), user), message: 'Đã tạo đơn.' };
}
async function updateOrder(payload, user) {
  const id = clean(payload.orderId), current = await one('orders', { id: 'eq.' + id });
  if (!current) return fail('Không tìm thấy đơn.');
  const settlement = (await settlementMap([id]))[id], shown = decorate(current, user, settlement);
  if (!shown.canEdit) return fail('Đơn đã khóa hoặc bạn không có quyền sửa.');
  const input = { ...shown, ...(payload.order || {}) }, bad = checkOrderInput(input);
  if (bad) return fail(bad);
  const patch = orderData(input, current, user);
  patch.image_urls = [...new Set([...(patch.image_urls || []), ...await uploadImages(payload.order?.imageFiles, 'order-images')])];
  await db('orders', { id: 'eq.' + id }, 'PATCH', patch);
  await audit(user, id, 'UPDATE_ORDER', { date: current.order_date, time: current.order_time }, { date: input.date, time: input.time });
  return { ok: true, orderId: id, sourceSheet: '', sourceRow: 0, message: 'Đã cập nhật đơn.' };
}
const statuses = ['Chờ bó', 'Đã bó', 'Đã giao'];
async function updateStatus(payload, user) {
  const id = clean(payload.orderId), status = clean(payload.status);
  const row = await one('orders', { id: 'eq.' + id });
  if (!row) return fail('Không tìm thấy đơn.');
  const settlement = (await settlementMap([id]))[id];
  if (decorate(row, user, settlement).locked) return fail('Đơn đã khóa.');
  if (Math.abs(statuses.indexOf(status) - statuses.indexOf(row.status)) !== 1 || !statuses.includes(status)) return fail('Chỉ được chuyển trạng thái từng bước.');
  await db('orders', { id: 'eq.' + id }, 'PATCH', { status, updated_at: new Date().toISOString() });
  await audit(user, id, 'STATUS', { status: row.status }, { status });
  return { ok: true, status };
}
async function updateStatusBulk(payload, user) {
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [], results = [];
  for (const item of items) {
    const result = await updateStatus({ orderId: item.orderId, status: payload.status }, user);
    results.push({ orderId: item.orderId, ok: result.ok, message: result.message, status: result.status });
  }
  return { ok: results.every(r => r.ok), results };
}
async function saveShipFee(payload, user) {
  const id = clean(payload.orderId), row = await one('orders', { id: 'eq.' + id });
  if (!row) return fail('Không tìm thấy đơn.');
  const settlement = (await settlementMap([id]))[id];
  if (decorate(row, user, settlement).locked) return fail('Đơn đã khóa.');
  if (!norm(row.shipping).includes('shop')) return fail('Chỉ nhập phí ship cho đơn Shop book ship.');
  const shipFee = num(payload.shipFee);
  if (shipFee < 0) return fail('Phí ship không hợp lệ.');
  await db('orders', { id: 'eq.' + id }, 'PATCH', { ship_fee: shipFee, ship_confirmed: true, updated_at: new Date().toISOString() });
  await audit(user, id, 'SHIP_FEE', { shipFee: row.ship_fee }, { shipFee });
  return { ok: true, orderId: id, shipFee, shipConfirmed: true, message: 'Đã cập nhật phí ship.' };
}
async function submitSettlement(payload, user) {
  const id = clean(payload.orderId), row = await one('orders', { id: 'eq.' + id });
  if (!row) return fail('Không tìm thấy đơn.');
  const previous = (await settlementMap([id]))[id], order = decorate(row, user, previous);
  if (!order.canSubmitSettlement) return fail('Đơn chưa thể gửi tất toán hoặc bạn không có quyền.');
  if (order.shipFeePending && (payload.shipFee === undefined || clean(payload.shipFee) === '')) return fail('Cần nhập phí ship thực tế.');
  const billUrls = [...(Array.isArray(payload.billUrls) ? payload.billUrls : []), ...await uploadImages(payload.billFiles, 'settlement-bills')];
  if (!billUrls.length) return fail('Cần ít nhất một ảnh bill.');
  const shipFee = norm(row.shipping).includes('shop') ? num(payload.shipFee) : 0;
  const required = num(row.flower_total) + accessoryTotal(row) + num(row.vat) + shipFee;
  const requestId = newId('SET');
  await db('settlement_requests', {}, 'POST', {
    id: requestId, order_id: id, sale_username: user.username, sale_name: user.display_name,
    flower_total: row.flower_total, accessory_total: accessoryTotal(row), vat: row.vat,
    ship_fee: shipFee, required_amount: required, bill_urls: billUrls,
    note: clean(payload.note), status: 'PENDING'
  });
  await db('orders', { id: 'eq.' + id }, 'PATCH', { ship_fee: shipFee, ship_confirmed: true, updated_at: new Date().toISOString() });
  await audit(user, id, 'SETTLEMENT', null, { requestId, required });
  return { ok: true, requestId, orderId: id, requiredAmount: required, settlementStatus: 'PENDING', message: 'Đã gửi tất toán.' };
}
async function settlementQueue(payload, user) {
  const status = clean(payload.status || 'PENDING').toUpperCase();
  if (!['PENDING', 'APPROVED', 'REJECTED', 'ALL'].includes(status)) return fail('Trạng thái đối soát không hợp lệ.');
  const query = { order: 'submitted_at.desc' };
  if (status !== 'ALL') query.status = 'eq.' + status;
  if (payload.start) query.submitted_at = 'gte.' + payload.start + 'T00:00:00+07:00';
  const rows = await all('settlement_requests', query);
  const end = payload.end ? Date.parse(payload.end + 'T23:59:59+07:00') : Infinity;
  const filtered = rows.filter(x => Date.parse(x.submitted_at) <= end);
  const groups = new Map();
  for (const row of filtered) {
    const group = groups.get(row.order_id) || [];
    group.push(row);
    groups.set(row.order_id, group);
  }
  const ids = [...groups.keys()];
  const orderParts = [];
  for (let i = 0; i < ids.length; i += 30) orderParts.push(ids.slice(i, i + 30));
  const orders = (await Promise.all(orderParts.map(chunk =>
    all('orders', { id: 'in.(' + chunk.map(x => '"' + x.replaceAll('"', '') + '"').join(',') + ')' })))).flat();
  const byId = Object.fromEntries(orders.map(x => [x.id, x]));
  const items = [];
  for (const [orderId, requests] of groups) {
    const x = requests[0];
    const allBills = [...new Set(requests.flatMap(request => Array.isArray(request.bill_urls) ? request.bill_urls : []))];
    items.push({
      requestId: x.id, orderId: x.order_id, saleUsername: x.sale_username, saleName: x.sale_name,
      flowerTotal: num(x.flower_total), accessoryTotal: num(x.accessory_total), vat: num(x.vat),
      shipFee: num(x.ship_fee), requiredAmount: num(x.required_amount), billUrls: await billDisplayUrls(allBills),
      requestIds: requests.map(request => request.id), duplicateCount: requests.length - 1,
      note: x.note, status: x.status, createdAt: x.submitted_at, adminUsername: x.admin_username,
      adminName: x.admin_name, reviewedAt: x.reviewed_at, reason: x.rejection_reason,
      order: byId[orderId] ? decorate(await visibleOrder(byId[orderId]), user, x) : null
    });
  }
  return { ok: true, status, range: payload.start || payload.end ? { start: payload.start || '', end: payload.end || '' } : null, items };
}
async function reviewSettlement(payload, user) {
  const id = clean(payload.requestId), decision = clean(payload.decision).toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(decision)) return fail('Quyết định không hợp lệ.');
  const request = await one('settlement_requests', { id: 'eq.' + id });
  if (!request) return fail('Không tìm thấy yêu cầu.');
  const pending = await all('settlement_requests', { order_id: 'eq.' + request.order_id, status: 'eq.PENDING' });
  if (!pending.length) return fail('Yêu cầu đã được xử lý.');
  const order = await one('orders', { id: 'eq.' + request.order_id });
  if (!order) return fail('Không tìm thấy đơn.');
  const reason = clean(payload.reason);
  const reviewed = await db('settlement_requests', { order_id: 'eq.' + order.id, status: 'eq.PENDING' }, 'PATCH', {
    status: decision, admin_username: user.username, admin_name: user.display_name,
    reviewed_at: new Date().toISOString(), rejection_reason: reason
  });
  if (!reviewed.length) return fail('Yêu cầu vừa được người khác xử lý.');
  if (decision === 'APPROVED') await db('orders', { id: 'eq.' + order.id }, 'PATCH', { settled: true, updated_at: new Date().toISOString() });
  await audit(user, order.id, 'REVIEW_SETTLEMENT', { status: 'PENDING' }, { status: decision, reason });
  return { ok: true, processedRequests: reviewed.length, message: decision === 'APPROVED' ? 'Đã duyệt tất toán.' : 'Đã trả đơn cho Sale chỉnh sửa.', orderId: order.id };
}
async function reviewBulk(payload, user) {
  const ids = [...new Set(Array.isArray(payload.requestIds) ? payload.requestIds.map(clean).filter(Boolean) : [])].slice(0, 100);
  if (!ids.length) return fail('Chưa chọn yêu cầu nào.');
  const failedItems = [], approvedOrderIds = [];
  const seenOrders = new Set();
  for (const id of ids) {
    const request = await one('settlement_requests', { id: 'eq.' + id });
    if (request && seenOrders.has(request.order_id)) continue;
    if (request) seenOrders.add(request.order_id);
    const result = await reviewSettlement({ requestId: id, decision: 'APPROVED' }, user);
    if (result.ok) approvedOrderIds.push(result.orderId);
    else failedItems.push({ requestId: id, reason: result.message });
  }
  return { ok: failedItems.length === 0, selected: ids.length, approved: approvedOrderIds.length, failed: failedItems.length, failedItems, approvedOrderIds, message: 'Đã duyệt ' + approvedOrderIds.length + ' đơn.' };
}
async function getKpi(payload, user) {
  const month = clean(payload.month) || dateToday().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return fail('Tháng KPI không hợp lệ.');
  const start = month + '-01', end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const allOrders = await decoratedRange(start, end, user);
  // Tính trên toàn bộ đơn hàng trong tháng để khớp 100% với doanh thu Sheet sum lại
  const orders = allOrders;
  const penalties = await all('kpi_operations', { month: 'eq.' + month });
  const users = await all('app_users', {});
  const userMap = new Map();
  for (const u of users) {
    userMap.set(norm(u.username), u);
    userMap.set(norm(u.display_name), u);
  }
  const aliases = {
    'huynh kim xuyen': 'huynhxuyen', 'huynh xuyen': 'huynhxuyen', 'xuyen': 'huynhxuyen',
    'huynh minh thu': 'huynhthu', 'huynh thu': 'huynhthu', 'thu': 'huynhthu',
    'huynh ngoc lan': 'huynhlan', 'huynh lan': 'huynhlan', 'lan': 'huynhlan',
    'hien le': 'hien', 'hien': 'hien',
    'minh tien': 'tien', 'tien': 'tien',
    'khanh': 'cmui', 'c mui': 'cmui', 'pu': 'pu'
  };
  function resolveUser(sale) {
    const raw = clean(sale), k = norm(raw);
    if (!raw) return userMap.get('cmui') || null;
    const mapped = aliases[k] || k;
    return userMap.get(mapped) || userMap.get(k) || null;
  }

  const grouped = {};
  for (const o of orders) {
    const u = resolveUser(o.sale);
    if (user.role === 'SALE') {
      const isMe = (u && norm(u.username) === norm(user.username)) ||
                   norm(o.sale) === norm(user.username) ||
                   norm(o.sale) === norm(user.display_name);
      if (!isMe) continue;
    } else if (user.role !== 'ADMIN') {
      if (u && norm(u.username) === 'cmui') continue;
    }
    const saleKey = u ? u.display_name : (o.sale || 'Chưa gán');
    const item = grouped[saleKey] ||= { sale: saleKey, username: u ? u.username : '', revenue: 0, orders: 0, bigOrders: 0 };
    item.revenue += o.flowerTotal;
    item.orders++;
    if (o.flowerTotal >= 500000) item.bigOrders++;
  }

  const holiday = [2, 3, 10, 11].includes(Number(month.slice(5, 7)));
  const target = holiday ? 50000000 : 38000000, bigTarget = holiday ? 20 : 16;
  for (const item of Object.values(grouped)) {
    const penalty = penalties.filter(x => {
      const px = norm(x.sale_name || ''), pu = norm(x.sale_username || '');
      const ix = norm(item.sale || ''), iu = norm(item.username || '');
      return (ix && px === ix) || (iu && pu === iu) || (iu && px === iu);
    }).reduce((n, x) => n + num(x.total_points), 0);

    item.operationsScore = Math.max(0, 100 - penalty);
    item.level1 = holiday ? item.revenue >= target : item.revenue > target;
    item.bigTarget = bigTarget;
    item.level2 = item.level1 && item.bigOrders >= bigTarget && item.operationsScore > 80;
    item.rate = item.level2 ? .10 : .08;
    item.commission = item.revenue * item.rate;
    item.bonus = item.level1 ? 300000 : 0;
  }
  return { ok: true, month, holiday, items: Object.values(grouped), note: 'Mức 2 = đạt Mức 1 + target đơn ≥500.000đ + KPI vận hành >80.' };
}
async function saveKpi(payload, user) {
  const d = payload.item || {}, points = num(d.points), count = Math.max(1, Math.floor(num(d.count) || 1));
  if (!/^\d{4}-\d{2}$/.test(clean(d.month)) || !clean(d.saleName) || ![5, 10].includes(points)) return fail('Dữ liệu KPI chưa hợp lệ.');
  const id = newId('KPI');
  await db('kpi_operations', {}, 'POST', {
    id, month: d.month, event_date: d.date || null, sale_username: clean(d.saleUsername),
    sale_name: clean(d.saleName), order_id: clean(d.orderId) || null, error_type: clean(d.type),
    points, count, total_points: points * count, note: clean(d.note),
    admin_username: user.username, admin_name: user.display_name
  });
  return { ok: true, id };
}
function flowerKey(value) { return clean(value).replace(/\s+/g, ' ').toLocaleLowerCase('vi'); }
function canonicalFlowers(values) {
  return [...new Map((Array.isArray(values) ? values : []).map(value => clean(value).replace(/\s+/g, ' '))
    .filter(Boolean).map(value => [flowerKey(value), value])).values()];
}
async function classifyFlowers(items) {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return null;
  const models = [...new Set([Deno.env.get('GEMINI_MODEL'), 'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.8-flash'].filter(Boolean))];
  const prompt = 'Phân loại các mẫu hoa sau thành tên loài hoa chuẩn tiếng Việt. Không đếm cành, bỏ phụ kiện/bao bì/phong cách. Ly/Lily chuẩn hóa thành Lily. Nếu không xác định được loài hoa thì flowers=[] và needs_review=true. Chỉ trả JSON {"results":[{"fingerprint":"...","flowers":["..."],"needs_review":false}]}: ' + JSON.stringify(items);
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: .1, responseMimeType: 'application/json' } };
  for (const model of models) {
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body)
      });
      if (!response.ok) continue;
      const data = await response.json();
      const raw = (data?.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (Array.isArray(parsed.results)) return parsed.results;
    } catch (error) { console.error('Flower classification failed for model', model, error); }
  }
  return null;
}
async function flowers(payload, user) {
  const date = clean(payload.date) || dateToday(), orders = await decoratedRange(date, date, user);
  if (!orders.length) return { ok: true, status: 'empty', totalOrders: 0, analyzedOrders: 0, reviewCount: 0, items: [], reviewOrders: [] };
  const cacheRows = await all('flower_cache', { select: 'content,flowers,needs_review,updated_at', order: 'updated_at.asc' });
  const cache = new Map(cacheRows.map(row => [flowerKey(row.content), row]));
  const unique = [...new Map(orders.map(order => [flowerKey(order.flower), clean(order.flower).slice(0, 700)]).filter(([key]) => key)).entries()];
  const pending = unique.filter(([key]) => payload.forceRefresh || !cache.has(key));
  for (let i = 0; i < pending.length; i += 40) {
    const batch = await Promise.all(pending.slice(i, i + 40).map(async ([key, note]) => ({ fingerprint: await sha256(key), note })));
    const results = await classifyFlowers(batch);
    if (!results) break;
    const byFingerprint = new Map(results.filter(result => result?.fingerprint).map(result => [result.fingerprint, result]));
    const rows = batch.map(item => {
      const result = byFingerprint.get(item.fingerprint) || {};
      return { fingerprint: item.fingerprint, content: item.note, flowers: canonicalFlowers(result.flowers),
        needs_review: !!result.needs_review || !Array.isArray(result.flowers) || !result.flowers.length, updated_at: new Date().toISOString() };
    });
    await db('flower_cache', { on_conflict: 'fingerprint' }, 'POST', rows);
    rows.forEach(row => cache.set(flowerKey(row.content), row));
  }
  const groups = new Map(), reviewOrders = [];
  let analyzedOrders = 0;
  for (const order of orders) {
    const entry = cache.get(flowerKey(order.flower));
    const names = canonicalFlowers(entry?.flowers);
    if (entry) analyzedOrders++;
    if (!entry || entry.needs_review || !names.length) reviewOrders.push({ customer: order.customer, flower: order.flower, date: order.date, time: order.time });
    for (const name of names) {
      const groupKey = flowerKey(name), group = groups.get(groupKey) || { name, orders: 0, orderList: [] };
      group.orders++;
      group.orderList.push({ customer: order.customer, flower: order.flower, time: order.time, id: order.id });
      groups.set(groupKey, group);
    }
  }
  const items = [...groups.values()].sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name, 'vi'));
  return { ok: true, status: reviewOrders.length ? 'needs_review' : 'ready', totalOrders: orders.length, analyzedOrders, reviewCount: reviewOrders.length, items, reviewOrders: reviewOrders.slice(0, 100) };
}
async function saveUser(payload, admin) {
  const u = payload.user || {}, username = usernameNorm(u.username), name = clean(u.name), role = clean(u.role).toUpperCase();
  if (!username || !name || !['ADMIN', 'THO_OPS', 'SALE'].includes(role)) return fail('Thông tin tài khoản chưa hợp lệ.');
  const found = await one('app_users', { username: 'eq.' + username });
  if (!found && String(u.password || '').length < 6) return fail('Mật khẩu mới phải có ít nhất 6 ký tự.');
  const patch = { username, display_name: name, role, active: u.active !== false };
  if (u.password) patch.password_hash = await sha256(PASSWORD_SALT + '|' + String(u.password));
  if (found) {
    await db('app_users', { username: 'eq.' + username }, 'PATCH', patch);
    if (u.password || !patch.active || role !== found.role) await db('app_sessions', { username: 'eq.' + username }, 'DELETE');
  } else await db('app_users', {}, 'POST', patch);
  await audit(admin, null, 'ADMIN_USER', null, { username, role });
  return { ok: true, name };
}

async function logPerformanceBatch(payload, user) {
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
  const rows = items.filter(x => clean(x.api)).map(x => ({
    occurred_at: Number.isFinite(Date.parse(x.at)) ? x.at : new Date().toISOString(),
    api: clean(x.api).slice(0, 80), total_ms: Math.max(0, Math.min(120000, Math.round(num(x.totalMs)))),
    server_ms: Math.max(0, Math.min(120000, Math.round(num(x.serverMs)))),
    username: user.username, role: user.role, source: 'CLIENT'
  }));
  if (rows.length) await db('performance_log', {}, 'POST', rows);
  return { ok: true, count: rows.length };
}
async function performanceReport(payload) {
  const limit = Math.min(2000, Math.max(100, Math.floor(num(payload.limit) || 800)));
  const rows = await db('performance_log', { select: 'api,total_ms,server_ms', order: 'occurred_at.desc', limit: String(limit) });
  const grouped = new Map();
  for (const row of rows) {
    const values = grouped.get(row.api) || [];
    values.push(row);
    grouped.set(row.api, values);
  }
  const items = [...grouped].map(([api, values]) => {
    const sorted = values.map(x => num(x.total_ms)).sort((a, b) => a - b);
    const avg = key => Math.round(values.reduce((sum, x) => sum + num(x[key]), 0) / values.length);
    return { api, samples: values.length, p50Ms: sorted[Math.floor((sorted.length - 1) * .50)],
      p95Ms: sorted[Math.floor((sorted.length - 1) * .95)], serverAvgMs: avg('server_ms'),
      clientAvgMs: Math.max(0, avg('total_ms') - avg('server_ms')), maxMs: sorted.at(-1) };
  }).sort((a, b) => b.p95Ms - a.p95Ms);
  return { ok: true, items, samples: rows.length };
}

const readRoutes = {
  getAppOptions: options, getDashboardSummary: dashboard,
  getProductionOrders: getProduction, getOrders, getDebtReview: getDebt,
  getOrder, getSettlementQueue: settlementQueue, getKpi,
  getFlowerInventory: flowers
};
const writeRoutes = {
  createOrder, updateOrder, updateStatus, updateStatusBulk,
  saveShipFee, saveShipAndSubmitSettlement: submitSettlement,
  reviewSettlement, reviewSettlementsBulk: reviewBulk,
  saveKpiOperation: saveKpi, saveUser
};
const adminRoutes = new Set(['listUsers', 'getSettlementQueue', 'reviewSettlement',
  'reviewSettlementsBulk', 'saveKpiOperation', 'saveUser', 'getPerformanceReport',
  'logPerformanceBatch', 'getDashboardSummary']);
const opsRoutes = new Set(['updateStatus', 'updateStatusBulk', 'getFlowerInventory',
  'getProductionOrders']);

async function dispatch(name, payload) {
  if (name === 'loginAndBootstrap') return loginAndBootstrap(payload);
  const user = await requireUser(payload, adminRoutes.has(name) ? ['ADMIN'] :
    opsRoutes.has(name) ? ['ADMIN', 'THO_OPS'] : null);
  if (name === 'getCurrentUserAndBootstrap')
    return { ok: true, user: publicUser(user), initial: await initial(user) };
  if (name === 'listUsers') return usersList();
  if (name === 'getPerformanceReport') return performanceReport(payload);
  if (name === 'logPerformanceBatch') return logPerformanceBatch(payload, user);
  const route = readRoutes[name] || writeRoutes[name];
  if (!route) return fail('Thao tác không được hỗ trợ.');
  return route(payload, user);
}

Deno.serve(async request => {
  const origin = request.headers.get('origin');
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : (origin && (origin.includes('localhost') || origin.includes('127.0.0.1')) ? origin : ALLOWED_ORIGIN);
  const cors = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  };
  if (origin && !ALLOWED_ORIGINS.includes(origin) && !origin.includes('localhost') && !origin.includes('127.0.0.1')) return new Response('Forbidden', { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  if (!SUPABASE_URL || !SERVICE_KEY) return new Response(JSON.stringify(fail('Máy chủ chưa cấu hình.')), { status: 503, headers: cors });
  try {
    if (Number(request.headers.get('content-length') || 0) > 12 * 1024 * 1024)
      return new Response(JSON.stringify(fail('Dữ liệu gửi lên quá lớn.')), { status: 413, headers: cors });
    const input = await request.json();
    const name = clean(input?.name), payload = input?.payload && typeof input.payload === 'object' ? input.payload : {};
    const started = Date.now();
    const result = await dispatch(name, payload);
    return new Response(JSON.stringify({ ...result, build: BUILD, _perf: { serverMs: Date.now() - started } }), { headers: cors });
  } catch (error) {
    const authError = /Phiên đăng nhập|Tài khoản đã bị khóa|Không có quyền/.test(error.message);
    if (!authError) console.error('Meehoasg API error:', error);
    const message = authError ? error.message : 'Máy chủ gặp lỗi. Vui lòng thử lại.';
    const code = authError ? 'AUTH_REQUIRED' : 'SERVER_ERROR';
    return new Response(JSON.stringify({ ...fail(message, code), build: BUILD }), { status: 200, headers: cors });
  }
});
