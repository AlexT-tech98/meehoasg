// MEEHOA: Google Sheet writeback retired. Historical Sheets are preserved.
// The old Apps Script trigger may still call this endpoint; return an empty
// authenticated delta so it does not transfer customer orders.
const BUILD = '2026.10.26-writeback-retired';
const INGEST_SECRET = Deno.env.get('INGEST_SECRET');
const encoder = new TextEncoder();
function sameSecret(provided) {
  const a = encoder.encode(provided || '');
  const b = encoder.encode(INGEST_SECRET || '');
  if (!b.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
Deno.serve(async request => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'POST only' }), { status: 405, headers });
  if (!sameSecret(request.headers.get('x-ingest-secret') || '')) return new Response(JSON.stringify({ ok: false, build: BUILD, message: 'Unauthorized' }), { status: 401, headers });
  return new Response(JSON.stringify({ ok: true, build: BUILD, orders: [], offset: 0, limit: 200, hasMore: false }), { headers });
});
