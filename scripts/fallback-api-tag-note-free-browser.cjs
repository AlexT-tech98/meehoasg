'use strict';

/**
 * MEEHOA OPS V3.1 — Isolated Core-Unavailable Browser Acceptance for Fallback API (`meehoasg-api`)
 *
 * Simulates `meehoasg-api-core` returning HTTP 503 while serving all UI operations from the real
 * `supabase/functions/meehoasg-api/index.js` handler + `_shared/operations.js` + isolated PGlite SQL.
 * Verifies Drawer, Create/Edit Form, Copy Order, Production cards, and pre-existing migrated Legacy Notes.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts/browser');
const OUT_FILE = path.join(OUT_DIR, 'fallback-api-tag-note-free.json');
const API_FALLBACK_PATH = path.join(ROOT, 'supabase/functions/meehoasg-api/index.js');
const BACKFILL_SQL_PATH = path.join(ROOT, 'scripts/legacy-note-to-tag-note-free-backfill.sql');
const SUPABASE_HOST = 'zxnfhshnavbmvdthrmrd.supabase.co';
const LEGACY_PASS_SALT = 'MEE-FLOWER-V4';
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;

function vnToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function createPgliteRestFetch(pg) {
  const assertIdent = (name) => {
    if (!SAFE_IDENT.test(name)) throw new Error(`Unsafe identifier: ${name}`);
    return name;
  };

  function applyFilters(searchParams, values) {
    const clauses = [];
    for (const [k, v] of searchParams.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
      if (k === 'and') {
        const inner = v.replace(/^\(|\)$/g, '');
        for (const part of inner.split(',')) {
          const m = part.match(/^([a-z0-9_]+)\.(gte|lte|eq)\.(.+)$/i);
          if (!m) throw new Error(`Unsupported and filter: ${part}`);
          const col = assertIdent(m[1]);
          const op = m[2] === 'gte' ? '>=' : m[2] === 'lte' ? '<=' : '=';
          values.push(m[3]);
          clauses.push(`${col} ${op} $${values.length}`);
        }
        continue;
      }
      const col = assertIdent(k);
      if (v === 'is.false') clauses.push(`${col} is false`);
      else if (v === 'is.true') clauses.push(`${col} is true`);
      else if (v.startsWith('eq.')) {
        values.push(v.slice(3));
        clauses.push(`${col} = $${values.length}`);
      } else if (v.startsWith('in.(') && v.endsWith(')')) {
        const list = v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean);
        if (!list.length) clauses.push('false');
        else {
          values.push(list);
          clauses.push(`${col} = any($${values.length}::text[])`);
        }
      } else {
        throw new Error(`Unsupported PostgREST filter ${k}=${v}`);
      }
    }
    return clauses.length ? `where ${clauses.join(' and ')}` : '';
  }

  return async function pgliteFetch(rawUrl, opts = {}) {
    const url = new URL(String(rawUrl));
    const method = String(opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const prefix = '/rest/v1/';
    if (!url.pathname.startsWith(prefix)) throw new Error(`Unexpected fetch URL: ${rawUrl}`);
    const target = url.pathname.slice(prefix.length);

    if (target === 'rpc/mee_ops_lookup') {
      const r = await pg.query(
        'select public.mee_ops_lookup($1, $2, $3, $4) as res',
        [body.p_actor, body.p_request_id, body.p_action, body.p_fingerprint]
      );
      return { ok: true, status: 200, text: async () => JSON.stringify(r.rows[0]?.res ?? null) };
    }
    if (target === 'rpc/mee_ops_mutate') {
      const r = await pg.query(
        'select public.mee_ops_mutate($1, $2, $3, $4, $5::jsonb) as res',
        [body.p_actor, body.p_request_id, body.p_action, body.p_fingerprint, JSON.stringify(body.p_input)]
      );
      return { ok: true, status: 200, text: async () => JSON.stringify(r.rows[0]?.res ?? null) };
    }

    const table = assertIdent(target);
    if (method === 'GET') {
      const values = [];
      const where = applyFilters(url.searchParams, values);
      const orderRaw = url.searchParams.get('order');
      const orderSql = orderRaw
        ? 'order by ' + orderRaw.split(',').map((p) => {
            const [c, dir = 'asc'] = p.split('.');
            return `${assertIdent(c)} ${dir.toLowerCase() === 'desc' ? 'desc' : 'asc'}`;
          }).join(', ')
        : '';
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 1000)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const res = await pg.query(
        `select row_to_json(t) as r from (select * from public.${table} ${where} ${orderSql} limit ${limit} offset ${offset}) t`,
        values
      );
      return { ok: true, status: 200, text: async () => JSON.stringify(res.rows.map((x) => x.r)) };
    }
    if (method === 'DELETE') {
      const values = [];
      const where = applyFilters(url.searchParams, values);
      const res = await pg.query(
        `with mut as (delete from public.${table} ${where} returning *) select row_to_json(mut) as r from mut`,
        values
      );
      return { ok: true, status: 200, text: async () => JSON.stringify(res.rows.map((x) => x.r)) };
    }
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      const inserted = [];
      for (const row of rows) {
        const cols = Object.keys(row).map(assertIdent);
        const vals = Object.values(row);
        const params = cols.map((_, idx) => `$${idx + 1}`).join(', ');
        const conflict = url.searchParams.get('on_conflict');
        const conflictSql = conflict
          ? `on conflict (${assertIdent(conflict)}) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`
          : '';
        const res = await pg.query(
          `with mut as (insert into public.${table} (${cols.join(', ')}) values (${params}) ${conflictSql} returning *) select row_to_json(mut) as r from mut`,
          vals
        );
        inserted.push(...res.rows.map((x) => x.r));
      }
      return { ok: true, status: 201, text: async () => JSON.stringify(inserted) };
    }
    if (method === 'PATCH') {
      const values = [];
      const sets = Object.entries(body).map(([c, v]) => {
        values.push(v);
        return `${assertIdent(c)} = $${values.length}`;
      });
      const where = applyFilters(url.searchParams, values);
      const res = await pg.query(
        `with mut as (update public.${table} set ${sets.join(', ')} ${where} returning *) select row_to_json(mut) as r from mut`,
        values
      );
      return { ok: true, status: 200, text: async () => JSON.stringify(res.rows.map((x) => x.r)) };
    }
    throw new Error(`Unsupported method ${method} on ${table}`);
  };
}

function bootFallbackHandler(pg, createOperationService) {
  const source = fs.readFileSync(API_FALLBACK_PATH, 'utf8').replace(/^import .*\n/gm, '');
  let serveHandler = null;
  const ctx = {
    console,
    TextEncoder,
    Uint8Array,
    URL,
    Date,
    Intl,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    Error,
    RegExp,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    crypto: webcrypto,
    fetch: createPgliteRestFetch(pg),
    Response: class MockResponse {
      constructor(body, init = {}) {
        this.body = body;
        this.status = init.status || 200;
        this.headers = init.headers || {};
      }
      async json() { return JSON.parse(this.body); }
      async text() { return String(this.body ?? ''); }
    },
    createOperationService,
    createR2ImageReader: () => async (v) => v,
    createR2Media: () => ({
      key: (kind, p) => `${kind === 'bill' ? 'settlement-bills' : 'order-images'}/${p}`,
      reference: (k) => `r2://meehoasg-website-media/${k}`,
      signedUrl: async () => `https://${SUPABASE_HOST}/qa-unused`,
      verifyUpload: async () => 0,
      discard: async () => {},
      parseReference: () => null,
    }),
    createOperationStorage: () => ({ uploadImages: async () => [], discard: async () => {} }),
    Deno: {
      env: { get: (k) => ({ SUPABASE_URL: `https://${SUPABASE_HOST}`, SUPABASE_SERVICE_ROLE_KEY: 'svc-local-qa', LEGACY_PASSWORD_SALT: LEGACY_PASS_SALT, R2_ACCESS_KEY_ID: 'qa-local', R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_SECRET_ACCESS_KEY: 'qa-secret', R2_MEDIA_BUCKET: 'meehoasg-website-media' }[k] || '') },
      serve: (fn) => { serveHandler = fn; },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return serveHandler;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { createOperationService } = await import('../supabase/functions/_shared/operations.js');
  const today = vnToday();

  let pg = null;
  let server = null;
  let browser = null;

  try {
    pg = new PGlite();
    await pg.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create schema if not exists storage;
      create table if not exists storage.buckets (
        id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
      );
    `);
    await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
    const migrationDir = path.join(ROOT, 'supabase/migrations');
    for (const file of fs.readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort()) {
      await pg.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
    }
    const passHash = sha256Hex(`${LEGACY_PASS_SALT}|fallback-admin-pass`);
    await pg.query(
      `insert into public.app_users (username, password_hash, display_name, role, active) values
        ('admin', $1, 'QA Admin', 'ADMIN', true),
        ('sale1', $1, 'Sale Một', 'SALE', true)
       on conflict (username) do nothing`,
      [passHash]
    );

    await pg.query(
      `insert into public.orders (
        id, order_date, order_time, customer, phone, flower, note, tag_note_free, order_source, order_type,
        shipping, address, flower_total, payment, sale, status, settled, full_paid,
        is_deleted, delete_after_sheet_sync, created_at, updated_at
      ) values
      ('MEE-FB-LEG-1', $1, '09:30', 'Khách Legacy Note', '0902223344', 'Bó hồng dâu', $2, '', 'Page/IG', 'STANDARD', 'Ghé lấy', '', 680000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, false, false, '2026-10-20T05:00:00Z', '2026-10-20T05:00:00Z'),
      ('MEE-FB-MIX-1', $1, '14:15', 'Khách Mixed Note', '0903334455', 'Giỏ hướng dương', 'Giao đúng giờ giúp em', 'Mừng tốt nghiệp rực rỡ', 'Zalo', 'STANDARD', 'Shop book ship', '88 Hai Bà Trưng, Q1', 920000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, false, false, now(), now())`,
      [today, "Happy Women's Day, Love"]
    );
    await pg.exec(fs.readFileSync(BACKFILL_SQL_PATH, 'utf8'));

    const serveHandler = bootFallbackHandler(pg, createOperationService);
    const callFallbackHttp = async (name, payload) => {
      const resp = await serveHandler({
        method: 'POST',
        headers: { get: (k) => ({ origin: 'https://ops.meehoasg.com', 'content-length': '256' }[k.toLowerCase()] || null) },
        json: async () => ({ name, payload }),
      });
      return resp.json();
    };

    server = http.createServer((req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = pathname === '/' ? '/index.html' : pathname;
        const full = path.resolve(ROOT, '.' + file);
        if (!full.startsWith(ROOT + path.sep)) throw new Error('Unsafe path');
        let body = fs.readFileSync(full);
        if (file === '/index.html') {
          // Simulates isolated emergency Core-unavailable fallback mode targeting `meehoasg-api`.
          body = Buffer.from(
            body.toString('utf8').replace(
              `var API_CORE='https://${SUPABASE_HOST}/functions/v1/meehoasg-api-core';`,
              `var API_CORE='https://${SUPABASE_HOST}/functions/v1/meehoasg-api';`
            )
          );
        }
        const type = file.endsWith('.css') ? 'text/css'
          : file.endsWith('.js') ? 'text/javascript'
            : file.endsWith('.svg') ? 'image/svg+xml'
              : file.endsWith('.webmanifest') ? 'application/manifest+json'
                : 'text/html';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const selected = process.env.MEEHOA_CHROMIUM;
    browser = await chromium.launch({
      headless: true,
      ...(selected && selected !== 'bundled' ? { executablePath: selected } : {}),
      args: ['--no-sandbox'],
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const coreProbeStatuses = [];
    const fallbackApiCalls = [];
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.addInitScript(() => {
      window.__copiedTexts = [];
      const origExec = typeof document.execCommand === 'function' ? document.execCommand.bind(document) : null;
      document.execCommand = function (cmd, ui, val) {
        if (String(cmd).toLowerCase() === 'copy') {
          const el = document.activeElement;
          const text = el && typeof el.value === 'string' ? el.value : '';
          if (text) window.__copiedTexts.push(text);
          return true;
        }
        return origExec ? origExec(cmd, ui, val) : false;
      };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text) => {
          window.__copiedTexts.push(String(text));
          try { await origWrite(text); } catch (_) {}
        };
      }
    });

    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin === origin) return route.continue();

      if (url.hostname === SUPABASE_HOST && url.pathname === '/functions/v1/meehoasg-api-core') {
        coreProbeStatuses.push(503);
        return route.fulfill({
          status: 503,
          headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
          body: JSON.stringify({ ok: false, code: 'CORE_UNAVAILABLE', message: 'Core API unavailable' }),
        });
      }

      if (url.hostname === SUPABASE_HOST && url.pathname === '/functions/v1/meehoasg-api') {
        if (req.method() === 'OPTIONS') {
          return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
        }
        const { name, payload = {} } = req.postDataJSON();
        fallbackApiCalls.push(name);
        const result = await callFallbackHttp(name, payload);
        return route.fulfill({
          status: 200,
          headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
          body: JSON.stringify(result),
        });
      }

      return route.abort();
    });

    await page.goto(origin);

    // 1. Confirm Core API returns HTTP 503 while Fallback API handles all traffic
    const probeStatus = await page.evaluate(async (host) => {
      const r = await fetch(`https://${host}/functions/v1/meehoasg-api-core`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'getOrders', payload: {} }),
      });
      return r.status;
    }, SUPABASE_HOST);
    assert.equal(probeStatus, 503);
    assert.deepEqual(coreProbeStatuses, [503]);

    // 2. Authenticate via Fallback API
    await page.locator('#loginUser').fill('admin');
    await page.locator('#loginPass').fill('fallback-admin-pass');
    await page.locator('#loginBtn').click();
    await page.waitForFunction(() => window.S?.user && document.querySelector('#content')?.textContent.length > 30);
    assert.ok(fallbackApiCalls.includes('loginAndBootstrap'));

    // 3. Drawer & Copy on migrated Legacy Note order (tagNoteFree shown once, cleared note not duplicated)
    await page.evaluate(() => MEEOPS7.go('orders'));
    await page.waitForFunction(() => S.page === 'orders' && document.querySelector('#content')?.textContent.includes('Khách Legacy Note'));
    await page.evaluate(() => MEEOPS7.openDrawer('MEE-FB-LEG-1'));
    await page.locator('#overlay .mee3-note-block.is-tag-free').waitFor();
    assert.equal((await page.locator('#overlay .mee3-note-block.is-tag-free .mee3-note-text').innerText()).trim(), "Happy Women's Day, Love");
    assert.equal(await page.locator('#overlay .mee3-note-block.mee-detail-note').count(), 0);

    await page.locator('#overlay').getByRole('button', { name: 'Copy thông tin đơn hàng' }).click();
    await page.waitForFunction(() => window.__copiedTexts.length > 0);
    const legCopy = await page.evaluate(() => window.__copiedTexts.at(-1) || '');
    assert.match(legCopy, /Tag note free: Happy Women's Day, Love/);
    assert.doesNotMatch(legCopy, /^Note:/m);
    await page.evaluate(() => MEEOPS7.closeOverlay());

    // 4. Drawer on order with BOTH Lưu ý đơn hàng + Tag note free
    await page.evaluate(() => MEEOPS7.openDrawer('MEE-FB-MIX-1'));
    await page.locator('#overlay .mee3-note-block.is-tag-free').waitFor();
    assert.equal((await page.locator('#overlay .mee3-note-block.mee-detail-note .mee3-note-text').innerText()).trim(), 'Giao đúng giờ giúp em');
    assert.equal((await page.locator('#overlay .mee3-note-block.is-tag-free .mee3-note-text').innerText()).trim(), 'Mừng tốt nghiệp rực rỡ');
    await page.evaluate(() => MEEOPS7.closeOverlay());

    // 5. Edit Form pre-fills Tag note free & saves cleanly through Fallback API
    await page.evaluate(() => MEEOPS7.openOrderForm('MEE-FB-LEG-1'));
    await page.locator('#orderForm textarea[name="tagNoteFree"]').waitFor();
    assert.equal(await page.locator('#orderForm textarea[name="tagNoteFree"]').inputValue(), "Happy Women's Day, Love");
    assert.equal(await page.locator('#orderForm textarea[name="note"]').inputValue(), '');
    await page.locator('#orderForm textarea[name="tagNoteFree"]').fill("Happy Women's Day, Love\nKý tên: Gia đình");
    await page.locator('#orderSubmit').click();
    await page.waitForFunction(() => !document.querySelector('#orderForm'));

    const editedDb = await pg.query("select note, tag_note_free from public.orders where id = 'MEE-FB-LEG-1'");
    assert.equal(editedDb.rows[0].note, '');
    assert.equal(editedDb.rows[0].tag_note_free, "Happy Women's Day, Love\nKý tên: Gia đình");

    // 6. Create Form with BOTH Note and Tag note free via Fallback API -> Copy preview & DB persist
    await page.evaluate(() => MEEOPS7.openOrderForm());
    await page.locator('#orderForm select#orderSourceSelect').selectOption('Zalo');
    await page.locator('#orderForm [name="customer"]').fill('Khách Tạo Mới Fallback');
    await page.locator('#orderForm [name="flower"]').fill('Bó mẫu đơn hồng 10 cành');
    await page.locator('#orderForm [name="note"]').fill('Gói giấy lụa kem');
    await page.locator('#orderForm [name="tagNoteFree"]').fill('Happy Birthday Chị Hai');
    await page.locator('#orderForm input[name="date"]').fill(today);
    await page.locator('#orderForm input[name="time"]').fill('17:30');
    await page.locator('#orderForm input[name="flowerTotal"]').fill('850000');
    await page.locator('#orderForm #orderSale option[value="Sale Một"]').waitFor({ state: 'attached' });
    await page.locator('#orderForm #orderSale').selectOption('Sale Một');
    await page.locator('#orderSubmit').click();

    await page.locator('#copyCreated').waitFor();
    const createdPreview = await page.locator('#overlay pre').innerText();
    assert.match(createdPreview, /Note: Gói giấy lụa kem/);
    assert.match(createdPreview, /Tag note free: Happy Birthday Chị Hai/);
    await page.evaluate(() => MEEOPS7.closeOverlay());

    // 7. Production view renders Tag note free on all 3 orders via Fallback API
    await page.evaluate(() => MEEOPS7.go('production'));
    await page.waitForFunction(() => S.page === 'production' && document.querySelectorAll('.mee3-prod-tag-note').length >= 3);
    const prodText = await page.locator('#content').innerText();
    assert.match(prodText, /Tag note free:/);
    assert.match(prodText, /Happy Birthday Chị Hai/);
    assert.match(prodText, /Mừng tốt nghiệp rực rỡ/);
    assert.deepEqual(pageErrors, [], 'Zero uncaught page errors during Core-unavailable Fallback flow');

    const summary = {
      ok: true,
      coreUnavailableStatus: 503,
      fallbackCallsCount: fallbackApiCalls.length,
      drawerVerified: true,
      copyVerified: true,
      editFormVerified: true,
      createFormVerified: true,
      productionViewVerified: true,
      pageErrorsCount: pageErrors.length,
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary));
  } finally {
    await browser?.close().catch(() => {});
    server?.closeAllConnections?.();
    server?.close();
    await pg?.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
