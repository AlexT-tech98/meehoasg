// Server-to-server Sheet shadow import. Apps Script authenticates with
// INGEST_SECRET; deploy with verify_jwt=false because it has no Supabase JWT.
const BUILD = '2026.10.09-sheet-ack-gated3';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const INGEST_SECRET = Deno.env.get('INGEST_SECRET');
const SHEET_IMPORT_ENABLED = Deno.env.get('SHEET_IMPORT_ENABLED') === 'true';
const encoder = new TextEncoder();

function clean(value) { return String(value ?? '').trim(); }
function norm(value) { return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase(); }
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let raw = clean(value).replace(/[^\d.,-]/g, '');
  if (raw.includes(',') && raw.includes('.')) raw = raw.replaceAll('.', '').replace(',', '.');
  else if (/^-?\d{1,3}(?:[.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, '');
  else raw = raw.replace(',', '.');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
function bool(value) { return value === true || value === 1 || ['true', 'yes', '1', 'x'].includes(norm(value)); }
function isoDate(value) {
  const raw = clean(value);
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
function cleanTime(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (raw.includes('1899') || raw.includes('GMT')) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    }
  }
  const m = raw.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return raw.slice(0, 5);
}
function saleName(value) {
  const raw = clean(value), key = norm(raw);
  const aliases = {
    'huynh kim xuyen': 'huynhxuyen', 'huynh xuyen': 'huynhxuyen',
    'huynh minh thu': 'huynhthu', 'huynh thu': 'huynhthu',
    'huynh ngoc lan': 'huynhlan', 'huynh lan': 'huynhlan',
    'hien le': 'hien', 'hien': 'hien',
    'minh tien': 'tien', 'tien': 'tien',
    'khanh': 'cmui', 'c mui': 'cmui', 'pu': 'pu'
  };
  if (!raw) return 'cmui';
  if (['full', '62k', 'chua coc', 'da coc', 'chua cop', 'da cop'].includes(key)) return '';
  return aliases[key] || raw;
}
function mapOrder(raw) {
  const sourceId = clean(raw.id), id = clean(raw.sync_id || sourceId);
  const orderDate = isoDate(raw.order_date || raw.date);
  if (!sourceId || !id || !orderDate) return null;
  const status = clean(raw.status);
  return {
    id, source_sheet: clean(raw.source_sheet) || null,
    source_row: Number(raw.source_row) || null,
    customer: clean(raw.customer), phone: clean(raw.phone),
    order_date: orderDate, order_time: cleanTime(raw.order_time),
    flower: clean(raw.flower), note: clean(raw.note),
    shipping: clean(raw.shipping), address: clean(raw.address),
    flower_total: num(raw.flower_total), payment: clean(raw.payment),
    sale: saleName(raw.sale),
    status: ['Chờ bó', 'Đã bó', 'Đã giao'].includes(status) ? status : 'Chờ bó',
    settled: bool(raw.settled), ship_fee: num(raw.ship_fee),
    ship_confirmed: bool(raw.ship_confirmed),
    card: bool(raw.card), card_text: clean(raw.card_text),
    banner: bool(raw.banner), banner_text: clean(raw.banner_text),
    charm_fee: num(raw.charm_fee), charm_text: clean(raw.charm_text),
    paper_fee: num(raw.paper_fee), paper_text: clean(raw.paper_text),
    vat: num(raw.vat),
    image_urls: Array.isArray(raw.image_urls) ? [...new Set(raw.image_urls.map(clean).filter(Boolean))] : []
  };
}
async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function sameSecret(provided) {
  const a = encoder.encode(provided), b = encoder.encode(INGEST_SECRET || '');
  if (!b.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function rest(table, query = {}, method = 'GET', body) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' && query.on_conflict ? 'resolution=merge-duplicates,return=minimal' : 'return=representation'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const content = await response.text();
  if (!response.ok) throw new Error(`Database ${response.status}: ${content.slice(0, 240)}`);
  return content ? JSON.parse(content) : [];
}
async function recordRun(stats, detail) {
  await rest('sync_runs', {}, 'POST', {
    entity: 'orders', received: stats.received, inserted: stats.inserted,
    updated: stats.updated, unchanged: stats.unchanged,
    skipped: stats.skipped, errors: stats.errors,
    finished_at: new Date().toISOString(), detail: { build: BUILD, ...(detail || {}) }
  });
}
async function ingestOrders(rawList) {
  const stats = { received: rawList.length, inserted: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };
  const mapped = rawList.map(mapOrder);
  stats.skipped = mapped.filter(row => !row).length;
  const validRows = mapped.filter(Boolean);
  const rows = [];
  const seenIds = new Set();
  const duplicateIds = [];
  for (const row of validRows) {
    if (seenIds.has(row.id)) {
      stats.skipped++;
      duplicateIds.push(row.id);
      continue;
    }
    seenIds.add(row.id);
    rows.push(row);
  }
  if (duplicateIds.length) console.warn('Duplicate order IDs skipped in batch:', [...new Set(duplicateIds)]);
  const ids = rows.map(row => row.id);
  const existing = ids.length ? await rest('orders', {
    select: 'id,sync_hash,request_id', id: `in.(${ids.map(id => `"${id.replaceAll('"', '\\"')}"`).join(',')})`
  }) : [];
  const byId = new Map(existing.map(row => [row.id, row]));
  const changed = [];
  for (const row of rows) {
    const digest = await sha256(JSON.stringify(row));
    const prior = byId.get(row.id);
    if (prior?.sync_hash === digest) { stats.unchanged++; continue; }
    if (prior) stats.updated++; else stats.inserted++;
    changed.push({
      ...row,
      request_id: prior?.request_id || null,
      sync_hash: digest,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }
  if (changed.length) await rest('orders', { on_conflict: 'id' }, 'POST', changed);
  await recordRun(stats, {
    source_sheets: [...new Set(rows.map(row => row.source_sheet))].filter(Boolean),
    duplicate_ids: [...new Set(duplicateIds)]
  });
  return { ok: true, build: BUILD, ...stats, processed: rows.length, duplicate_ids: [...new Set(duplicateIds)] };
}

async function getOrdersForSheet(payload) {
  const since = clean(payload.since);
  const limit = Math.min(200, Math.max(1, Number(payload.limit) || 100));
  const query = {
    select: 'id,customer,phone,order_date,order_time,flower,note,shipping,address,flower_total,payment,sale,status,settled,ship_fee,ship_confirmed,card,card_qty,full_paid,full_paid_total,full_paid_bill_urls,full_paid_by,full_paid_at,full_paid_invalidated_at,full_paid_invalidated_reason,card_text,banner,banner_text,charm_fee,charm_text,paper_fee,paper_text,vat,image_urls,source_sheet,source_row,updated_at,created_at',
    order: 'updated_at.desc',
    limit: String(limit)
  };
  if (since) query.updated_at = 'gte.' + since;
  const rows = await rest('orders', query);
  return { ok: true, build: BUILD, orders: rows || [] };
}

async function recordSheetPositions(payload) {
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (updates.length > 200) throw new Error('Tối đa 200 vị trí mỗi batch.');
  let updated = 0, conflicts = 0;
  const now = new Date().toISOString();
  for (const item of updates) {
    const id = clean(item.id);
    if (!id) continue;
    // Preserve production ACK/deletion semantics. Versioned workers only
    // acknowledge the version they wrote; old workers remain compatible.
    const patch = { needs_sheet_sync: false, sheet_synced_at: now };
    if (item.source_sheet) patch.source_sheet = clean(item.source_sheet);
    if (Number.isFinite(item.source_row)) patch.source_row = Number(item.source_row);
    if (Object.keys(patch).length > 0) {
      // source_row is location cache only; identity remains orders.id / Sheet column O.
      const query = { id: 'eq.' + id };
      if (clean(item.expectedUpdatedAt)) query.updated_at = 'eq.' + clean(item.expectedUpdatedAt);
      const rows = await rest('orders', query, 'PATCH', patch);
      if (rows.length) updated++; else conflicts++;
    }
  }
  return { ok: conflicts === 0, build: BUILD, updated, conflicts };
}

Deno.serve(async request => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'POST only' }), { status: 405, headers });
  if (!SUPABASE_URL || !SERVICE_KEY || !INGEST_SECRET) return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'Not configured' }), { status: 503, headers });
  if (!sameSecret(request.headers.get('x-ingest-secret') || '')) return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'Unauthorized' }), { status: 401, headers });
  if (Number(request.headers.get('content-length') || 0) > 5 * 1024 * 1024)
    return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'Payload too large' }), { status: 413, headers });
  try {
    const body = await request.json();
    if (body.action === 'getOrdersForSheet') return new Response(JSON.stringify(await getOrdersForSheet(body)), { headers });
    if (body.action === 'recordSheetPositions') return new Response(JSON.stringify(await recordSheetPositions(body)), { headers });
    if (!SHEET_IMPORT_ENABLED) return new Response(JSON.stringify({ok:false,code:'IMPORT_DISABLED',message:'Website là nguồn chính. Chỉ cho phép feed và cập nhật vị trí Sheet.'}),{status:409,headers});
    if (!Array.isArray(body.orders) || body.orders.length > 100) throw new Error('Tối đa 100 đơn mỗi batch.');
    return new Response(JSON.stringify(await ingestOrders(body.orders)), { headers });
  } catch (error) {
    console.error('Meehoasg ingest failed:', error);
    return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'Đồng bộ thất bại; vui lòng xem log máy chủ.' }), { status: 500, headers });
  }
});
