import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_ORDER_VALIDATION_RULES,
  buildOrderRules,
  loadOrderRules,
  extractDepositPaymentAmount,
  validateOrderRulesServer
} from '../runtime/order-rules.js';

// ─── buildOrderRules ───────────────────────────────────────────

describe('buildOrderRules', () => {
  it('returns base rules with defaults when no overrides', () => {
    const r = buildOrderRules();
    assert.equal(r.saleDefault, 'cmui');
    assert.equal(r.saleDefaultName, 'C Mụi');
    assert.equal(r.requireFlowerTotal, true);
    assert.equal(r.minDepositRatio, 0.5);
    assert.ok(r.required.includes('flowerTotal'));
    assert.ok(!r.required.includes('phone'));
    assert.equal(r.source, 'default');
  });

  it('adds phone to required when phoneRequired=true', () => {
    const r = buildOrderRules({ phoneRequired: true });
    assert.ok(r.required.includes('phone'));
    assert.ok(r.phoneRequired);
    assert.match(r.schemaVersion, /phone/);
  });

  it('also accepts snake_case phone_required', () => {
    const r = buildOrderRules({ phone_required: true });
    assert.ok(r.required.includes('phone'));
  });

  it('clamps minDepositRatio to [0,1]', () => {
    assert.equal(buildOrderRules({ minDepositRatio: 1.5 }).minDepositRatio, 0.5);
    assert.equal(buildOrderRules({ minDepositRatio: -0.1 }).minDepositRatio, 0.5);
    assert.equal(buildOrderRules({ minDepositRatio: 'abc' }).minDepositRatio, 0.5);
    assert.equal(buildOrderRules({ minDepositRatio: 0.7 }).minDepositRatio, 0.7);
    assert.equal(buildOrderRules({ minDepositRatio: 0 }).minDepositRatio, 0);
  });

  it('allows disabling flowerTotal requirement', () => {
    const r = buildOrderRules({ requireFlowerTotal: false });
    assert.equal(r.requireFlowerTotal, false);
    assert.ok(!r.required.includes('flowerTotal'));
  });
});

// ─── loadOrderRules ────────────────────────────────────────────

describe('loadOrderRules', () => {
  it('falls back to base rules when DB binding is null', async () => {
    const r = await loadOrderRules(null, {});
    assert.equal(r.saleDefault, 'cmui');
    assert.equal(r.requireFlowerTotal, true);
    assert.equal(r.source, 'default');
  });

  it('reads phone_required from D1 sync_config', async () => {
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ data: JSON.stringify({ phone_required: true }) })
        })
      })
    };
    const r = await loadOrderRules(fakeDb, {});
    assert.ok(r.required.includes('phone'));
    assert.equal(r.source, 'd1:sync_config/order_rules');
  });

  it('reads min_deposit_ratio from D1 sync_config', async () => {
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ data: JSON.stringify({ min_deposit_ratio: 0.6 }) })
        })
      })
    };
    const r = await loadOrderRules(fakeDb, {});
    assert.equal(r.minDepositRatio, 0.6);
  });

  it('falls back to env OPS_PHONE_REQUIRED when D1 fails', async () => {
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => { throw new Error('DB unavailable'); }
        })
      })
    };
    const r = await loadOrderRules(fakeDb, { OPS_PHONE_REQUIRED: '1' });
    assert.ok(r.required.includes('phone'));
  });

  it('falls back cleanly when sync_config has no order_rules row', async () => {
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => null
        })
      })
    };
    const r = await loadOrderRules(fakeDb, {});
    assert.equal(r.requireFlowerTotal, true);
    assert.equal(r.saleDefault, 'cmui');
  });
});

// ─── extractDepositPaymentAmount ───────────────────────────────

