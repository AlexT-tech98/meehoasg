const BUILD = '2026.09.28-supabase-v3';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY');
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
const LEGACY_API = `${SUPABASE_URL}/functions/v1/meehoasg-api`;
const ALLOWED_ORIGINS = ['https://ops.meehoasg.com', 'http://ops.meehoasg.com', 'https://meehoasg.com', 'http://meehoasg.com'];

function clean(v) { return String(v ?? '').trim(); }
function norm(v) { return clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().replace(/\s+/g, ' '); }
function num(v) { const n = Number(String(v ?? 0).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; }
function fail(message, code) { return { ok: false, message, ...(code ? { code } : {}) }; }
function dateToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function monthEnd(month) { return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10); }
function flowerKey(value) { return norm(value).replace(/\s+/g, ' '); }
async function sha256(text) { const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); return [...bytes].map(n => n.toString(16).padStart(2, '0')).join(''); }

async function db(table, query = {}, method = 'GET', body) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'GET' ? 'count=exact' : (query.on_conflict ? 'return=representation,resolution=merge-duplicates' : 'return=representation')
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Database ${res.status}: ${text.slice(0, 300)}`);
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

async function legacyCall(name, payload, request) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: request.headers.get('authorization') || '',
    apikey: request.headers.get('apikey') || ''
  };
  const res = await fetch(LEGACY_API, { method: 'POST', headers, body: JSON.stringify({ name, payload }) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch (_) { data = fail('Máy chủ trả dữ liệu không hợp lệ.'); }
  return { status: res.status, data };
}

function settledRevenueOrders(rows) { return rows.filter(r => r.settled === true); }
function revenueOf(row) { return num(row.flower_total); }

async function patchDashboard(payload, request) {
  const base = await legacyCall('getDashboardSummary', payload, request);
  if (!base.data?.ok) return base.data;
  const start = clean(payload.start) || dateToday();
  const end = clean(payload.end) || start;
  const rows = await all('orders', {
    select: 'id,order_date,flower_total,sale,settled',
    and: `(order_date.gte.${start},order_date.lte.${end})`,
    order: 'order_date.asc'
  });
  const settled = settledRevenueOrders(rows);
  const revenue = settled.reduce((sum, row) => sum + revenueOf(row), 0);
  const daily = new Map();
  for (const row of settled) {
    const sale = clean(row.sale) || 'Chưa gán';
    const date = clean(row.order_date);
    const key = `${date}|${sale}`;
    const x = daily.get(key) || { date, sale, revenue: 0, orders: 0 };
    x.revenue += revenueOf(row);
    x.orders += 1;
    daily.set(key, x);
  }
  const salesDaily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date) || b.revenue - a.revenue || a.sale.localeCompare(b.sale, 'vi'));
  base.data.summary = { ...(base.data.summary || {}), revenue, cms: revenue * 0.08, settledOrders: settled.length };
  base.data.salesDaily = salesDaily;
  base.data.revenueRule = 'SETTLED_ONLY';
  return base.data;
}

function kpiItemKeys(item) {
  return new Set([norm(item?.sale), norm(item?.username)].filter(Boolean));
}
function orderMatchesKpi(row, item) {
  const sale = norm(row.sale);
  return sale && kpiItemKeys(item).has(sale);
}
async function patchKpi(payload, request) {
  const base = await legacyCall('getKpi', payload, request);
  if (!base.data?.ok) return base.data;
  const month = clean(payload.month) || dateToday().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return base.data;
  const rows = await all('orders', {
    select: 'id,order_date,flower_total,sale,settled',
    and: `(order_date.gte.${month}-01,order_date.lte.${monthEnd(month)})`,
    order: 'order_date.asc'
  });
  const settled = settledRevenueOrders(rows);
  const target = base.data.holiday ? 50000000 : 38000000;
  const bigTarget = base.data.holiday ? 20 : 16;
  base.data.items = (base.data.items || []).map(item => {
    const mine = settled.filter(row => orderMatchesKpi(row, item));
    const revenue = mine.reduce((sum, row) => sum + revenueOf(row), 0);
    const bigOrders = mine.filter(row => revenueOf(row) >= 500000).length;
    const orders = mine.length;
    const operationsScore = num(item.operationsScore);
    const level1 = base.data.holiday ? revenue >= target : revenue > target;
    const level2 = level1 && bigOrders >= bigTarget && operationsScore > 80;
    const rate = level2 ? 0.10 : 0.08;
    return { ...item, revenue, orders, bigOrders, bigTarget, level1, level2, rate, commission: revenue * rate, bonus: level1 ? 300000 : 0 };
  });
  base.data.revenueRule = 'SETTLED_ONLY';
  base.data.note = `${clean(base.data.note)} Chỉ tính doanh thu từ đơn đã tất toán.`.trim();
  return base.data;
}

function titleCaseIngredient(value) {
  const raw = clean(value).replace(/\s+/g, ' ');
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
}
function canonicalIngredientName(value) {
  const raw = clean(value).replace(/\s+/g, ' ');
  const n = norm(raw);
  if (!n) return '';
  if (/hong\s*(ecu|ecuador)|ecuador\s*rose|rose\s*ecuador/.test(n)) return 'Hồng Ecuador';
  if (/chiet\s*xa/.test(n)) return 'Chiết xạ';
  if (/^(ly|li|lily|lilies)\b/.test(n) || /\b(ly|li|lily|lilies)\b/.test(n)) {
    if (/son\s*xanh/.test(n)) return 'Ly sơn xanh';
    if (/xanh/.test(n) && /nhuom/.test(n)) return 'Ly xanh nhuộm';
    if (/xanh/.test(n)) return 'Ly xanh';
    if (/hong/.test(n)) return 'Ly hồng';
    if (/trang/.test(n)) return 'Ly trắng';
    if (/vang/.test(n)) return 'Ly vàng';
    if (/kep/.test(n)) return 'Ly kép';
    return 'Ly';
  }
  return titleCaseIngredient(raw);
}
function canonicalIngredients(values) {
  const map = new Map();
  for (const v of Array.isArray(values) ? values : []) {
    const name = canonicalIngredientName(v);
    if (name) map.set(flowerKey(name), name);
  }
  return [...map.values()];
}

async function classifyIngredients(items) {
  if (!GEMINI_KEY || !items.length) return null;
  const models = [...new Set([GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.8-flash'].filter(Boolean))];
  const prompt = `Bạn là AI phân tích NGUYÊN LIỆU HOA cho tiệm hoa. Với mỗi mô tả đơn hàng, hãy trả danh sách loại hoa cần chuẩn bị theo cấp độ đủ cụ thể để florist mua/chia nguyên liệu.\n\nQUY TẮC BẮT BUỘC:\n- Chuẩn hóa lỗi chính tả, số nhiều và tên gọi đồng nghĩa, nhưng KHÔNG làm mất màu/biến thể/xử lý của hoa.\n- lily / lilies / ly / li -> Ly nếu không có đặc tính cụ thể.\n- ly kép / li kép -> Ly kép.\n- ly hồng -> Ly hồng.\n- ly xanh nhuộm -> Ly xanh nhuộm.\n- ly sơn xanh -> Ly sơn xanh.\n- hồng ecu / hồng ecuador / ecuador -> Hồng Ecuador.\n- chiết xạ -> Chiết xạ.\n- Một đơn có nhiều loại hoa thì trả TẤT CẢ loại hoa.\n- Không đếm cành/số lượng cành. Không trả giấy gói, nơ, thiệp, charm, phụ kiện, phong cách hoặc màu giấy.\n- Nếu mô tả không đủ để xác định hoa, flowers=[] và needs_review=true.\n- Nếu xác định được hoa thì needs_review=false.\n- Giữ nguyên fingerprint nhận vào.\n\nChỉ trả JSON đúng schema: {"results":[{"fingerprint":"...","flowers":["..."],"needs_review":false}]}\n\nDỮ LIỆU: ${JSON.stringify(items)}`;
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.05, responseMimeType: 'application/json' } };
  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: JSON.stringify(body)
      });
      if (!response.ok) continue;
      const data = await response.json();
      const raw = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (Array.isArray(parsed.results)) return parsed.results;
    } catch (e) { console.error('v36 material AI failed', model, e); }
  }
  return null;
}

async function patchFlowers(payload) {
  const date = clean(payload.date) || dateToday();
  const orders = await all('orders', {
    select: 'id,customer,order_date,order_time,flower',
    and: `(order_date.gte.${date},order_date.lte.${date})`,
    order: 'order_time.asc'
  });
  if (!orders.length) return { ok: true, status: 'empty', totalOrders: 0, analyzedOrders: 0, reviewCount: 0, items: [], reviewOrders: [], classifierVersion: 'v36-specific' };

  const uniqueMap = new Map();
  for (const order of orders) {
    const content = clean(order.flower).slice(0, 700);
    const key = flowerKey(content);
    if (key && !uniqueMap.has(key)) uniqueMap.set(key, content);
  }
  const unique = [...uniqueMap.entries()];
  const keyed = await Promise.all(unique.map(async ([key, content]) => ({ key, content, fingerprint: await sha256(`v36-specific|${key}`) })));
  const cacheRows = await all('flower_cache', { select: 'fingerprint,content,flowers,needs_review,updated_at', order: 'updated_at.desc' });
  const cache = new Map(cacheRows.map(row => [row.fingerprint, row]));
  const pending = keyed.filter(x => payload.forceRefresh || !cache.has(x.fingerprint));

  for (let i = 0; i < pending.length; i += 35) {
    const batch = pending.slice(i, i + 35).map(x => ({ fingerprint: x.fingerprint, note: x.content }));
    const results = await classifyIngredients(batch);
    if (!results) break;
    const byId = new Map(results.filter(r => r?.fingerprint).map(r => [r.fingerprint, r]));
    const rows = batch.map(item => {
      const result = byId.get(item.fingerprint) || {};
      const flowers = canonicalIngredients(result.flowers);
      return { fingerprint: item.fingerprint, content: item.note, flowers, needs_review: !!result.needs_review || !flowers.length, updated_at: new Date().toISOString() };
    });
    if (rows.length) {
      await db('flower_cache', { on_conflict: 'fingerprint' }, 'POST', rows);
      rows.forEach(row => cache.set(row.fingerprint, row));
    }
  }

  const fingerprintByKey = new Map(keyed.map(x => [x.key, x.fingerprint]));
  const groups = new Map();
  const reviewOrders = [];
  let analyzedOrders = 0;
  for (const order of orders) {
    const key = flowerKey(order.flower);
    const fp = fingerprintByKey.get(key);
    const entry = fp ? cache.get(fp) : null;
    const names = canonicalIngredients(entry?.flowers);
    if (entry) analyzedOrders++;
    if (!entry || entry.needs_review || !names.length) {
      reviewOrders.push({ id: order.id, customer: order.customer, flower: order.flower, date: order.order_date, time: clean(order.order_time).slice(0, 5) });
    }
    for (const name of names) {
      const gk = flowerKey(name);
      const group = groups.get(gk) || { name, orders: 0, orderList: [] };
      if (!group.orderList.some(x => x.id === order.id)) {
        group.orders++;
        group.orderList.push({ id: order.id, customer: order.customer, flower: order.flower, time: clean(order.order_time).slice(0, 5), date: order.order_date });
      }
      groups.set(gk, group);
    }
  }
  const items = [...groups.values()].sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name, 'vi'));
  return { ok: true, status: reviewOrders.length ? 'needs_review' : 'ready', totalOrders: orders.length, analyzedOrders, reviewCount: reviewOrders.length, items, reviewOrders: reviewOrders.slice(0, 100), classifierVersion: 'v36-specific' };
}

Deno.serve(async request => {
  const origin = request.headers.get('origin');
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : (origin && (origin.includes('localhost') || origin.includes('127.0.0.1')) ? origin : 'https://ops.meehoasg.com');
  const cors = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  if (!SUPABASE_URL || !SERVICE_KEY) return new Response(JSON.stringify({ ...fail('Máy chủ chưa cấu hình.'), build: BUILD }), { status: 503, headers: cors });
  const started = Date.now();
  try {
    const input = await request.json();
    const name = clean(input?.name);
    const payload = input?.payload && typeof input.payload === 'object' ? input.payload : {};
    let result;
    if (name === 'getDashboardSummary') result = await patchDashboard(payload, request);
    else if (name === 'getKpi') result = await patchKpi(payload, request);
    else if (name === 'getFlowerInventory') {
      const permission = await legacyCall('getProductionOrders', { date: clean(payload.date) || dateToday() }, request);
      if (!permission.data?.ok && permission.data?.code === 'AUTH_REQUIRED') result = permission.data;
      else result = await patchFlowers(payload);
    } else {
      const delegated = await legacyCall(name, payload, request);
      result = delegated.data;
    }
    return new Response(JSON.stringify({ ...result, build: BUILD, _perf: { serverMs: Date.now() - started, proxy: 'v36' } }), { headers: cors });
  } catch (error) {
    console.error('Meehoasg API v36 error:', error);
    return new Response(JSON.stringify({ ...fail('Máy chủ gặp lỗi. Vui lòng thử lại.', 'SERVER_ERROR'), build: BUILD }), { status: 200, headers: cors });
  }
});