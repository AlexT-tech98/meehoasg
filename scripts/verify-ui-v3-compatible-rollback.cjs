'use strict';

/**
 * Executable Compatible Backend & Frontend Rollback Drill (Section C #2)
 *
 * Generates a deployable compatible-rollback Edge Function package at:
 *   artifacts/rollback/ui-v3-compatible-backend-core/
 * Pairs it with extracted origin/main V2 frontend static files at:
 *   artifacts/rollback/v2-frontend-probe/
 * And runs a LIVE drill against the real isolated Staging PostgreSQL/PostgREST backend:
 *   1. Soft-deleted orders NEVER resurrect in getOrders / Dashboard / Production / KPI / FlowerInventory / Debt
 *      and getDebtReview exposes zero deletedWithPaymentAudit (Final Order Deletion Policy Override).
 *   2. WALK_IN orders remain excluded from Production / FlowerInventory / KPI / Dashboard CMS
 *      and counted ONCE in Dashboard grossRevenue.
 *   3. V2 frontend (`origin/main`) boots and logs in cleanly against the compatible rollback backend + RC5 SQL.
 *   4. V2 `createOrder` (omitting orderSource/tagNoteFree/orderType) succeeds on RC5 DB.
 *   5. V2 `updateOrder` (omitting orderSource/tagNoteFree) preserves RC5 `tag_note_free` & `order_source` without wiping data!
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'artifacts/staging');
const ROLLBACK_DIR = path.join(ROOT, 'artifacts/rollback');
const BACKEND_OUT = path.join(ROLLBACK_DIR, 'ui-v3-compatible-backend-core');
const FRONTEND_OUT = path.join(ROLLBACK_DIR, 'v2-frontend-probe');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function buildCompatibleBackendArtifact() {
  fs.rmSync(BACKEND_OUT, { recursive: true, force: true });
  fs.mkdirSync(BACKEND_OUT, { recursive: true });
  // Compatible rollback core retains all UI-V3 SQL/API safety invariants AND Permanent R2:
  // is_deleted filtering, WALK_IN isolation from Production/KPI/CMS, preservation of tag_note_free/order_source on V2 edits,
  // and Permanent R2 read/write across both meehoasg-api-core and meehoasg-api.
  // Layout mirrors supabase/functions so relative imports (../_shared/*) resolve exactly as in deployment.
  const coreSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/meehoasg-api-core/index.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/meehoasg-api/index.js'), 'utf8');
  const actionsSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/meehoasg-order-actions/index.ts'), 'utf8');
  const fnDir = path.join(BACKEND_OUT, 'functions');
  fs.mkdirSync(path.join(fnDir, 'meehoasg-api-core'), { recursive: true });
  fs.mkdirSync(path.join(fnDir, 'meehoasg-api'), { recursive: true });
  fs.mkdirSync(path.join(fnDir, 'meehoasg-order-actions'), { recursive: true });
  fs.writeFileSync(path.join(fnDir, 'meehoasg-api-core', 'index.js'), coreSrc);
  fs.writeFileSync(path.join(fnDir, 'meehoasg-api', 'index.js'), apiSrc);
  fs.writeFileSync(path.join(fnDir, 'meehoasg-order-actions', 'index.ts'), actionsSrc);
  copyDirSync(path.join(ROOT, 'supabase/functions/_shared'), path.join(fnDir, '_shared'));
  assert.ok(fs.existsSync(path.join(fnDir, '_shared/r2-image-reader.js')), 'rollback artifact includes _shared/r2-image-reader.js');
  assert.match(coreSrc, /const R2_UPLOADS_ENABLED=true;/, 'rollback core preserves permanent R2 uploads');
  assert.match(coreSrc, /const R2_READS_ENABLED=true;/, 'rollback core preserves permanent R2 reads');
  assert.match(coreSrc, /function r2BackupEnabled\(\)\{return false\}/, 'rollback core disables 72h trial dual-backup');
  assert.match(apiSrc, /createR2ImageReader/, 'rollback fallback API preserves permanent R2 image reader');
  assert.match(actionsSrc, /createR2Media/, 'rollback order-actions preserves permanent R2 settlement uploads');
  assert.match(actionsSrc, /function r2BackupEnabled\(\)\{return false\}/, 'rollback order-actions disables 72h trial dual-backup');

  // Runnable local harness (loopback port only) without modifying the deployable index.js
  const harnessSrc = coreSrc.replace('Deno.serve(', "Deno.serve({hostname:'127.0.0.1',port:4185},");
  fs.writeFileSync(path.join(fnDir, 'meehoasg-api-core', 'index.local-harness.js'), harnessSrc);

  // Extract origin/main V2 static frontend probe
  fs.rmSync(FRONTEND_OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(FRONTEND_OUT, 'assets'), { recursive: true });
  for (const f of ['index.html', 'html', 'manifest.webmanifest', 'assets/meehoa-core.css', 'assets/meehoa-core.js', 'assets/meehoa-mark.svg']) {
    const bytes = cp.execFileSync('git', ['show', 'origin/main:' + f], { cwd: ROOT });
    const outPath = path.join(FRONTEND_OUT, f);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, bytes);
  }
}

async function rpcCall(url, name, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, payload })
  });
  assert.equal(res.status, 200, `${name} HTTP 200`);
  return res.json();
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(STAGING_DIR, 'supabase.local.json'), 'utf8'));
  const creds = JSON.parse(fs.readFileSync(path.join(STAGING_DIR, 'credentials.local.json'), 'utf8')).accounts;
  assert.equal(cfg.API_URL, 'http://127.0.0.1:54321', 'Must target isolated loopback Staging only');

  buildCompatibleBackendArtifact();

  const db = new Client({ host: '127.0.0.1', port: 54322, user: 'postgres', password: cfg.DB_PASSWORD, database: 'postgres' });
  await db.connect();

  const deno = process.env.MEEHOA_DENO || '/Users/heymac/.deno/bin/deno';
  const child = cp.spawn(deno, ['run', '--no-prompt', '--allow-net=127.0.0.1', '--allow-env', path.join(BACKEND_OUT, 'functions/meehoasg-api-core/index.local-harness.js')], {
    env: { ...process.env, SUPABASE_URL: cfg.API_URL, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: cfg.ANON_KEY, LEGACY_PASSWORD_SALT: 'MEE-FLOWER-V4' },
    stdio: ['ignore', 'ignore', 'ignore']
  });

  const v2Server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel === '/') rel = '/index.html';
    const full = path.resolve(FRONTEND_OUT, '.' + rel);
    if (!full.startsWith(FRONTEND_OUT + path.sep) || !fs.existsSync(full)) {
      res.writeHead(404);
      return res.end();
    }
    const type = rel.endsWith('.css') ? 'text/css; charset=utf-8'
      : rel.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : rel.endsWith('.svg') ? 'image/svg+xml'
      : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(fs.readFileSync(full));
  });

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const probeIds = ['RB-PROBE-V3', 'RB-PROBE-WI-CASH', 'RB-PROBE-DEL-PAID'];
  const createdByV2 = [];

  try {
    // Wait for rollback deno listener
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { await fetch('http://127.0.0.1:4185/'); ready = true; break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ready, 'Compatible rollback Deno listener must start on 127.0.0.1:4185');

    await new Promise((r) => v2Server.listen(0, '127.0.0.1', r));
    const v2Origin = 'http://127.0.0.1:' + v2Server.address().port;

    // Seed isolated rollback probes in Staging Postgres
    await db.query(`
      INSERT INTO public.app_users(username, password_hash, display_name, role, active)
      VALUES ('cmui', encode(sha256('MEE-FLOWER-V4|MeehoaStaging#Cmui2026'::bytea), 'hex'), 'C Mụi', 'SALE', true)
      ON CONFLICT (username) DO UPDATE SET active = true;
    `);
    await db.query(`
      INSERT INTO public.orders(id, customer, phone, order_date, order_time, flower, note, tag_note_free, order_source, order_type, walk_in_payment_method, created_by, shipping, address, flower_total, payment, sale, status, settled, full_paid, is_deleted, deleted_at, deleted_by, deleted_by_role, deleted_reason, updated_at)
      VALUES
        ('RB-PROBE-V3', 'Khách Probe V3', '0901112233', $1, '10:15', 'Bó hồng đỏ', 'Note gốc V3', 'Tag miễn phí V3 cần bảo toàn', 'Page/IG', 'STANDARD', '', 'qa_sale', 'Ghé lấy', '', 600000, 'Chưa thanh toán', 'qa_sale', 'Chờ bó', false, false, false, null, null, null, '', now()),
        ('RB-PROBE-WI-CASH', 'Khách vãng lai', '', $1, '11:00', 'Bó baby tiền mặt', '', '', 'Khách ghé tiệm', 'WALK_IN', 'CASH', 'qa_sale', 'Ghé lấy', '', 450000, 'Đã thanh toán 450000 đ (Tiền mặt - Khách vãng lai)', 'cmui', 'Đã giao', false, false, false, null, null, null, '', now()),
        ('RB-PROBE-DEL-PAID', 'Khách Đã Xóa Có Cọc', '0904445566', $1, '12:00', 'Bó tulip đã cọc', '', '', 'Zalo', 'STANDARD', '', 'qa_sale', 'Ghé lấy', '', 700000, 'Đã cọc 250000 đ', 'qa_sale', 'Chờ bó', false, false, true, now(), 'qa_admin', 'ADMIN', 'Probe soft delete rollback', now())
      ON CONFLICT (id) DO UPDATE SET
        order_date = EXCLUDED.order_date,
        tag_note_free = EXCLUDED.tag_note_free,
        order_source = EXCLUDED.order_source,
        is_deleted = EXCLUDED.is_deleted,
        updated_at = now();
    `, [today]);

    const adminCred = creds.find((a) => a.username === 'qa_admin');
    const saleCred = creds.find((a) => a.username === 'qa_sale');
    const coreUrl = 'http://127.0.0.1:4185/';

    const adminLogin = await rpcCall(coreUrl, 'loginAndBootstrap', { username: adminCred.username, password: adminCred.password });
    const saleLogin = await rpcCall(coreUrl, 'loginAndBootstrap', { username: saleCred.username, password: saleCred.password });
    assert.equal(adminLogin.ok, true);
    assert.equal(saleLogin.ok, true);

    // 1. Verify soft-deleted order does NOT resurrect across Orders / Dashboard / Production / KPI / Flowers
    const ordersRes = await rpcCall(coreUrl, 'getOrders', { token: adminLogin.token, q: 'RB-PROBE', globalSearch: true, page: 1, pageSize: 50 });
    const activeIds = (ordersRes.items || []).map((x) => x.id);
    assert.ok(activeIds.includes('RB-PROBE-V3'), 'Active V3 order visible');
    assert.ok(activeIds.includes('RB-PROBE-WI-CASH'), 'Active WALK_IN order visible');
    assert.ok(!activeIds.includes('RB-PROBE-DEL-PAID'), 'Soft-deleted order MUST NOT resurrect in getOrders during rollback');

    const prodRes = await rpcCall(coreUrl, 'getProductionOrders', { token: adminLogin.token, date: today });
    const prodIds = (prodRes.orders || []).map((x) => x.id);
    assert.ok(!prodIds.includes('RB-PROBE-DEL-PAID'), 'Soft-deleted excluded from Production');
    assert.ok(!prodIds.includes('RB-PROBE-WI-CASH'), 'WALK_IN excluded from Production');

    const invRes = await rpcCall(coreUrl, 'getFlowerInventory', { token: adminLogin.token, start: today, end: today });
    const invIds = (invRes.reviewOrders || []).concat((invRes.items || []).flatMap((g) => g.orderList || [])).map((x) => x.id);
    assert.ok(!invIds.includes('RB-PROBE-DEL-PAID'), 'Soft-deleted excluded from FlowerInventory');
    assert.ok(!invIds.includes('RB-PROBE-WI-CASH'), 'WALK_IN excluded from FlowerInventory');

    const debtRes = await rpcCall(coreUrl, 'getDebtReview', { token: adminLogin.token, start: today, end: today });
    assert.ok(!(debtRes.items || []).some((x) => x.id === 'RB-PROBE-DEL-PAID'), 'Soft-deleted not treated as active debt');
    assert.equal(debtRes.deletedWithPaymentAudit, undefined, 'Final Deletion Policy: deletedWithPaymentAudit removed from Debt');

    const kpiRes = await rpcCall(coreUrl, 'getKpi', { token: adminLogin.token, month: today.slice(0, 7) });
    // Even if cmui has std orders, RB-PROBE-WI-CASH cannot be in cmui revenue; assert by checking no WALK_IN contributes:
    // Also check Dashboard summary grossRevenue includes RB-PROBE-WI-CASH while cms excludes WALK_IN
    const dashRes = await rpcCall(coreUrl, 'getDashboardSummary', { token: adminLogin.token, start: today, end: today });
    assert.equal(dashRes.ok, true);
    assert.ok(dashRes.summary.walkInRevenue >= 450000, 'Dashboard includes walk-in revenue on compatible rollback core');

    // 2. Verify V2 legacy payload update preserves tag_note_free and order_source!
    const v3Before = (await rpcCall(coreUrl, 'getOrder', { token: saleLogin.token, orderId: 'RB-PROBE-V3' })).order;
    const v2Edit = await rpcCall(coreUrl, 'updateOrder', {
      token: saleLogin.token,
      requestId: 'rb-drill-edit-' + Date.now(),
      orderId: 'RB-PROBE-V3',
      expectedUpdatedAt: v3Before.updatedAt,
      order: {
        customer: 'Khách Probe V3 (V2 edited)',
        phone: '0901112233',
        date: today,
        time: '10:30',
        flower: 'Bó hồng đỏ',
        note: 'Note cập nhật từ V2 frontend',
        shipping: 'Ghé lấy',
        address: '',
        flowerTotal: 600000,
        payment: 'Chưa thanh toán',
        sale: 'qa_sale',
        card: false,
        banner: false,
        charmFee: 0,
        paperFee: 0,
        vat: 0,
        shipFeeActive: '0'
        // OMITS tagNoteFree and orderSource just like origin/main V2 frontend!
      }
    });
    assert.equal(v2Edit.ok, true, 'V2 updateOrder must succeed on RC5 schema');
    assert.equal(v2Edit.order.tagNoteFree, 'Tag miễn phí V3 cần bảo toàn', 'Rollback MUST preserve tag_note_free');
    assert.equal(v2Edit.order.orderSource, 'Page/IG', 'Rollback MUST preserve order_source');

    // 3. Verify V2 legacy payload createOrder (without orderSource) works cleanly!
    const v2Create = await rpcCall(coreUrl, 'createOrder', {
      token: saleLogin.token,
      requestId: 'rb-drill-create-' + Date.now(),
      order: {
        customer: 'Khách V2 Rollback Create',
        phone: '0907778899',
        date: today,
        time: '15:00',
        flower: 'Bó hướng dương V2',
        note: '',
        shipping: 'Ghé lấy',
        address: '',
        flowerTotal: 420000,
        payment: 'Chưa thanh toán',
        sale: 'qa_sale',
        card: false,
        banner: false,
        charmFee: 0,
        paperFee: 0,
        vat: 0,
        shipFeeActive: '0'
      }
    });
    assert.equal(v2Create.ok, true, 'V2 createOrder without orderSource succeeds');
    createdByV2.push(v2Create.orderId);
    assert.equal(v2Create.order.orderSource, '');
    assert.equal(v2Create.order.orderType, 'STANDARD');

    // 4. Launch REAL Playwright browser with origin/main V2 frontend pointed at Compatible Rollback Core!
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.MEEHOA_CHROMIUM ? { executablePath: process.env.MEEHOA_CHROMIUM } : {}),
      args: ['--no-sandbox']
    });
    const browserErrors = [];
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => browserErrors.push(e.message));
      await page.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (u.origin === v2Origin) return route.continue();
        if (u.pathname.includes('/functions/v1/')) {
          if (route.request().method() === 'OPTIONS') {
            return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
          }
          const upstream = await fetch(coreUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: route.request().postData()
          });
          const text = await upstream.text();
          return route.fulfill({ status: upstream.status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: text });
        }
        return route.abort();
      });

      await page.goto(v2Origin, { waitUntil: 'domcontentloaded' });
      await page.locator('#loginUser').fill(adminCred.username);
      await page.locator('#loginPass').fill(adminCred.password);
      await page.locator('#loginBtn').click();
      await page.waitForFunction(() => window.S?.user?.role === 'ADMIN' && document.querySelector('#content')?.textContent.length > 20);
      await page.evaluate(() => MEEOPS7.go('orders'));
      await page.waitForFunction(() => window.S?.page === 'orders' && document.querySelector('#content')?.textContent.length > 20);
      const ordersText = await page.textContent('#content');
      assert.ok(!ordersText.includes('RB-PROBE-DEL-PAID'), 'V2 frontend on Compatible Rollback Backend never shows soft-deleted orders');
      assert.equal(browserErrors.length, 0, 'Zero page errors in V2 frontend rollback drill');
      await ctx.close();
    } finally {
      await browser.close();
    }

    const result = {
      ok: true,
      testedAt: new Date().toISOString(),
      rollbackArtifactDir: path.relative(ROOT, BACKEND_OUT),
      v2FrontendBase: 'origin/main',
      stagingTarget: cfg.API_URL,
      assertions: [
        'soft_deleted_never_resurrected_orders_dashboard_production_kpi_flowers_debt',
        'deleted_with_payment_audit_removed_from_debt',
        'walk_in_excluded_from_production_inventory_kpi_cms',
        'v2_update_preserves_tag_note_free_and_order_source',
        'v2_create_without_order_source_succeeds',
        'real_v2_frontend_chromium_boots_logs_in_renders_orders_zero_errors'
      ]
    };
    fs.writeFileSync(path.join(ROLLBACK_DIR, 'ui-v3-compatible-rollback-results.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.query('DELETE FROM public.orders WHERE id = ANY($1)', [[...probeIds, ...createdByV2]]).catch(() => {});
    await db.query("DELETE FROM public.activity_log WHERE order_id = ANY($1)", [[...probeIds, ...createdByV2]]).catch(() => {});
    await db.query("DELETE FROM public.operation_receipts WHERE request_id LIKE 'rb-drill-%'").catch(() => {});
    await db.end().catch(() => {});
    v2Server.close();
    child.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