describe('extractDepositPaymentAmount', () => {
  it('extracts deposit in Vietnamese text', () => {
    assert.equal(extractDepositPaymentAmount('Cọc 200k'), 200000);
    assert.equal(extractDepositPaymentAmount('cọc 200.000'), 200000);
    assert.equal(extractDepositPaymentAmount('đã cọc 150k'), 150000);
    assert.equal(extractDepositPaymentAmount('Đã thanh toán 300k'), 300000);
    assert.equal(extractDepositPaymentAmount('coc 1tr'), 1000000);
    assert.equal(extractDepositPaymentAmount('Đã thanh toán 1,5tr'), 1500000);
  });

  it('returns null for full payment text', () => {
    assert.equal(extractDepositPaymentAmount('Full Paid'), null);
    assert.equal(extractDepositPaymentAmount('Đã TT'), null);
    assert.equal(extractDepositPaymentAmount('Thanh toán đủ'), null);
    assert.equal(extractDepositPaymentAmount('Chưa thanh toán'), null);
  });

  it('returns null for empty / no deposit keyword', () => {
    assert.equal(extractDepositPaymentAmount(''), null);
    assert.equal(extractDepositPaymentAmount(null), null);
    assert.equal(extractDepositPaymentAmount('200k'), null); // no coc/da thanh toan keyword
  });
});

// ─── validateOrderRulesServer ──────────────────────────────────

describe('validateOrderRulesServer', () => {
  const baseRules = buildOrderRules();

  it('rejects flowerTotal = 0', () => {
    assert.throws(
      () => validateOrderRulesServer({ flower_total: 0, payment: 'Chưa thanh toán' }, baseRules),
      { code: 'FLOWER_TOTAL_REQUIRED' }
    );
  });

  it('rejects flowerTotal = -100', () => {
    assert.throws(
      () => validateOrderRulesServer({ flower_total: -100 }, baseRules),
      { code: 'FLOWER_TOTAL_REQUIRED' }
    );
  });

  it('rejects missing flowerTotal (undefined)', () => {
    assert.throws(
      () => validateOrderRulesServer({}, baseRules),
      { code: 'FLOWER_TOTAL_REQUIRED' }
    );
  });

  it('accepts flowerTotal >= 1', () => {
    assert.doesNotThrow(
      () => validateOrderRulesServer({ flower_total: 350000, payment: 'Chưa thanh toán' }, baseRules)
    );
  });

  it('rejects deposit below 50% of flowerTotal', () => {
    // 350k flower, 100k deposit → 28.6% < 50%
    assert.throws(
      () => validateOrderRulesServer({ flower_total: 350000, payment: 'Cọc 100k' }, baseRules),
      { code: 'DEPOSIT_BELOW_MIN_RATIO' }
    );
  });

  it('accepts deposit exactly 50% of flowerTotal', () => {
    // 400k flower, 200k deposit → exactly 50%
    assert.doesNotThrow(
      () => validateOrderRulesServer({ flower_total: 400000, payment: 'Cọc 200k' }, baseRules)
    );
  });

  it('accepts deposit above 50% of flowerTotal', () => {
    // 350k flower, 200k deposit → 57.1% > 50%
    assert.doesNotThrow(
      () => validateOrderRulesServer({ flower_total: 350000, payment: 'Cọc 200k' }, baseRules)
    );
  });

  it('deposit threshold ignores shipFee (computed on flowerTotal only)', () => {
    // flower_total=200k, shipFee=200k (total 400k), deposit 100k 
    // 100k / 200k = 50% → passes (threshold is on flowerTotal, not total)
    assert.doesNotThrow(
      () => validateOrderRulesServer({
        flower_total: 200000,
        ship_fee: 200000,
        payment: 'Cọc 100k'
      }, baseRules)
    );
  });

  it('allows orders without deposit keyword (Chưa thanh toán)', () => {
    assert.doesNotThrow(
      () => validateOrderRulesServer({ flower_total: 350000, payment: 'Chưa thanh toán' }, baseRules)
    );
  });

  it('allows orders with Full Paid', () => {
    assert.doesNotThrow(
      () => validateOrderRulesServer({ flower_total: 350000, payment: 'Full Paid' }, baseRules)
    );
  });

  it('rejects missing phone when rules require it', () => {
    const phoneRules = buildOrderRules({ phoneRequired: true });
    assert.throws(
      () => validateOrderRulesServer({ flower_total: 350000, payment: 'Chưa thanh toán' }, phoneRules),
      { code: 'PHONE_REQUIRED' }
    );
  });

  it('accepts phone when provided and required', () => {
    const phoneRules = buildOrderRules({ phoneRequired: true });
    assert.doesNotThrow(
      () => validateOrderRulesServer({
        flower_total: 350000,
        phone: '0394200327',
        payment: 'Chưa thanh toán'
      }, phoneRules)
    );
  });

  it('skips flowerTotal check when requireFlowerTotal is false', () => {
    const r = buildOrderRules({ requireFlowerTotal: false });
    assert.doesNotThrow(
      () => validateOrderRulesServer({ flower_total: 0 }, r)
    );
  });
});

