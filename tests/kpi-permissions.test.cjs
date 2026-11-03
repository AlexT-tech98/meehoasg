'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const sourcePath = path.join(__dirname, '../supabase/functions/meehoasg-api-core/index.js');
const source = fs.readFileSync(sourcePath, 'utf8').replace(/^import .*\n/gm, '');

function createHarness(user) {
  const token = 'b1'.repeat(32);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const month = '2026-10';

  const users = [
    { username: 'admin', display_name: 'Meehoa Admin', role: 'ADMIN', active: true },
    { username: 'cmui', display_name: 'C Mụi', role: 'SALE', active: true },
    { username: 'huynhxuyen', display_name: 'Huỳnh Xuyến', role: 'SALE', active: true },
    { username: 'tien', display_name: 'Minh Tiên', role: 'SALE', active: true },
    { username: 'tho_ops', display_name: 'Thợ OPS', role: 'THO_OPS', active: true }
  ];

  const orders = [
    { sale: 'C Mụi', flower_total: 10000000, settled: true, full_paid: false },
    { sale: 'Huỳnh Xuyến', flower_total: 8000000, settled: true, full_paid: false },
    { sale: 'Minh Tiên', flower_total: 6000000, settled: false, full_paid: true },
  ];

  const context = {
    URL, TextEncoder, Request, Response, Date, Intl, crypto: webcrypto,
    console: { error() {}, warn() {}, log() {} },
    Deno: {
      env: {
        get: (k) => {
          if (k === 'SUPABASE_URL') return 'https://test.supabase.co';
          if (k === 'SUPABASE_SERVICE_ROLE_KEY') return 'test-key';
          if (k === 'GEMINI_MODEL') return 'gemini-2.5-flash';
          return '';
        }
      },
      serve: () => {}
    },
    fetch: async (url) => {
      const u = new URL(url);
      const path = u.pathname;
      if (path.includes('app_sessions')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([{ username: user.username, expires_at: new Date(Date.now() + 86400000).toISOString() }])
        };
      }
      if (path.includes('app_users')) {
        const usernameQuery = u.searchParams.get('username');
        if (usernameQuery && usernameQuery.startsWith('eq.')) {
          const target = usernameQuery.slice(3);
          const found = users.filter(x => x.username === target);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(found)
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(users)
        };
      }
      if (path.includes('orders')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(orders)
        };
      }
      if (path.includes('kpi_operations')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([])
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([])
      };
    },
    createOperationStorage: () => ({ uploadImages: async () => [], discard: async () => {} }),
    createOperationService: () => ({ run: async () => ({ ok: true }) })
  };

  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, token, month };
}

test('KPI Permissions: SALE (huynhxuyen) can see other sales but CANNOT see C Mụi', async () => {
  const { context, token, month } = createHarness({ username: 'huynhxuyen', role: 'SALE' });
  const result = await vm.runInContext(`fastKpi({ token: '${token}', month: '${month}' })`, context);
  assert.equal(result.ok, true);
  const salesVisible = result.items.map(x => x.sale);
  assert.ok(salesVisible.includes('Huỳnh Xuyến'), 'Must see own KPI');
  assert.ok(salesVisible.includes('Minh Tiên'), 'Must see other sale KPI (Minh Tiên)');
  assert.ok(!salesVisible.includes('C Mụi'), 'MUST NOT see C Mụi KPI');
});

test('KPI Permissions: C Mụi can see herself and all other sales', async () => {
  const { context, token, month } = createHarness({ username: 'cmui', role: 'SALE' });
  const result = await vm.runInContext(`fastKpi({ token: '${token}', month: '${month}' })`, context);
  assert.equal(result.ok, true);
  const salesVisible = result.items.map(x => x.sale);
  assert.ok(salesVisible.includes('C Mụi'), 'C Mụi must see herself');
  assert.ok(salesVisible.includes('Huỳnh Xuyến'), 'C Mụi must see Huỳnh Xuyến');
  assert.ok(salesVisible.includes('Minh Tiên'), 'C Mụi must see Minh Tiên');
});

test('KPI Permissions: ADMIN can see C Mụi and all other sales', async () => {
  const { context, token, month } = createHarness({ username: 'admin', role: 'ADMIN' });
  const result = await vm.runInContext(`fastKpi({ token: '${token}', month: '${month}' })`, context);
  assert.equal(result.ok, true);
  const salesVisible = result.items.map(x => x.sale);
  assert.ok(salesVisible.includes('C Mụi'), 'Admin must see C Mụi');
  assert.ok(salesVisible.includes('Huỳnh Xuyến'), 'Admin must see Huỳnh Xuyến');
  assert.ok(salesVisible.includes('Minh Tiên'), 'Admin must see Minh Tiên');
});

test('KPI Permissions: THO_OPS can see all sales but CANNOT see C Mụi', async () => {
  const { context, token, month } = createHarness({ username: 'tho_ops', role: 'THO_OPS' });
  const result = await vm.runInContext(`fastKpi({ token: '${token}', month: '${month}' })`, context);
  assert.equal(result.ok, true);
  const salesVisible = result.items.map(x => x.sale);
  assert.ok(salesVisible.includes('Huỳnh Xuyến'), 'Tho_OPS can see Huỳnh Xuyến');
  assert.ok(salesVisible.includes('Minh Tiên'), 'Tho_OPS can see Minh Tiên');
  assert.ok(!salesVisible.includes('C Mụi'), 'Tho_OPS MUST NOT see C Mụi');
});

test('KPI Permissions: Non-admin users cannot call saveKpiOperation', async () => {
  const legacySource = fs.readFileSync('supabase/functions/meehoasg-api/index.js', 'utf8').replace(/^import .*\n/gm, '');
  const { token } = createHarness({ username: 'huynhxuyen', role: 'SALE' });
  const freshContext = {
    URL, TextEncoder, Request, Response, Date, Intl, crypto: webcrypto,
    console: { error() {}, warn() {}, log() {} },
    Deno: { env: { get: () => 'https://test.supabase.co' }, serve: () => {} },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ username: 'huynhxuyen', display_name: 'Huỳnh Xuyến', role: 'SALE', active: true }]) }),
    all: async () => [{ username: 'huynhxuyen', display_name: 'Huỳnh Xuyến', role: 'SALE', active: true }],
    one: async (table) => {
      if (table === 'app_sessions') return { username: 'huynhxuyen', expires_at: new Date(Date.now() + 86400000).toISOString() };
      if (table === 'app_users') return { username: 'huynhxuyen', display_name: 'Huỳnh Xuyến', role: 'SALE', active: true };
      return null;
    },
    db: async () => ({ rows: [] }),
    createOperationStorage: () => ({ uploadImages: async () => [], discard: async () => {} }),
    createOperationService: () => ({ run: async () => ({ ok: true }) })
  };
  vm.createContext(freshContext);
  vm.runInContext(legacySource, freshContext);
  await assert.rejects(
    async () => vm.runInContext(`dispatch('saveKpiOperation', { token: '${token}', month: '2026-10', saleName: 'Huỳnh Xuyến', points: 5 })`, freshContext),
    /Không có quyền/i
  );
});
