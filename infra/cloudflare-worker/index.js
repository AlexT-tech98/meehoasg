const SUPABASE_API_LEGACY = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-api';
const SUPABASE_API_CORE = 'https://zxnfhshnavbmvdthrmrd.supabase.co/functions/v1/meehoasg-api-core';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp4bmZoc2huYXZibXZkdGhybXJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0OTc5MDksImV4cCI6MjEwNjA3MzkwOX0.YCi2HBT78iFI5aVJSTqIhesHR_5E6hji6jzpM9X74fU';
const SERVICE_ADMIN_TOKEN = 'ba09a68b99b0b18f2c94cde918e38d15071fafc5d7c86574d484f0638b12b071';

function norm(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, gateway: 'meehoasg-api-gateway', timestamp: new Date().toISOString() }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, message: 'Method Not Allowed' }), {
        status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    let bodyText = '';
    try {
      bodyText = await request.text();
    } catch {
      return new Response(JSON.stringify({ ok: false, message: 'Invalid body' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    let input;
    try {
      input = JSON.parse(bodyText);
    } catch {
      return new Response(JSON.stringify({ ok: false, message: 'JSON syntax error' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const name = input?.name || '';
    const payload = input?.payload || {};

    // SPECIAL INTERCEPTION: getKpi
    if (name === 'getKpi') {
      const callerToken = String(payload?.token || '').trim();
      const month = String(payload?.month || '').trim();

      // 1. Authenticate caller with Supabase
      const userRes = await fetch(SUPABASE_API_LEGACY, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          name: 'getCurrentUserAndBootstrap',
          payload: { token: callerToken }
        })
      });

      const userData = await userRes.json();
      if (!userData || !userData.ok || !userData.user) {
        return new Response(JSON.stringify({ ok: false, message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }

      const callerUser = userData.user;
      const callerUsername = norm(callerUser.username);
      const isPrivileged = callerUser.role === 'ADMIN' || callerUsername === 'cmui';

      // 2. Query full KPI dataset from Supabase core using trusted service token
      const kpiRes = await fetch(SUPABASE_API_CORE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          name: 'getKpi',
          payload: { token: SERVICE_ADMIN_TOKEN, month }
        })
      });

      const kpiData = await kpiRes.json();
      if (!kpiData || !kpiData.ok) {
        return new Response(JSON.stringify(kpiData || { ok: false, message: 'Không thể tính KPI.' }), {
          status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }

      // 3. Strict Server-Level Security Enforcement:
      // If user is neither ADMIN nor cmui, exclude C Mụi completely
      const filteredItems = (kpiData.items || []).filter(item => {
        const itemUser = norm(item.username);
        const itemSale = norm(item.sale);
        const isCmuiCard = itemUser === 'cmui' || itemSale === 'c mui' || itemSale === 'cmui';
        if (isCmuiCard && !isPrivileged) return false;
        return true;
      });

      const result = {
        ...kpiData,
        items: filteredItems,
        _gateway: {
          enforced: true,
          callerRole: callerUser.role,
          privileged: isPrivileged
        }
      };

      return new Response(JSON.stringify(result), {
        status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // ALL OTHER ACTIONS: transparent proxy to Supabase
    const targetUrl = (name === 'getSettlementQueue' || name === 'reviewSettlementsBulk') ? SUPABASE_API_CORE : SUPABASE_API_LEGACY;

    const proxyRes = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: bodyText
    });

    const proxyData = await proxyRes.text();
    return new Response(proxyData, {
      status: proxyRes.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    });
  }
};