// ─── Form + Bot read same loadOrderRules source ────────────────

describe('Form ↔ Bot ↔ createOrder read same loadOrderRules', () => {
  it('Form getOrderRules calls loadOrderRules (confirmed by HTML containing getOrderRules route)', async () => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(new URL('../dist/html', import.meta.url), 'utf8');
    assert.ok(html.includes('getOrderRules'), 'dist/html must call getOrderRules');
    assert.ok(html.includes('S.options.rules'), 'dist/html must store rules in S.options.rules');
    assert.ok(html.includes('applyRulesToOrderForm'), 'dist/html must apply rules to form');
    assert.ok(
      html.includes('form.querySelector(\'[name="phone"]\')'),
      'applyRulesToOrderForm must match [name="phone"] (supports textarea upgraded by meehoa-core.js)'
    );
  });

  it('core.js routes getOrderRules (confirmed by entry)', async () => {
    const { readFile } = await import('node:fs/promises');
    const core = await readFile(new URL('../runtime/core.js', import.meta.url), 'utf8');
    assert.ok(core.includes('getOrderRules'), 'core.js must handle getOrderRules action');
    assert.ok(core.includes('loadOrderRules'), 'core.js must call loadOrderRules');
  });

  it('operation-service.js calls validateOrderRulesServer before mutate', async () => {
    const { readFile } = await import('node:fs/promises');
    const svc = await readFile(new URL('../runtime/operation-service.js', import.meta.url), 'utf8');
    assert.ok(svc.includes('validateOrderRulesServer'), 'operation-service.js must validate rules');
  });

  it('operations.js re-validates inside DB transaction', async () => {
    const { readFile } = await import('node:fs/promises');
    const ops = await readFile(new URL('../runtime/operations.js', import.meta.url), 'utf8');
    assert.ok(ops.includes('validateOrderRulesServer'), 'operations.js must validate in transaction');
  });
});

// ─── End-to-end Direct API (bypassing Bot) + Form-vs-Bot Parity ──

async function createCoreHarness() {
  const { DatabaseSync } = await import('node:sqlite');
  const { existsSync, readFileSync } = await import('node:fs');
  const { createCore } = await import('../runtime/core.js');

  const sqlite = new DatabaseSync(':memory:');
  const schemaUrl = existsSync(new URL('../schema/schema.sql', import.meta.url))
    ? new URL('../schema/schema.sql', import.meta.url)
    : new URL('../generated/schema.sql', import.meta.url);
  sqlite.exec(readFileSync(schemaUrl, 'utf8'));

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
      try {
        const out = [];
        for (const s of stmts || []) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    }
  };

  const objects = new Map();
  const r2 = {
    objects,
    async put(key, value, opts) {
      const buf = value instanceof ArrayBuffer ? new Uint8Array(value) : (value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));
      objects.set(key, { body: buf, httpMetadata: opts?.httpMetadata || {} });
      return { key };
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { key, body: o.body, httpMetadata: o.httpMetadata, async arrayBuffer() { return o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength); } };
    },
    async head(key) { const o = objects.get(key); return o ? { key, size: o.body.length } : null; },
    async delete(key) { objects.delete(key); }
  };

  const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const adminToken = '1'.repeat(64);
  const cmuiToken = '2'.repeat(64);
  const otherSaleToken = '3'.repeat(64);

  for (const [user, tok] of [
    [{ username: 'admin', display_name: 'Admin', role: 'ADMIN', active: true }, adminToken],
    [{ username: 'cmui', display_name: 'C Mụi', role: 'SALE', active: true }, cmuiToken],
    [{ username: 'sale2', display_name: 'Sale Hai', role: 'SALE', active: true }, otherSaleToken]
  ]) {
    await db.prepare('INSERT INTO app_users(row_key, data) VALUES (?, ?)').bind(user.username, JSON.stringify(user)).run();
    const h = await sha(tok);
    await db.prepare('INSERT INTO app_sessions(row_key, data) VALUES (?, ?)').bind(h, JSON.stringify({ token_hash: h, username: user.username, expires_at: '2099-12-31T23:59:59.000Z' })).run();
  }

  const handler = createCore({ DB: db, MEDIA_R2: r2, MEDIA_SIGNING_KEY: 'test-key', LEGACY_PASSWORD_SALT: 'MEE-FLOWER-V4' });
  const call = async (token, name, payload = {}) => {
    const res = await handler(new Request('https://meehoasg-ops-staging.meehoasg.workers.dev/api-core', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, payload: { token, ...payload } })
    }));
    return res.json();
  };

  return { db, r2, adminToken, cmuiToken, otherSaleToken, call };
}

