/**
 * Fake-conversation benchmark for MEEHOA Order Bot.
 *
 * Drives the real Telegram webhook handler (worker.mjs) against the real OPS core runtime
 * (cloudflare-migration/runtime/core.js) on an in-memory SQLite D1.
 *
 * Modes:
 *  - Default (mocked Gemini): scripted JSON responses verify plumbing, merge rules, edit rules,
 *    and quota/error fallback deterministically.
 *  - Real Gemini (`--real-gemini --model gemini-4-hydrogen` with GEMINI_API_KEY env): calls the live
 *    Gemini REST API on fake order messages and measures per-field accuracy, re-asks, and latency.
 *
 * Usage:
 *   node tests/helpers/conversation-benchmark.mjs <botRoot> [opsDirOrRoot] [--real-gemini --model gemini-4-hydrogen]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const CHAT_ID = 5252724920;

function resolveOpsDir(opsDirOrRoot) {
  const p = path.resolve(opsDirOrRoot);
  if (fs.existsSync(path.join(p, 'runtime', 'core.js'))) return p;
  return path.join(p, 'cloudflare-migration');
}

async function sha256Hex(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function createMockR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts) {
      const buf = value instanceof ArrayBuffer ? new Uint8Array(value) : (value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));
      objects.set(key, { body: buf, httpMetadata: opts?.httpMetadata || {}, customMetadata: opts?.customMetadata || {} });
      return { key };
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        key,
        body: o.body,
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
        size: o.body.length,
        async arrayBuffer() { return o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength); }
      };
    },
    async head(key) { const o = objects.get(key); return o ? { key, size: o.body.length, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } : null; },
    async delete(key) { objects.delete(key); }
  };
}

async function createHarness(botRoot, opsDirOrRoot) {
  const opsDir = resolveOpsDir(opsDirOrRoot);
  const schemaPath = fs.existsSync(path.join(opsDir, 'schema', 'schema.sql'))
    ? path.join(opsDir, 'schema', 'schema.sql')
    : path.join(opsDir, 'generated', 'schema.sql');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(schemaPath, 'utf8'));
  sqlite.exec(fs.readFileSync(path.join(botRoot, 'order-bot/cloudflare/schema.sql'), 'utf8'));
  const db = {
    sqlite,
    prepare(sql) {
      const bindStmt = (args = []) => ({
        bind: (...a) => bindStmt(a),
        first: async () => sqlite.prepare(sql).get(...args) || null,
        all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: { changes: 0 } }),
        run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes || 0) } })
      });
      return bindStmt([]);
    },
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try { const out = []; for (const s of stmts || []) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    }
  };
  const r2 = createMockR2();
  const opsToken = 'b'.repeat(64);
  const tokenHash = await sha256Hex(opsToken);
  await db.prepare('INSERT INTO app_users(row_key, data) VALUES (?, ?)')
    .bind('cmui', JSON.stringify({ username: 'cmui', display_name: 'C Mụi', role: 'ADMIN', active: true })).run();
  await db.prepare('INSERT INTO app_sessions(row_key, data) VALUES (?, ?)')
    .bind(tokenHash, JSON.stringify({ token_hash: tokenHash, username: 'cmui', expires_at: '2099-12-31T23:59:59.000Z' })).run();
  const { createCore } = await import(pathToFileURL(path.join(opsDir, 'runtime/core.js')).href);
  const raw = createCore({ DB: db, MEDIA_R2: r2, MEDIA_SIGNING_KEY: 'bench-signing-key', LEGACY_PASSWORD_SALT: 'MEE-FLOWER-V4' });
  const opsHandler = (input, init) => raw(input instanceof Request ? input : new Request(input, init));
  const callOpsApi = async (name, payload) => (await opsHandler(new Request('https://ops.local/api-core', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, payload: { token: opsToken, ...payload } })
  }))).json();
  return { db, r2, opsToken, opsHandler, callOpsApi };
}

function geminiReply(obj) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
}

async function runCase(mods, botRoot, opsDirOrRoot, c, options = {}) {
  const { realGemini = false, geminiApiKey = '', geminiModel = 'gemini-4-hydrogen' } = options;
  const h = await createHarness(botRoot, opsDirOrRoot);
  mods.clearCache?.();
  const sent = [];
  const geminiCalls = [];
  const geminiLatenciesMs = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      const msg = (prompt.split('"""')[1] || '').trim();
      geminiCalls.push(msg);
      const t0 = Date.now();
      if (realGemini && !c.forceErrorMock) {
        const resp = await originalFetch(url, opts);
        geminiLatenciesMs.push(Date.now() - t0);
        return resp;
      }
      const out = c.gemini ? c.gemini(msg) : {};
      geminiLatenciesMs.push(Date.now() - t0);
      return out instanceof Response ? out : geminiReply(out || {});
    }
    if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/s.jpg', file_size: 1024 } }));
    if (u.includes('/file/bot')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7]));
    if (u.includes('/sendMessage')) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ ok: true })); }
    return new Response('Not found', { status: 404 });
  };
  const env = {
    DB: h.db, MEDIA_R2: h.r2, BOT_TOKEN: 'fake_bot_token', OPS_TOKEN: h.opsToken,
    OPS_API_URL: 'https://meehoasg-ops-staging.meehoasg.workers.dev/api-core',
    OPS_SERVICE: { fetch: h.opsHandler }, TELEGRAM_SECRET_TOKEN: 'bench_secret',
    ALLOWED_USER_IDS: String(CHAT_ID),
    GEMINI_API_KEY: realGemini ? geminiApiKey : 'fake-gemini-key',
    GEMINI_MODEL: geminiModel
  };
  let id = 1000;
  const send = msg => {
    id += 1;
    const req = new Request('https://bot.local/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'bench_secret' },
      body: JSON.stringify({ update_id: id, message: { message_id: id, date: 1795600000 + id, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID }, ...msg } })
    });
    return mods.handleTelegramWebhook(req, env);
  };
  const caseStart = Date.now();
  try {
    for (const s of c.steps) await send(typeof s === 'string' ? { text: s } : s);
    const drafts = await mods.loadDrafts(h.db, CHAT_ID);
    const ops = await h.callOpsApi('getOrders', { start: '2026-01-01', end: '2027-12-31', page: 1, pageSize: 100 });
    const reAskCount = sent.filter(m => /Còn thiếu|Chưa có đơn nháp|cần làm rõ|bổ sung/i.test(String(m.text || ''))).length;
    const out = await c.check({ drafts, ops, sent, geminiCalls, active: drafts[drafts.__active], list: Object.entries(drafts).filter(([k]) => !k.startsWith('__')).map(([, v]) => v) });
    return {
      ...out,
      mode: realGemini && !c.forceErrorMock ? `real:${geminiModel}` : 'mock-gemini',
      latencyMs: Date.now() - caseStart,
      geminiLatenciesMs,
      reAskCount
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const photo = (fid, caption) => ({ photo: [{ file_id: fid, file_unique_id: `u_${fid}` }], caption });
const lastText = sent => String(sent[sent.length - 1]?.text || '');
const norm = s => String(s || '').normalize('NFC').toLowerCase();

export const CASES = [
  {
    id: 'keep_customer_on_shipping_addon',
    title: 'Giữ tên "Như" khi bổ sung "Shop book ship" + địa chỉ (kể cả khi AI trả customer sai)',
    gemini: msg => (/shop book ship/i.test(msg) ? { customer: 'Shop book ship', shipping: 'Shop book ship', address: '102/34c Phan Huy Ích, P. Tân Sơn' } : {}),
    steps: [
      photo('p_nhu', 'Như + 0394200327\nmẫu: Bó hồng pastel\nTổng 350k\n28/12 & 13h30'),
      'Shop book ship 102/34c Phan Huy Ích, P. Tân Sơn'
    ],
    check: ({ active }) => {
      const f = active?.fields || {};
      const ok = f.customer === 'Như' && f.shipping === 'Shop book ship' && /Phan Huy Ích/.test(f.address || '');
      return { pass: ok, detail: { customer: f.customer, shipping: f.shipping, address: f.address } };
    }
  },
  {
    id: 'natural_caption_clean_flower',
    title: 'Tách tên khách khỏi mô tả hoa để trường mẫu chỉ chứa "Bó tulip trắng"',
    gemini: msg => (/tulip/i.test(msg) ? { customer: 'Lan', flower: 'Bó tulip trắng', date: '2026-12-29', time: '10:00', shipping: 'Khách tự book', flowerTotal: 500000 } : {}),
    steps: [photo('p_lan', 'chị Lan lấy bó tulip trắng nha, 500k, nhận 29/12 lúc 10h, khách tự book')],
    check: ({ active }) => {
      const f = active?.fields || {};
      const ok = f.customer === 'Lan' && f.flower === 'Bó tulip trắng' &&
        Number(f.flowerTotal) === 500000 && f.shipping === 'Khách tự book' && f.date === '2026-12-29' && f.time === '10:00';
      return { pass: ok, detail: { customer: f.customer, flower: f.flower, flowerTotal: f.flowerTotal, shipping: f.shipping, date: f.date, time: f.time } };
    }
  },
  {
    id: 'explicit_edit_existing_field',
    title: 'Sửa rõ ràng một trường đã có ("sửa giờ thành 15h", "đổi giá thành 450k") mà giữ nguyên mọi trường khác',
    gemini: () => ({}),
    steps: [
      photo('p_edit', 'Như + 0394200327\nmẫu: Bó hồng pastel\nTổng 350k\n28/12 & 13h30\nship: Ghé lấy'),
      'sửa giờ thành 15h',
      'đổi giá thành 450k'
    ],
    check: ({ active }) => {
      const f = active?.fields || {};
      const ok = f.customer === 'Như' && f.phone === '0394200327' && f.flower === 'Bó hồng pastel' &&
        f.shipping === 'Ghé lấy' && f.time === '15:00' && Number(f.flowerTotal) === 450000;
      return { pass: ok, detail: { customer: f.customer, flower: f.flower, time: f.time, flowerTotal: f.flowerTotal, shipping: f.shipping } };
    }
  },
  {
    id: 'split_two_consecutive_orders',
    title: 'Hai đơn liên tiếp (ảnh + caption khác khách) tách thành 2 nháp, không trộn khách/giá/mẫu/ảnh',
    gemini: () => ({}),
    steps: [
      photo('p_a', 'Như + 0394200327\nmẫu: Bó hồng pastel\nTổng 350k cọc 200k\n28/12 & 13h30\nship: Ghé lấy'),
      photo('p_b', 'Hà + 0911222333\nTổng 600k\n30/12 & 9h')
    ],
    check: ({ list, active }) => {
      const a = list.find(d => d.fields?.customer === 'Như');
      const b = list.find(d => d.fields?.customer === 'Hà');
      const ok = Boolean(a && b && a.id !== b.id) && active?.id === b.id &&
        Number(a.fields.flowerTotal) === 350000 && Number(b.fields.flowerTotal) === 600000 && a.fields.flower === 'Bó hồng pastel' &&
        !b.fields.flower && !b.fields.shipping && (a.sampleRefs || []).length === 1 && (b.sampleRefs || []).length === 1;
      return { pass: ok, detail: { drafts: list.length, a: a && { customer: a.fields.customer, total: a.fields.flowerTotal, flower: a.fields.flower, samples: (a.sampleRefs || []).length }, b: b && { customer: b.fields.customer, total: b.fields.flowerTotal, flower: b.fields.flower || null, shipping: b.fields.shipping || null, samples: (b.sampleRefs || []).length } } };
    }
  },
  {
    id: 'ambiguous_caption_asks_back',
    title: 'Ảnh + caption mơ hồ ("mẫu này nha em"): không đoán trường, /confirm bị chặn và hỏi phần thiếu, OPS không có đơn',
    gemini: () => ({ flower: null, flowerTotal: null }),
    steps: [photo('p_amb', 'mẫu này nha em'), '/confirm'],
    check: ({ active, ops, sent }) => {
      const f = active?.fields || {};
      const asked = sent.some(m => /thiếu|bổ sung|chú thích đơn hàng/.test(norm(m.text)));
      const ok = (ops.items || []).length === 0 && !f.flowerTotal && !f.flower && asked;
      return { pass: ok, detail: { opsOrders: (ops.items || []).length, flower: f.flower || null, flowerTotal: f.flowerTotal || null, replies: sent.map(m => String(m.text || '').slice(0, 120)) } };
    }
  },
  {
    id: 'deposit_350_200_from_ops',
    title: 'Tổng 350k cọc 200k → bản tóm tắt có C Mụi trước /confirm; OPS trả paid 200.000 đ, debt 150.000 đ, Telegram báo đúng số OPS',
    gemini: () => ({}),
    steps: [
      photo('p_dep', 'Tổng 350k cọc 200k\nNhư + 0394200327\n28/12 & 13h30\nmẫu: Bó hồng pastel\nship: Ghé lấy\nnote: "Chúc mừng ngày nhận bằng thật rạng rỡ!"'),
      '/confirm'
    ],
    check: ({ ops, sent }) => {
      const summary = sent.map(m => String(m.text || '')).find(t => /C Mụi/.test(t) && /350\.000/.test(t)) || '';
      const o = (ops.items || [])[0] || {};
      const done = lastText(sent);
      const ok = (ops.items || []).length === 1 && Number(o.paid) === 200000 && Number(o.debt) === 150000 &&
        o.saleUsername === 'cmui' && Boolean(summary) && /200\.000/.test(done) && /150\.000/.test(done);
      return { pass: ok, detail: { opsOrders: (ops.items || []).length, paid: o.paid, debt: o.debt, payment: o.payment, saleUsername: o.saleUsername, summaryShownBeforeConfirm: Boolean(summary), finalReply: done.replace(/<[^>]+>/g, '').split('\n').filter(l => /Đã thu|Còn phải thu|Sale/.test(l)) } };
    }
  },
  {
    id: 'ai_quota_or_error_preserves_draft',
    title: 'AI lỗi hoặc hết hạn mức (HTTP 429 RESOURCE_EXHAUSTED): bot không sập, vẫn giữ nháp từ parser và báo phần còn thiếu',
    forceErrorMock: true,
    gemini: () => new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }), { status: 429 }),
    steps: [photo('p_err', 'Mai + 0909111222\nbó cúc họa mi, nhận 31/12 khoảng chiều')],
    check: ({ active, sent }) => {
      const f = active?.fields || {};
      const ok = Boolean(active) && f.customer === 'Mai' && f.phone === '0909111222' && /cúc họa mi/.test(f.flower || '') &&
        !/31\/12/.test(f.flower || '') && !f.flowerTotal && sent.some(m => /Còn thiếu/.test(String(m.text || '')));
      return { pass: ok, detail: { customer: f.customer, phone: f.phone, flower: f.flower, date: f.date, flowerTotal: f.flowerTotal || null, replies: sent.length } };
    }
  }
];

export async function runConversationBenchmark(botRoot, opsDirOrRoot = botRoot, options = {}) {
  const imp = p => import(pathToFileURL(path.join(botRoot, p)).href);
  const worker = await imp('order-bot/cloudflare/worker.mjs');
  const store = await imp('order-bot/cloudflare/d1-store.mjs');
  const client = await imp('order-bot/cloudflare/ops-client.mjs');
  const mods = { handleTelegramWebhook: worker.handleTelegramWebhook, loadDrafts: store.loadDrafts, clearCache: client.clearOpsOrderRulesCache };
  const results = [];
  for (const c of CASES) {
    try {
      const r = await runCase(mods, botRoot, opsDirOrRoot, c, options);
      results.push({ id: c.id, title: c.title, pass: Boolean(r.pass), mode: r.mode, latencyMs: r.latencyMs, geminiLatenciesMs: r.geminiLatenciesMs, reAskCount: r.reAskCount, detail: r.detail });
    } catch (err) {
      results.push({ id: c.id, title: c.title, pass: false, detail: { error: String(err?.message || err) } });
    }
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const realGemini = args.includes('--real-gemini');
  const modelIdx = args.indexOf('--model');
  const geminiModel = modelIdx >= 0 ? args[modelIdx + 1] : 'gemini-4-hydrogen';
  const positional = args.filter((a, i) => a !== '--real-gemini' && a !== '--model' && i !== modelIdx + 1);
  const botRoot = path.resolve(positional[0] || '.');
  const opsDirOrRoot = path.resolve(positional[1] || process.env.OPS_RUNTIME_DIR || botRoot);
  const prevCwd = process.cwd();
  process.chdir(botRoot);
  const results = await runConversationBenchmark(botRoot, opsDirOrRoot, {
    realGemini,
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel
  });
  process.chdir(prevCwd);
  console.log(JSON.stringify({ botRoot, opsDirOrRoot, realGemini, geminiModel, results, passed: results.filter(r => r.pass).length, total: results.length }, null, 2));
}
