'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const API_PATH = path.join(ROOT, 'supabase/functions/meehoasg-api/index.js');
const CORE_PATH = path.join(ROOT, 'supabase/functions/meehoasg-api-core/index.js');
const HTML_PATH = path.join(ROOT, 'html');

const ONE_PIXEL_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
const SAMPLE_DATA_URL = `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`;

async function setupDb() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);
  `);
  await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  const dir = path.join(ROOT, 'supabase/migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  await pg.exec(`
    insert into public.app_users(username, display_name, role, password_hash, active) values
      ('admin', 'Admin', 'ADMIN', 'orig-admin-hash', true),
      ('cmui', 'C Mụi', 'SALE', 'orig-cmui-hash', true),
      ('huynhlan', 'Huỳnh Lan', 'SALE', 'orig-lan-hash', true);
    insert into public.app_sessions(token_hash, username, expires_at) values
      ('sess-cmui-1', 'cmui', now() + interval '7 days'),
      ('sess-lan-1', 'huynhlan', now() + interval '7 days');
  `);
  return pg;
}

function loadLegacyApiSaveUser(pg) {
  const src = fs.readFileSync(API_PATH, 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/Deno\.serve\([\s\S]*$/, '');
  const ctx = {
    Deno: {
      env: { get: (k) => (k === 'SUPABASE_URL' ? 'http://127.0.0.1:54321' : k === 'SUPABASE_SERVICE_ROLE_KEY' ? 'svc' : '') },
    },
    crypto: crypto.webcrypto,
    URL,
    TextEncoder,
    Uint8Array,
    Intl,
    Date,
    console: { log: () => {}, error: () => {} },
    fetch: async () => ({ ok: true, status: 200, text: async () => '[]' }),
    createR2ImageReader: () => async (v) => v,
    createR2Media: () => null,
    createOperationStorage: () => ({ uploadImages: async () => [], discard: async () => {} }),
    createOperationService: () => ({ run: async () => ({ ok: true }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  // Wire db/all/one/audit directly to PGlite so SQL constraints (23505) are enforced for real!
  ctx.db = async (table, query = {}, method = 'GET', body) => {
    if (table === 'app_users' && method === 'GET') {
      if (query.username && query.username.startsWith('eq.')) {
        const res = await pg.query('select * from public.app_users where username = $1', [query.username.slice(3)]);
        return res.rows;
      }
      const res = await pg.query('select * from public.app_users');
      return res.rows;
    }
    if (table === 'app_users' && method === 'POST') {
      try {
        const res = await pg.query(
          'insert into public.app_users(username, display_name, role, active, password_hash) values ($1,$2,$3,$4,$5) returning *',
          [body.username, body.display_name, body.role, body.active, body.password_hash]
        );
        return res.rows;
      } catch (e) {
        if (String(e.code) === '23505' || /unique/i.test(String(e.message))) {
          throw new Error(`DB 409: duplicate key value violates unique constraint (23505)`);
        }
        throw e;
      }
    }
    if (table === 'app_users' && method === 'PATCH') {
      const target = query.username.slice(3);
      const sets = [];
      const vals = [];
      let i = 1;
      for (const [k, v] of Object.entries(body)) {
        sets.push(`${k} = $${i++}`);
        vals.push(v);
      }
      vals.push(target);
      const res = await pg.query(`update public.app_users set ${sets.join(', ')} where username = $${i} returning *`, vals);
      return res.rows;
    }
    if (table === 'app_sessions' && method === 'DELETE') {
      const target = query.username.slice(3);
      await pg.query('delete from public.app_sessions where username = $1', [target]);
      return [];
    }
    if (table === 'activity_log' && method === 'POST') {
      return [];
    }
    throw new Error(`Unhandled mock db ${method} ${table}`);
  };
  ctx.all = async (table, query = {}) => ctx.db(table, query, 'GET');
  ctx.one = async (table, query = {}) => (await ctx.db(table, query, 'GET'))[0] || null;
  ctx.audit = async () => {};
  return ctx;
}

test('Group 3A: saveUser separates create vs edit, blocks duplicate normalized usernames, never overwrites existing password/role/sessions', async () => {
  const pg = await setupDb();
  try {
    const api = loadLegacyApiSaveUser(pg);
    const admin = { username: 'admin', display_name: 'Admin', role: 'ADMIN' };

    // 1. DB normalized function verification
    const normCheck = await pg.query(`
      select
        public.mee_username_norm('Huỳnh Lan') as a,
        public.mee_username_norm('  HUYNH   LAN ') as b,
        public.mee_username_norm('Đặng An') as c
    `);
    assert.equal(normCheck.rows[0].a, 'huynhlan');
    assert.equal(normCheck.rows[0].b, 'huynhlan');
    assert.equal(normCheck.rows[0].c, 'dangan');

    // 2. Create mode with duplicate existing username (exact, uppercase, spaces, diacritics) -> MUST BLOCK
    for (const dupInput of ['cmui', 'CMUI', 'c mui', 'Huỳnh Lan', 'HUYNHLAN']) {
      const res = await api.saveUser({
        mode: 'create',
        user: { username: dupInput, name: 'Kẻ Ghi Đè', role: 'ADMIN', password: 'newpassword123', active: false },
      }, admin);
      assert.equal(res.ok, false, `Duplicate "${dupInput}" must be rejected`);
      assert.equal(res.code, 'USERNAME_EXISTS');
    }

    // Verify existing accounts and sessions were 100% untouched!
    const cmui = (await pg.query("select * from public.app_users where username='cmui'")).rows[0];
    assert.equal(cmui.display_name, 'C Mụi');
    assert.equal(cmui.role, 'SALE');
    assert.equal(cmui.password_hash, 'orig-cmui-hash');
    assert.equal(cmui.active, true);
    const sessions = (await pg.query("select count(*)::int as c from public.app_sessions where username in ('cmui','huynhlan')")).rows[0].c;
    assert.equal(sessions, 2, 'Active sessions of existing users must NEVER be deleted on failed duplicate create');

    // 3. Unlabelled legacy payload (no mode) MUST default safely to create -> cannot silently overwrite cmui!
    const legacyOverwriteAttempt = await api.saveUser({
      user: { username: 'cmui', name: 'Silent Overwrite', role: 'ADMIN', password: 'hackpassword', active: true },
    }, admin);
    assert.equal(legacyOverwriteAttempt.ok, false);
    assert.equal(legacyOverwriteAttempt.code, 'USERNAME_EXISTS');

    // 4. Create mode with brand-new username succeeds
    const created = await api.saveUser({
      mode: 'create',
      user: { username: 'Nhân Viên Mới', name: 'Nhân Viên Mới', role: 'SALE', password: 'secretpassword', active: true },
    }, admin);
    assert.equal(created.ok, true);
    assert.equal(created.username, 'nhanvienmoi');

    // 5. Concurrent duplicate creates racing at DB layer -> 1 succeeds, 1 returns USERNAME_EXISTS, zero overwrite
    const [r1, r2] = await Promise.all([
      api.saveUser({ mode: 'create', user: { username: 'sale_race', name: 'First', role: 'SALE', password: 'password111', active: true } }, admin),
      api.saveUser({ mode: 'create', user: { username: 'SALE _ RACE', name: 'Second', role: 'ADMIN', password: 'password222', active: false } }, admin),
    ]);
    const okOnes = [r1, r2].filter((r) => r.ok);
    const dupOnes = [r1, r2].filter((r) => !r.ok && r.code === 'USERNAME_EXISTS');
    assert.equal(okOnes.length, 1);
    assert.equal(dupOnes.length, 1);

    // 6. Edit mode rejects retargeting another username
    const retarget = await api.saveUser({
      mode: 'edit',
      originalUsername: 'cmui',
      user: { username: 'huynhlan', name: 'C Mụi', role: 'SALE', active: true },
    }, admin);
    assert.equal(retarget.ok, false);
    assert.equal(retarget.code, 'USERNAME_IMMUTABLE');

    // 7. Edit mode updates display_name without wiping password or sessions when password blank & role/active unchanged
    const edited = await api.saveUser({
      mode: 'edit',
      originalUsername: 'cmui',
      user: { username: 'cmui', name: 'Cô Mụi', role: 'SALE', password: '', active: true },
    }, admin);
    assert.equal(edited.ok, true);
    const cmuiAfter = (await pg.query("select * from public.app_users where username='cmui'")).rows[0];
    assert.equal(cmuiAfter.display_name, 'Cô Mụi');
    assert.equal(cmuiAfter.password_hash, 'orig-cmui-hash');
    const cmuiSess = (await pg.query("select count(*)::int as c from public.app_sessions where username='cmui'")).rows[0].c;
    assert.equal(cmuiSess, 1);

    // 8. Frontend modal UI explicitly distinguishes create vs edit and locks username in edit mode
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /data-user-mode=\\"/);
    assert.match(html, /data-original-username=\\"/);
    assert.match(html, /Chỉnh sửa tài khoản/);
    assert.match(html, /Thêm tài khoản mới/);
    assert.match(html, /name="username"[^>]*readonly/);
    assert.match(html, /gas\('saveUser',\s*\{\s*mode:\s*mode,\s*originalUsername:\s*originalUsername,\s*user:\s*u\s*\}\)/);
  } finally {
    await pg.close();
  }
});

test('Group 3B: Order Bot createOrder contract works E2E against V3.1 OPS + Permanent R2 + idempotent retry + V1 payment policy', async () => {
  const pg = await setupDb();
  const r2Stored = new Map();
  try {
    const opsMod = await import('../supabase/functions/_shared/operations.js');
    const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

    // Simulated Permanent R2 uploader matching meehoasg-api-core
    const uploadEvidenceImages = async (files, bucket) => {
      const out = [];
      for (const f of files || []) {
        assert.match(String(f.data || ''), /^data:image\/jpeg;base64,/);
        const key = `${bucket}/${crypto.randomUUID()}.jpg`;
        r2Stored.set(key, f.data);
        out.push(`r2://meehoasg-media/${key}`);
      }
      return out;
    };

    const db = async (table, query = {}, method = 'GET', body) => {
      if (table === 'rpc/mee_ops_lookup') {
        const res = await pg.query(
          'select public.mee_ops_lookup($1,$2,$3,$4) as res',
          [body.p_actor, body.p_request_id, body.p_action, body.p_fingerprint]
        );
        return res.rows[0].res;
      }
      if (table === 'rpc/mee_ops_mutate') {
        const res = await pg.query(
          'select public.mee_ops_mutate($1,$2,$3,$4,$5::jsonb) as res',
          [body.p_actor, body.p_request_id, body.p_action, body.p_fingerprint, JSON.stringify(body.p_input)]
        );
        return res.rows[0].res;
      }
      throw new Error(`Unexpected db ${method} ${table}`);
    };
    const one = async () => null;
    const svc = opsMod.createOperationService({
      db,
      one,
      uploadImages: uploadEvidenceImages,
      discardImages: async () => {},
      sha256: async (s) => sha256(s),
      newId: (prefix) => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
    });

    // Exact payload shape produced by order-bot/cloudflare/ops-client.mjs callCreateOrder
    const botOrderPayload = {
      requestId: 'bot-draft-e2e-req-001',
      order: {
        customer: 'Chị Lan Anh',
        phone: '0909123456',
        date: '2026-11-28',
        time: '14:30',
        flower: 'Bó 20 bông hồng Ecuador tone kem',
        note: 'Gói giấy đen tối giản [🧾 Đính kèm 1 bill chưa xác minh]',
        shipping: 'Shop book ship',
        address: '123 Nguyễn Huệ, Q1, TP.HCM',
        flowerTotal: 850000,
        payment: 'Đã cọc 300.000 đ',
        sale: 'cmui',
        card: true,
        cardQty: 1,
        cardText: 'Chúc mừng sinh nhật',
        banner: false,
        bannerQty: 0,
        bannerText: '',
        charmFee: 0,
        paperFee: 0,
        vat: 0,
        shipFee: 0,
        shipFeeActive: '0',
        fullPaidRequested: false,
        imageFiles: [{ data: SAMPLE_DATA_URL }],
        unverifiedBillFiles: [{ data: SAMPLE_DATA_URL }],
      },
    };

    const botUser = { username: 'admin', display_name: 'Admin', role: 'ADMIN' };
    const first = await svc.run('createOrder', botOrderPayload, botUser);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.orderId);
    assert.equal(first.row.customer, 'Chị Lan Anh');
    assert.equal(first.row.order_date, '2026-11-28');
    assert.equal(first.row.order_time, '14:30');
    assert.equal(first.row.flower, 'Bó 20 bông hồng Ecuador tone kem');
    assert.equal(first.row.payment, 'Đã cọc 300.000 đ');
    assert.equal(first.row.full_paid, false, 'V1 payment policy: Bot must NEVER auto-Full-Paid');
    assert.equal(first.row.settled, false, 'V1 payment policy: Bot must NEVER auto-settle');
    assert.equal(first.row.image_urls.length, 1);
    assert.match(first.row.image_urls[0], /^r2:\/\/meehoasg-media\/order-images\/[0-9a-f-]{36}\.jpg$/);

    // Retry with exact same requestId -> idempotent, zero duplicate order!
    const retry = await svc.run('createOrder', botOrderPayload, botUser);
    assert.equal(retry.ok, true);
    assert.equal(retry.orderId, first.orderId);
    const countOrders = (await pg.query('select count(*)::int as c from public.orders')).rows[0].c;
    assert.equal(countOrders, 1, 'Duplicate /confirm retry must NEVER create a second order');
    assert.equal(r2Stored.size, 1, 'Idempotent retry lookup must avoid re-uploading R2 objects');
  } finally {
    await pg.close();
  }
});