const TINY_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

describe('Direct OPS API enforcement (bypassing Bot) & Form-vs-Bot parity', () => {
  it('blocks direct createOrder/updateOrder on flowerTotal=0 and deposit<50% (excluding ship & accessories); allows exact 50% and keeps Full Paid bill requirement', async () => {
    const { adminToken, call } = await createCoreHarness();

    // 1. Direct API createOrder with flowerTotal = 0 -> blocked
    const zeroRes = await call(adminToken, 'createOrder', {
      requestId: 'req-direct-zero',
      order: {
        customer: 'Direct Zero', flower: 'Bó hồng', date: '2026-12-27', time: '10:00',
        shipping: 'Ghé lấy', flowerTotal: 0, payment: 'Chưa thanh toán', sale: 'cmui',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });
    assert.equal(zeroRes.ok, false);
    assert.equal(zeroRes.code, 'FLOWER_TOTAL_REQUIRED');

    // 2. Direct API createOrder with deposit < 50% of flowerTotal even when shipFee & card are present -> blocked
    // flowerTotal = 400k, shipFee = 200k, card = true (10k), deposit = 199k (< 200k = 50% of 400k)
    const lowDepRes = await call(adminToken, 'createOrder', {
      requestId: 'req-direct-low-dep',
      order: {
        customer: 'Direct Low Dep', flower: 'Bó hồng', date: '2026-12-27', time: '10:00',
        shipping: 'Shop book ship', address: '123 Lê Lợi', shipFee: 200000, shipFeeActive: '1',
        card: true, cardQty: 1, cardText: 'Chúc mừng',
        flowerTotal: 400000, payment: 'Đã cọc 199.000 đ', sale: 'cmui',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });
    assert.equal(lowDepRes.ok, false);
    assert.equal(lowDepRes.code, 'DEPOSIT_BELOW_MIN_RATIO');

    // 3. Exact 50% of flowerTotal (200k on 400k flower, ignoring 200k ship + 10k card) -> PASSES
    const exact50Res = await call(adminToken, 'createOrder', {
      requestId: 'req-direct-exact-50',
      order: {
        customer: 'Direct Exact 50', flower: 'Bó hồng', date: '2026-12-27', time: '10:00',
        shipping: 'Shop book ship', address: '123 Lê Lợi', shipFee: 200000, shipFeeActive: '1',
        card: true, cardQty: 1, cardText: 'Chúc mừng',
        flowerTotal: 400000, payment: 'Đã cọc 200.000 đ', sale: 'cmui',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });
    assert.equal(exact50Res.ok, true);
    assert.equal(exact50Res.order.paid, 200000);
    assert.equal(exact50Res.order.saleUsername, 'cmui');

    // 4. Direct API updateOrder trying to lower deposit below 50% (like a forged /retry_payment) -> BLOCKED
    const badUpdateRes = await call(adminToken, 'updateOrder', {
      requestId: 'req-direct-bad-upd',
      orderId: exact50Res.orderId,
      expectedUpdatedAt: exact50Res.order.updatedAt,
      order: {
        customer: 'Direct Exact 50', flower: 'Bó hồng', date: '2026-12-27', time: '10:00',
        shipping: 'Shop book ship', address: '123 Lê Lợi', shipFee: 200000, shipFeeActive: '1',
        card: true, cardQty: 1, cardText: 'Chúc mừng',
        flowerTotal: 400000, payment: 'Đã cọc 150.000 đ', sale: 'cmui'
      }
    });
    assert.equal(badUpdateRes.ok, false);
    assert.equal(badUpdateRes.code, 'DEPOSIT_BELOW_MIN_RATIO');

    // 5. Full Paid without bill still rejected by OPS (bill workflow preserved)
    const noBillFullPaid = await call(adminToken, 'updateOrder', {
      requestId: 'req-direct-fullpaid-nobill',
      orderId: exact50Res.orderId,
      expectedUpdatedAt: exact50Res.order.updatedAt,
      order: {
        customer: 'Direct Exact 50', flower: 'Bó hồng', date: '2026-12-27', time: '10:00',
        shipping: 'Shop book ship', address: '123 Lê Lợi', shipFee: 200000, shipFeeActive: '1',
        card: true, cardQty: 1, cardText: 'Chúc mừng',
        flowerTotal: 400000, payment: 'Đã thanh toán toàn bộ đơn', sale: 'cmui',
        fullPaidRequested: true
      }
    });
    assert.equal(noBillFullPaid.ok, false);
    assert.equal(noBillFullPaid.code, 'FULL_PAID_EVIDENCE_REQUIRED');
  });

  it('toggles phone_required via D1 sync_config: getOrderRules & direct createOrder enforce it live, then restores cleanly', async () => {
    const { db, adminToken, otherSaleToken, call } = await createCoreHarness();

    // Check callerCanAssignDefaultSale for ADMIN vs other SALE
    const rulesAdmin = await call(adminToken, 'getOrderRules');
    assert.equal(rulesAdmin.ok, true);
    assert.equal(rulesAdmin.rules.phoneRequired, false);
    assert.equal(rulesAdmin.caller.canAssignDefaultSale, true);

    const rulesOtherSale = await call(otherSaleToken, 'getOrderRules');
    assert.equal(rulesOtherSale.ok, true);
    assert.equal(rulesOtherSale.caller.canAssignDefaultSale, false);

    // Enable phone_required in D1 sync_config
    await db.prepare('INSERT OR REPLACE INTO sync_config(row_key, data) VALUES (?, ?)')
      .bind('order_rules', JSON.stringify({ phone_required: true }))
      .run();

    const rulesOn = await call(adminToken, 'getOrderRules');
    assert.equal(rulesOn.rules.phoneRequired, true);
    assert.ok(rulesOn.rules.required.includes('phone'));

    // Direct API createOrder without phone -> BLOCKED
    const blocked = await call(adminToken, 'createOrder', {
      requestId: 'req-phone-blocked',
      order: {
        customer: 'No Phone', flower: 'Bó hồng', date: '2026-12-28', time: '10:00',
        shipping: 'Ghé lấy', flowerTotal: 350000, payment: 'Chưa thanh toán', sale: 'cmui'
      },
      files: [{ data: TINY_JPEG_DATA_URL }]
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'PHONE_REQUIRED');

    // Restore sync_config -> createOrder without phone succeeds again
    await db.prepare('DELETE FROM sync_config WHERE row_key = ?').bind('order_rules').run();
    const rulesOff = await call(adminToken, 'getOrderRules');
    assert.equal(rulesOff.rules.phoneRequired, false);

    const allowed = await call(adminToken, 'createOrder', {
      requestId: 'req-phone-restored',
      order: {
        customer: 'No Phone Restored', flower: 'Bó hồng', date: '2026-12-28', time: '10:00',
        shipping: 'Ghé lấy', flowerTotal: 350000, payment: 'Chưa thanh toán', sale: 'cmui'
      },
      files: [{ data: TINY_JPEG_DATA_URL }]
    });
    assert.equal(allowed.ok, true);
  });

  it('paired Form-payload vs Bot-payload orders produce identical sale (cmui), permissions, paid/debt, Dashboard, DebtReview, and KPI', async () => {
    const { adminToken, cmuiToken, otherSaleToken, call } = await createCoreHarness();

    // Form sends display name "C Mụi", Bot sends username "cmui" — both with 350k flower & 200k deposit
    const formOrder = await call(adminToken, 'createOrder', {
      requestId: 'req-pair-form',
      order: {
        customer: 'Khách Đối Chiếu Form', phone: '0394200327', flower: 'Bó hồng pastel',
        date: '2026-12-29', time: '13:30', shipping: 'Ghé lấy',
        flowerTotal: 350000, payment: 'Đã cọc 200.000 đ', sale: 'C Mụi',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });
    const botOrder = await call(adminToken, 'createOrder', {
      requestId: 'req-pair-bot',
      order: {
        customer: 'Khách Đối Chiếu Bot', phone: '0394200327', flower: 'Bó hồng pastel',
        date: '2026-12-29', time: '13:30', shipping: 'Ghé lấy',
        flowerTotal: 350000, payment: 'Đã cọc 200.000 đ', sale: 'cmui',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });

    assert.equal(formOrder.ok, true);
    assert.equal(botOrder.ok, true);

    // 1. Canonical sale & payment parity
    for (const o of [formOrder.order, botOrder.order]) {
      assert.equal(o.saleUsername, 'cmui');
      assert.equal(o.sale, 'C Mụi');
      assert.equal(o.flowerTotal, 350000);
      assert.equal(o.paid, 200000);
      assert.equal(o.debt, 150000);
      assert.equal(o.paymentVerified, false);
    }

    // 2. Permissions parity: cmui can edit both; sale2 cannot edit either
    const cmuiFormView = await call(cmuiToken, 'getOrder', { orderId: formOrder.orderId });
    const cmuiBotView = await call(cmuiToken, 'getOrder', { orderId: botOrder.orderId });
    const sale2FormView = await call(otherSaleToken, 'getOrder', { orderId: formOrder.orderId });
    const sale2BotView = await call(otherSaleToken, 'getOrder', { orderId: botOrder.orderId });
    assert.equal(cmuiFormView.order.canEdit, true);
    assert.equal(cmuiBotView.order.canEdit, true);
    assert.equal(sale2FormView.order.canEdit, false);
    assert.equal(sale2BotView.order.canEdit, false);

    // 3. Dashboard summary sees both orders equally (total 700k, debt 300k, single cmui bucket)
    const dash = await call(adminToken, 'getDashboardSummary', { start: '2026-12-29', end: '2026-12-29' });
    assert.equal(dash.ok, true);
    assert.equal(dash.summary.orders, 2);
    assert.equal(dash.summary.grossRevenue, 700000);
    assert.equal(dash.summary.debt, 300000);
    assert.equal(dash.salesDaily.length, 1);
    assert.equal(dash.salesDaily[0].saleUsername, 'cmui');
    assert.equal(dash.salesDaily[0].orders, 2);

    // 4. Move both orders to Đã giao -> DebtReview shows both identically for cmui and 0 for sale2
    for (const ord of [formOrder, botOrder]) {
      const s1 = await call(adminToken, 'updateStatus', {
        requestId: `req-st1-${ord.orderId}`, orderId: ord.orderId, expectedUpdatedAt: ord.order.updatedAt, status: 'Đã bó'
      });
      assert.equal(s1.ok, true);
      const s2 = await call(adminToken, 'updateStatus', {
        requestId: `req-st2-${ord.orderId}`, orderId: ord.orderId, expectedUpdatedAt: s1.order.updatedAt, status: 'Đã giao'
      });
      assert.equal(s2.ok, true);
    }

    const debtCmui = await call(cmuiToken, 'getDebtReview', { start: '2026-12-29', end: '2026-12-29' });
    const debtSale2 = await call(otherSaleToken, 'getDebtReview', { start: '2026-12-29', end: '2026-12-29' });
    assert.equal(debtCmui.summary.orders, 2);
    assert.equal(debtCmui.summary.debt, 300000);
    assert.equal(debtSale2.summary.orders, 0);

    // 5. Mark both Full Paid with bill -> KPI attributes both orders (700k) to cmui
    for (const id of [formOrder.orderId, botOrder.orderId]) {
      const cur = (await call(adminToken, 'getOrder', { orderId: id })).order;
      const fp = await call(adminToken, 'updateOrder', {
        requestId: `req-fp-${id}`, orderId: id, expectedUpdatedAt: cur.updatedAt,
        order: {
          customer: cur.customer, phone: cur.phone, flower: cur.flower,
          date: cur.date, time: cur.time, shipping: cur.shipping,
          flowerTotal: cur.flowerTotal, payment: 'Đã thanh toán toàn bộ đơn', sale: cur.saleUsername,
          fullPaidRequested: true,
          fullPaidBillFiles: [{ data: TINY_JPEG_DATA_URL }]
        }
      });
      assert.equal(fp.ok, true);
      assert.equal(fp.order.fullPaid, true);
      assert.equal(fp.order.debt, 0);
    }

    const kpi = await call(adminToken, 'getKpi', { month: '2026-12' });
    const cmuiKpi = kpi.items.find(x => x.username === 'cmui');
    assert.ok(cmuiKpi);
    assert.equal(cmuiKpi.orders, 2);
    assert.equal(cmuiKpi.revenue, 700000);
  });

  it('calculates accessories as unit price × qty (cardQty × 10k, bannerQty × 35k) across qty=1 and qty>1', async () => {
    const { adminToken, call } = await createCoreHarness();

    const oneRes = await call(adminToken, 'createOrder', {
      requestId: 'req-acc-one',
      order: {
        customer: 'Khách PK 1', flower: 'Bó hồng', date: '2026-12-29', time: '14:00',
        shipping: 'Ghé lấy', flowerTotal: 500000, payment: 'Đã cọc 250.000 đ', sale: 'cmui',
        card: true, cardQty: 1, cardText: 'Chúc mừng 1',
        banner: true, bannerQty: 1, bannerText: 'Banner 1',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });
    assert.equal(oneRes.ok, true);
    assert.equal(oneRes.order.cardQty, 1);
    assert.equal(oneRes.order.cardFee, 10000);
    assert.equal(oneRes.order.bannerQty, 1);
    assert.equal(oneRes.order.bannerFee, 35000);
    assert.equal(oneRes.order.accessoryTotal, 45000);
    assert.equal(oneRes.order.totalDue, 545000);
    assert.equal(oneRes.order.debt, 295000);

    const multiRes = await call(adminToken, 'createOrder', {
      requestId: 'req-acc-multi',
      order: {
        customer: 'Khách PK Nhiều', flower: 'Kệ chúc mừng', date: '2026-12-29', time: '15:00',
        shipping: 'Ghé lấy', flowerTotal: 500000, payment: 'Đã cọc 250.000 đ', sale: 'cmui',
        card: true, cardQty: 3, cardText: 'Chúc mừng 3',
        banner: true, bannerQty: 2, bannerText: 'Banner 2 cái',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });
    assert.equal(multiRes.ok, true);
    assert.equal(multiRes.order.cardQty, 3);
    assert.equal(multiRes.order.cardFee, 30000);
    assert.equal(multiRes.order.bannerQty, 2);
    assert.equal(multiRes.order.bannerFee, 70000);
    assert.equal(multiRes.order.accessoryTotal, 100000);
    assert.equal(multiRes.order.totalDue, 600000);
    assert.equal(multiRes.order.debt, 350000);
  });

  it('handles Shop book ship without shipFee (unconfirmed=false), explicit shipFee (confirmed=true), and missing address (allowed)', async () => {
    const { adminToken, call } = await createCoreHarness();

    const noShipNoAddr = await call(adminToken, 'createOrder', {
      requestId: 'req-shop-noship-noaddr',
      order: {
        customer: 'Shop No Ship No Addr', flower: 'Giỏ hoa', date: '2026-12-29', time: '16:00',
        shipping: 'Shop book ship', address: '',
        flowerTotal: 400000, payment: 'Đã cọc 200.000 đ', sale: 'cmui',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });
    assert.equal(noShipNoAddr.ok, true);
    assert.equal(noShipNoAddr.order.address, '');
    assert.equal(noShipNoAddr.order.shipFee, 0);
    assert.equal(noShipNoAddr.order.shipConfirmed, false);
    assert.equal(noShipNoAddr.order.shipFeePending, true);
    assert.equal(noShipNoAddr.order.totalDue, 400000);

    const withShip = await call(adminToken, 'createOrder', {
      requestId: 'req-shop-withship',
      order: {
        customer: 'Shop With Ship', flower: 'Giỏ hoa', date: '2026-12-29', time: '17:00',
        shipping: 'Shop book ship', address: '88 Võ Văn Tần, Quận 3',
        shipFee: 45000, shipFeeActive: '1',
        flowerTotal: 400000, payment: 'Đã cọc 200.000 đ', sale: 'cmui',
        imageFiles: [{ data: TINY_JPEG_DATA_URL }]
      }
    });
    assert.equal(withShip.ok, true);
    assert.equal(withShip.order.shipFee, 45000);
    assert.equal(withShip.order.shipConfirmed, true);
    assert.equal(withShip.order.shipFeePending, false);
    assert.equal(withShip.order.totalDue, 445000);
    assert.equal(withShip.order.debt, 245000);
  });
});
