'use strict';

/**
 * MEEHOA OPS V3.1 — Core/Fallback API `tagNoteFree` Parity & PGlite Write/Read Round-Trip
 *
 * Pure Node + PGlite SQL suite (no Chromium dependency; runs inside CI `test` job).
 * Browser E2E under Core-unavailable `HTTP 503` runs in `scripts/fallback-api-tag-note-free-browser.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const API_FALLBACK_PATH = path.join(ROOT, 'supabase/functions/meehoasg-api/index.js');
const API_CORE_PATH = path.join(ROOT, 'supabase/functions/meehoasg-api-core/index.js');
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

async function setupMigratedPglite() {
  const pg = new PGlite();
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
  return pg;
}

/**
 * Translates PostgREST HTTP calls from `meehoasg-api` / `_shared/operations.js` into PGlite SQL.
 */
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

function bootFunctionVm(filePath, extraGlobals = {}) {
  const source = fs.readFileSync(filePath, 'utf8').replace(/^import .*\n/gm, '');
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
    Response: class MockResponse {
      constructor(body, init = {}) {
        this.body = body;
        this.status = init.status || 200;
        this.headers = init.headers || {};
      }
      async json() { return JSON.parse(this.body); }
      async text() { return String(this.body ?? ''); }
    },
    createOperationService: () => ({ run: async () => ({ ok: true }) }),
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
    ...extraGlobals,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, serveHandler };
}

