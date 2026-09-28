// Supabase Edge Function: meehoasg-ingest
// Nhận dữ liệu đồng bộ từ Apps Script → upsert vào Supabase
// Deploy: supabase functions deploy meehoasg-ingest --project-ref zxnfhshnavbmvdthrmrd
// Secret cần set: INGEST_SECRET (cùng giá trị với Apps Script)

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const INGEST_SECRET  = Deno.env.get('INGEST_SECRET');

function clean(v) { return String(v ?? '').trim(); }
function num(v) {
  const n = Number(String(v ?? '0').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function bool(v) { return v === true || v === 1 || ['true','yes','1','x'].includes(String(v ?? '').trim().toLowerCase()); }
function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return s.slice(0, 10);
  return null;
}

// Bảng mapping sale đã được xác nhận 28/09/2026
const SALE_MAP_RAW = [
  ['huỳnh kim xuyến','huynhxuyen'],['huynh kim xuyen','huynhxuyen'],
  ['huỳnh minh thư','huynhthu'],['huỳnh minh thu','huynhthu'],['huynh minh thu','huynhthu'],
  ['huỳnh ngọc lan','huynhlan'],['huynh ngoc lan','huynhlan'],
  ['hiền lê','hien'],['hien le','hien'],
  ['minh tiên','tien'],['minh tien','tien'],
  ['khanh','cmui'],['','cmui'],
];
const SALE_MAP = new Map(SALE_MAP_RAW);
const SALE_JUNK = new Set(['full','62k','chua cop','chua coc','chuac op','chua cop','chưa cọc','da cop','đã cọc']);

function normalizeSale(raw) {
  const s = clean(raw);
  const key = s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if (SALE_JUNK.has(key)) return '';
  if (SALE_MAP.has(s.toLowerCase())) return SALE_MAP.get(s.toLowerCase());
  if (SALE_MAP.has(key)) return SALE_MAP.get(key);
  return s;
}

function mapOrder(r) {
  const date = isoDate(r.date || r.order_date);
  if (!date) return null;
  const id = clean(r.id || r.order_id);
  if (!id) return null;
  return {
    id,
    source_sheet:   clean(r.source_sheet || ''),
    source_row:     r.source_row ? Number(r.source_row) : null,
    customer:       clean(r.customer || ''),
    order_date:     date,
    order_time:     clean(r.order_time || r.time || ''),
    flower:         clean(r.flower || ''),
    note:           clean(r.note || ''),
    shipping:       clean(r.shipping || ''),
    address:        clean(r.address || ''),
    phone:          clean(r.phone || ''),
    flower_total:   num(r.flower_total || r.flowerTotal || 0),
    payment:        clean(r.payment || ''),
    sale:           normalizeSale(r.sale || ''),
    status:         (['Chờ bó','Đã bó','Đã giao'].includes(clean(r.status)) ? clean(r.status) : 'Chờ bó'),
    settled:        bool(r.settled),
    ship_fee:       num(r.ship_fee || r.shipFee || 0),
    ship_confirmed: bool(r.ship_confirmed || r.shipConfirmed),
    card:           bool(r.card),
    card_text:      clean(r.card_text || r.cardText || ''),
    banner:         bool(r.banner),
    banner_text:    clean(r.banner_text || r.bannerText || ''),
    charm_fee:      num(r.charm_fee || r.charmFee || 0),
    charm_text:     clean(r.charm_text || r.charmText || ''),
    paper_fee:      num(r.paper_fee || r.paperFee || 0),
    paper_text:     clean(r.paper_text || r.paperText || ''),
    vat:            num(r.vat || 0),
    image_urls:     Array.isArray(r.image_urls || r.imageUrls) ? (r.image_urls ?? r.imageUrls) : [],
    updated_at:     new Date().toISOString(),
  };
}

async function upsertBatch(orders) {
  if (!orders.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal,resolution=merge-duplicates',
    },
    body: JSON.stringify(orders),
  });
  if (!res.ok) throw new Error('DB ' + res.status + ': ' + (await res.text()).slice(0, 300));
}

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-ingest-secret, content-type',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, message: 'POST only' }), { status: 405, headers: cors });

  const secret = req.headers.get('x-ingest-secret') || '';
  if (!INGEST_SECRET || secret !== INGEST_SECRET) {
    return new Response(JSON.stringify({ ok: false, message: 'Unauthorized' }), { status: 401, headers: cors });
  }

  try {
    const body    = await req.json();
    const rawList = Array.isArray(body.orders) ? body.orders : [];
    const mapped  = rawList.map(mapOrder).filter(Boolean);
    for (let i = 0; i < mapped.length; i += 200) {
      await upsertBatch(mapped.slice(i, i + 200));
    }
    return new Response(JSON.stringify({ ok: true, received: rawList.length, processed: mapped.length }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, message: e.message }), { status: 500, headers: cors });
  }
});
