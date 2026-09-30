// Production server-to-server feed for Supabase -> Google Sheet writeback.
// Apps Script authenticates with INGEST_SECRET; deploy with verify_jwt=false.
const BUILD = '2026.09.30-cutover-feed-v1';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const INGEST_SECRET = Deno.env.get('INGEST_SECRET');
const encoder = new TextEncoder();

function clean(value) { return String(value ?? '').trim(); }
function sameSecret(provided) {
  const a = encoder.encode(provided || ''), b = encoder.encode(INGEST_SECRET || '');
  if (!b.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function fetchOrders(payload) {
  const since = clean(payload.since);
  const until = clean(payload.until);
  const limit = Math.min(200, Math.max(1, Number(payload.limit) || 200));
  const offset = Math.max(0, Number(payload.offset) || 0);
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('select', 'id,customer,phone,order_date,order_time,flower,note,shipping,address,flower_total,payment,sale,status,settled,ship_fee,ship_confirmed,card,card_text,banner,banner_text,charm_fee,charm_text,paper_fee,paper_text,vat,image_urls,source_sheet,source_row,updated_at,created_at');
  url.searchParams.set('order', 'updated_at.asc,id.asc');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (since) url.searchParams.append('updated_at', 'gte.' + since);
  if (until) url.searchParams.append('updated_at', 'lt.' + until);

  const response = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Database ${response.status}: ${text.slice(0, 240)}`);
  const rows = text ? JSON.parse(text) : [];
  return { ok: true, build: BUILD, orders: rows, offset, limit, hasMore: rows.length === limit };
}

Deno.serve(async request => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'POST only' }), { status: 405, headers });
  if (!SUPABASE_URL || !SERVICE_KEY || !INGEST_SECRET) return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'Not configured' }), { status: 503, headers });
  if (!sameSecret(request.headers.get('x-ingest-secret') || '')) return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'Unauthorized' }), { status: 401, headers });
  try {
    const body = await request.json();
    return new Response(JSON.stringify(await fetchOrders(body || {})), { headers });
  } catch (error) {
    console.error('Meehoasg writeback feed failed:', error);
    return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'Writeback feed failed' }), { status: 500, headers });
  }
});