test('Fallback API parity: meehoasg-api and meehoasg-api-core return identical tagNoteFree & note across all read endpoints', async () => {
  const actor = { username: 'admin', display_name: 'Admin', role: 'ADMIN', active: true };
  const rows = [
    {
      id: 'MEE-MIGRATED-1',
      updated_at: '2026-11-26T10:00:00Z',
      customer: 'Chị Hương',
      phone: '0901112233',
      order_date: '2026-11-26',
      order_time: '09:30',
      flower: 'Bó hồng kem 20 bông',
      note: '',
      tag_note_free: "Happy Women's Day, Love",
      order_source: 'Page/IG',
      order_type: 'STANDARD',
      shipping: 'Ghé lấy',
      address: '',
      flower_total: 750000,
      payment: 'Chưa thanh toán',
      sale: 'sale1',
      status: 'Chờ bó',
      settled: false,
      full_paid: false,
      full_paid_bill_urls: [],
      image_urls: [],
      is_deleted: false,
      delete_after_sheet_sync: false,
    },
    {
      id: 'MEE-MIXED-1',
      updated_at: '2026-11-26T11:00:00Z',
      customer: 'Anh Minh',
      phone: '0909888777',
      order_date: '2026-11-26',
      order_time: '14:00',
      flower: 'Giỏ lan hồ điệp',
      note: 'Gọi trước khi giao 15 phút',
      tag_note_free: 'Chúc mừng khai trương hồng phát',
      order_source: 'Zalo',
      order_type: 'STANDARD',
      shipping: 'Shop book ship',
      address: '45 Nguyễn Huệ, Q1',
      flower_total: 1500000,
      payment: 'Chưa thanh toán',
      sale: 'sale1',
      status: 'Chờ bó',
      settled: false,
      full_paid: false,
      full_paid_bill_urls: [],
      image_urls: [],
      is_deleted: false,
      delete_after_sheet_sync: false,
    },
    {
      id: 'MEE-EMPTY-1',
      updated_at: '2026-11-26T12:00:00Z',
      customer: 'Chị Lan',
      phone: '',
      order_date: '2026-11-26',
      order_time: '16:00',
      flower: 'Bó tulip trắng',
      note: '',
      tag_note_free: null,
      order_source: 'Threads',
      order_type: 'STANDARD',
      shipping: 'Ghé lấy',
      address: '',
      flower_total: 500000,
      payment: 'Chưa thanh toán',
      sale: 'sale1',
      status: 'Chờ bó',
      settled: false,
      full_paid: false,
      full_paid_bill_urls: [],
      image_urls: [],
      is_deleted: false,
      delete_after_sheet_sync: false,
    },
  ];
  const srRows = [{
    id: 'SET-PARITY-1',
    order_id: 'MEE-MIGRATED-1',
    sale_username: 'sale1',
    sale_name: 'Sale Một',
    flower_total: 750000,
    accessory_total: 0,
    vat: 0,
    ship_fee: 0,
    required_amount: 750000,
    bill_urls: [],
    note: '',
    status: 'PENDING',
    submitted_at: '2026-11-26T12:15:00Z',
  }];

  function wireMocks(c, isCore) {
    c.requireUser = async () => actor;
    c.saleDirectory = async () => ({
      users: [actor, { username: 'sale1', display_name: 'Sale Một', role: 'SALE', active: true }],
      byUsername: new Map([['admin', actor], ['sale1', { username: 'sale1', display_name: 'Sale Một', role: 'SALE', active: true }]]),
      byDisplayName: new Map(),
      ambiguousDisplayNames: new Set(),
      map: new Map(),
    });
    c.settlementMap = async () => ({ 'MEE-MIGRATED-1': srRows[0] });
    c.displayUrls = async (u) => u || [];
    c.one = async (_tbl, q) => rows.find((r) => q?.id === `eq.${r.id}`) || null;
    c.all = async (tbl) => (tbl === 'settlement_requests' ? srRows : tbl === 'app_users' ? [actor] : rows);
    if (isCore) {
      c.db = async (name) => (name === 'rpc/mee_search_orders_page' ? { rows, total: rows.length } : []);
      c.displayPreviewUrls = async (u) => u || [];
    }
  }

  const fb = bootFunctionVm(API_FALLBACK_PATH).ctx;
  const core = bootFunctionVm(API_CORE_PATH).ctx;
  wireMocks(fb, false);
  wireMocks(core, true);

  const pickTagFields = (o) => ({ id: o.id, note: o.note, tagNoteFree: o.tagNoteFree });
  const rangePayload = { start: '2026-11-26', end: '2026-11-26', date: '2026-11-26', page: 1, pageSize: 80 };

  for (const row of rows) {
    assert.deepEqual(
      pickTagFields(fb.decorate(row, actor, null)),
      pickTagFields(core.decorate(row, actor, null, await core.saleDirectory())),
      `decorate() tagNoteFree/note parity mismatch for ${row.id}`
    );
    const [fbOne, coreOne] = await Promise.all([
      fb.getOrder({ orderId: row.id }, actor),
      core.fastOrder({ orderId: row.id }),
    ]);
    assert.deepEqual(pickTagFields(fbOne.order), pickTagFields(coreOne.order), `getOrder parity mismatch for ${row.id}`);
  }

  const [fbOrders, coreOrders] = await Promise.all([fb.getOrders(rangePayload, actor), core.fastOrders(rangePayload)]);
  assert.deepEqual(fbOrders.items.map(pickTagFields), coreOrders.items.map(pickTagFields), 'getOrders parity');

  const [fbProd, coreProd] = await Promise.all([fb.getProduction(rangePayload, actor), core.fastProduction(rangePayload)]);
  assert.deepEqual(fbProd.orders.map(pickTagFields), coreProd.orders.map(pickTagFields), 'getProductionOrders parity');

  const [fbDebt, coreDebt] = await Promise.all([fb.getDebt(rangePayload, actor), core.fastDebt(rangePayload)]);
  assert.deepEqual(fbDebt.items.map(pickTagFields), coreDebt.items.map(pickTagFields), 'getDebtReview parity');

  const [fbQueue, coreQueue] = await Promise.all([
    fb.settlementQueue({ status: 'PENDING', allPending: true }, actor),
    core.fastSettlementQueue({ status: 'PENDING', allPending: true }),
  ]);
  assert.deepEqual(pickTagFields(fbQueue.items[0].order), pickTagFields(coreQueue.items[0].order), 'getSettlementQueue parity');

  const [fbDash, coreDash] = await Promise.all([
    fb.dashboard({ start: '2026-11-26', end: '2026-11-26' }, actor),
    core.fastDashboard({ start: '2026-11-26', end: '2026-11-26' }),
  ]);
  assert.equal(fbDash.summary.orders, coreDash.summary.orders);
});

