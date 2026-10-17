const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'html'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'assets/meehoa-v366.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'assets/meehoa-core.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function between(haystack, start, end) {
  const from = haystack.indexOf(start);
  assert.notEqual(from, -1, 'Missing ' + start);
  const to = haystack.indexOf(end, from + start.length);
  assert.notEqual(to, -1, 'Missing ' + end);
  return haystack.slice(from, to);
}

test('a late drawer fetch may refresh its drawer but cannot replace the edit form', async () => {
  const src = between(html, 'function openDrawer(id,context)', '\n    function renderDrawer');
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const S = { page: 'orders', currentDrawer: '' };
  let view = 'drawer';
  const overlay = {
    querySelector(selector) {
      if (selector === '.drawer') return view === 'drawer' ? {} : null;
      if (selector === '#orderForm') return view === 'form' ? {} : null;
      return null;
    }
  };
  const openDrawer = new Function('S', 'orderById', 'renderDrawer', 'ensureOrderDetail', 'document', 'toast',
    src + '\nreturn openDrawer;'
  )(S, () => ({ id: 'MEE-TEST', detailLoaded: false }), (...args) => calls.push(args),
    () => pending, { getElementById: () => overlay }, e => { throw e; });
  openDrawer('MEE-TEST', 'orders');
  assert.equal(calls.length, 1, 'initial drawer');
  view = 'form';
  S.currentDrawer = '';
  finish({ id: 'MEE-TEST', detailLoaded: true });
  await pending;
  await Promise.resolve();
  assert.equal(calls.length, 1, 'the async response did not redraw over the editor');
  assert.match(html, /function openOrderForm\(id\)\{if\(id===void 0\)id='';S\.currentDrawer='';/,
    'opening editor cancels any pending drawer ownership');
});

test('active drawer is allowed to receive its own late detail fetch', async () => {
  const src = between(html, 'function openDrawer(id,context)', '\n    function renderDrawer');
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const S = { page: 'orders', currentDrawer: '' };
  const drawer = new Function('S', 'orderById', 'renderDrawer', 'ensureOrderDetail', 'document', 'toast',
    src + '\nreturn openDrawer;'
  )(S, () => ({ id: 'MEE-TEST', detailLoaded: false }), (...args) => calls.push(args),
    () => pending, { getElementById: () => ({querySelector: s => s === '.drawer' ? {} : null}) },
    e => { throw e; });
  drawer('MEE-TEST');
  finish({ id: 'MEE-TEST', detailLoaded: true });
  await pending; await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], false);
});

test('edit button is distinct from copy, and edit tap routes exactly once', () => {
  assert.match(html, /data-mee-order-action="edit" onclick="MEEOPS7\.openOrderForm/);
  assert.match(html, /data-mee-order-action="copy" onclick="MEEOPS7\.copyOrderById/);
  const src = between(runtime, 'function delegatedEditTap(e)', '\n  function delegatedCopyTap(e)');
  const actions = [];
  const MEEOPS7 = { openOrderForm: id => actions.push('edit:' + id) };
  const handler = new Function('window', 'MEEOPS7', src + '\nreturn delegatedEditTap;')(
    {MEEOPS7}, MEEOPS7
  );
  const edit = { getAttribute: () => "MEEOPS7.openOrderForm('MEE-111623336BDD4D9E')" };
  const ev = {
    target: { closest: selector => selector.includes('data-mee-order-action="edit"') ? edit : null },
    preventDefault: () => actions.push('prevented'),
    stopImmediatePropagation: () => actions.push('stopped')
  };
  handler(ev);
  assert.deepEqual(actions, ['prevented', 'stopped', 'edit:MEE-111623336BDD4D9E']);
  assert.match(runtime, /addEventListener\('click',delegatedEditTap,true\);document\.addEventListener\('click',delegatedCopyTap,true\)/);
});

test('generated core includes the corrected action handler and the mobile boot cache is bumped', () => {
  const chunk = between(core, '/* ===== meehoa-v366.js ===== */\n', '\n/* ===== meehoa-order-actions.js ===== */\n');
  assert.equal(chunk.trim(), runtime.trim(), 'compiled core matches its source owner');
  assert.match(index, /var RELEASE='20261018-order-edit-rc1'/);
  assert.match(index, /meehoa-core\.js\?v=20261018-order-edit-rc1/);
  assert.match(html, /if\(f\.dataset\.saving==='1'\)\{orderFormFeedback/);
});
