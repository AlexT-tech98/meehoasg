const UI_BUILD = '2026.09.28-supabase-v3';
const PROXY_BUILD = '2026.10.01-v363';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const V362_API = `${SUPABASE_URL}/functions/v1/meehoasg-api-v362`;
const ALLOWED_ORIGINS = [
  'https://ops.meehoasg.com',
  'http://ops.meehoasg.com',
  'https://meehoasg.com',
  'http://meehoasg.com'
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin'
  };
}

Deno.serve(async (request) => {
  const cors = corsHeaders(request.headers.get('origin') || '');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, message: 'Method not allowed', build: UI_BUILD }), { status: 405, headers: cors });

  try {
    const raw = await request.text();
    const upstream = await fetch(V362_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: request.headers.get('authorization') || '',
        apikey: request.headers.get('apikey') || ''
      },
      body: raw
    });

    const text = await upstream.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch (_) { data = { ok: false, message: 'Máy chủ trả dữ liệu không hợp lệ.' }; }

    const perf = data && data._perf && typeof data._perf === 'object' ? data._perf : {};
    const result = {
      ...data,
      build: UI_BUILD,
      proxyBuild: PROXY_BUILD,
      _perf: { ...perf, proxy: 'v363', upstreamProxy: perf.proxy || 'v362' }
    };

    return new Response(JSON.stringify(result), { status: upstream.status, headers: cors });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      message: error?.message || 'Máy chủ gặp lỗi. Vui lòng thử lại.',
      code: 'SERVER_ERROR',
      build: UI_BUILD,
      proxyBuild: PROXY_BUILD
    }), { status: 200, headers: cors });
  }
});