test('Fallback API PGlite round-trip: migrated Legacy Note backfill, createOrder, updateOrder & legacy omission preserve tagNoteFree without data loss', async () => {
  const { createOperationService } = await import('../supabase/functions/_shared/operations.js');
  const pg = await setupMigratedPglite();
  try {
    const today = vnToday();
    await pg.query(
      `insert into public.orders (
        id, order_date, order_time, customer, phone, flower, note, tag_note_free, order_source, order_type,
        shipping, address, flower_total, payment, sale, status, settled, full_paid,
        is_deleted, delete_after_sheet_sync, created_at, updated_at
      ) values
      ('MEE-FB-LEG-1', $1, '09:30', 'Khách Legacy', '0902223344', 'Bó hồng', $2, '', 'Page/IG', 'STANDARD', 'Ghé lấy', '', 680000, 'Chưa thanh toán', 'sale1', 'Chờ bó', false, false, false, false, '2026-10-20T05:00:00Z', '2026-10-20T05:00:00Z')`,
      [today, "Happy Women's Day, Love"]
    );
    await pg.exec(fs.readFileSync(BACKFILL_SQL_PATH, 'utf8'));

    const fbBoot = bootFunctionVm(API_FALLBACK_PATH, {
      fetch: createPgliteRestFetch(pg),
      createOperationService,
    });
    const callApi = async (name, payload) => {
      const resp = await fbBoot.serveHandler({
        method: 'POST',
        headers: { get: (k) => ({ origin: 'https://ops.meehoasg.com', 'content-length': '256' }[k.toLowerCase()] || null) },
        json: async () => ({ name, payload }),
      });
      return resp.json();
    };

    const login = await callApi('loginAndBootstrap', { username: 'admin', password: 'fallback-admin-pass' });
    assert.equal(login.ok, true);
    const token = login.token;

    // 1. Migrated Legacy Note readable across getOrder, getOrders, and getProductionOrders with cleared note
    const legOrder = await callApi('getOrder', { token, orderId: 'MEE-FB-LEG-1' });
    assert.equal(legOrder.ok, true);
    assert.equal(legOrder.order.tagNoteFree, "Happy Women's Day, Love");
    assert.equal(legOrder.order.note, '');

    const listRes = await callApi('getOrders', { token, start: today, end: today, page: 1, pageSize: 80 });
    assert.equal(listRes.items.find((o) => o.id === 'MEE-FB-LEG-1').tagNoteFree, "Happy Women's Day, Love");

    const prodRes = await callApi('getProductionOrders', { token, date: today });
    assert.equal(prodRes.orders.find((o) => o.id === 'MEE-FB-LEG-1').tagNoteFree, "Happy Women's Day, Love");

    // 2. Edit another field while passing tagNoteFree from decorate() + explicitly update tagNoteFree
    const upd1 = await callApi('updateOrder', {
      token,
      requestId: 'fb-upd-1',
      orderId: 'MEE-FB-LEG-1',
      expectedUpdatedAt: legOrder.order.updatedAt,
      order: {
        customer: legOrder.order.customer,
        phone: legOrder.order.phone,
        date: legOrder.order.date,
        time: legOrder.order.time,
        flower: legOrder.order.flower,
        note: legOrder.order.note,
        tagNoteFree: "Happy Women's Day, Love\nKý tên: Gia đình",
        orderSource: legOrder.order.orderSource,
        orderType: 'STANDARD',
        shipping: 'Shop book ship',
        address: '12 Lê Lợi, Q1',
        flowerTotal: 680000,
        payment: 'Chưa thanh toán',
        sale: 'sale1',
      },
    });
    assert.equal(upd1.ok, true, upd1.message);

    const afterUpd1 = await callApi('getOrder', { token, orderId: 'MEE-FB-LEG-1' });
    assert.equal(afterUpd1.order.tagNoteFree, "Happy Women's Day, Love\nKý tên: Gia đình");
    assert.equal(afterUpd1.order.note, '');
    assert.equal(afterUpd1.order.address, '12 Lê Lợi, Q1');

    // 3. Legacy client omitting `tagNoteFree` in updateOrder MUST NOT wipe existing `tag_note_free`
    const updLegacyOmit = await callApi('updateOrder', {
      token,
      requestId: 'fb-upd-omit',
      orderId: 'MEE-FB-LEG-1',
      expectedUpdatedAt: afterUpd1.order.updatedAt,
      order: {
        customer: 'Khách Legacy Đã Sửa',
        date: today,
        time: '09:30',
        flower: 'Bó hồng',
        note: '',
        shipping: 'Ghé lấy',
        flowerTotal: 680000,
        sale: 'sale1',
      },
    });
    assert.equal(updLegacyOmit.ok, true, updLegacyOmit.message);
    const afterOmit = await callApi('getOrder', { token, orderId: 'MEE-FB-LEG-1' });
    assert.equal(afterOmit.order.tagNoteFree, "Happy Women's Day, Love\nKý tên: Gia đình");

    // 4. createOrder via Fallback API with BOTH note and tagNoteFree persists both cleanly
    const created = await callApi('createOrder', {
      token,
      requestId: 'fb-create-1',
      order: {
        customer: 'Khách Mới Fallback',
        phone: '0909998877',
        date: today,
        time: '15:00',
        flower: 'Bó tulip hồng 10 cành',
        note: 'Gói giấy lụa kem',
        tagNoteFree: 'Chúc mừng sinh nhật mẹ yêu',
        orderSource: 'Zalo',
        requireOrderSource: true,
        orderType: 'STANDARD',
        shipping: 'Ghé lấy',
        flowerTotal: 850000,
        payment: 'Chưa thanh toán',
        sale: 'sale1',
      },
    });
    assert.equal(created.ok, true, created.message);
    const createdRead = await callApi('getOrder', { token, orderId: created.orderId });
    assert.equal(createdRead.order.note, 'Gói giấy lụa kem');
    assert.equal(createdRead.order.tagNoteFree, 'Chúc mừng sinh nhật mẹ yêu');
  } finally {
    await pg.close().catch(() => {});
  }
});
