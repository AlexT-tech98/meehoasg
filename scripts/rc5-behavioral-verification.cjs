'use strict';

/**
 * RC5 Real-Browser Behavioral Verification Matrix (Section B)
 * Tests ALL 9 viewports (360, 390, 760, 768, 820, 900, 901, 1024, 1440)
 * across ALL 3 roles (ADMIN, SALE, THO_OPS) against the real RC5 frontend bundle.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = '/Users/heymac/.gemini/antigravity/brain/c32c31b9-473c-4550-8a59-c4200fca4145';
const VIEWPORTS = [360, 390, 760, 768, 820, 900, 901, 1024, 1440];
const ROLES = ['ADMIN', 'SALE', 'THO_OPS'];
const TODAY = '2026-11-26';

// Real 1x1 PNG sample & VietQR fixture (avoids network errors while rendering real <img> bounds)
const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

const SAMPLE_ORDERS = [
  {
    id: 'RC5-STD-1', updatedAt: '2026-11-26T01:00:00Z', customer: 'Chị Minh Thư — Mẫu dài RC5',
    phone: '0901234501', date: TODAY, time: '09:00',
    flower: 'Bó Hồng Ecuador đỏ 30 bông mix lá bạc nhập khẩu Hàn Quốc giấy gói đen viền kim tuyến sang trọng',
    note: 'Giao sảnh lễ tân gọi trước 15 phút, ghi đúng tên người nhận và kiểm tra thiệp kèm theo kỹ càng',
    tagNoteFree: 'Chúc mừng sinh nhật thật vui vẻ', orderSource: 'Threads', orderType: 'STANDARD',
    shipping: 'Shop book ship', address: '101 Nguyễn Huệ, P. Bến Nghé, Quận 1, TP.HCM',
    flowerTotal: 850000, payment: 'Đã cọc 300k', paid: 300000, totalDue: 895000, debt: 595000,
    sale: 'Sale An', saleUsername: 'sale1', status: 'Chờ bó', settled: false, fullPaid: false,
    paymentVerified: false, shipFee: 45000, shipConfirmed: true, card: true, cardQty: 1, cardFee: 10000,
    cardText: 'Happy Birthday', banner: false, bannerQty: 0, accessoryTotal: 10000, vat: 0, hasAccessories: true,
    imageUrls: [PNG_DATA], previewUrls: [PNG_DATA], driveUrls: [PNG_DATA],
    canEdit: true, canOperate: true, canShip: true, canDelete: true, canSubmitSettlement: false, detailLoaded: true
  },
  {
    id: 'RC5-FP-2', updatedAt: '2026-11-26T02:00:00Z', customer: 'Anh Quốc Bảo',
    phone: '0901234502', date: TODAY, time: '10:30',
    flower: 'Giỏ Tulip pastel 20 cành kèm phụ kiện đầy đủ',
    note: 'Giao đúng giờ họp', tagNoteFree: '', orderSource: 'Zalo', orderType: 'STANDARD',
    shipping: 'Ghé lấy', address: '',
    flowerTotal: 1200000, payment: 'Đã thanh toán toàn bộ đơn', paid: 1200000, totalDue: 1200000, debt: 0,
    sale: 'Sale An', saleUsername: 'sale1', status: 'Chờ giao', settled: false, fullPaid: true, fullPaidTotal: 1200000,
    paymentVerified: true, shipFee: 0, shipConfirmed: false, card: false, banner: false, accessoryTotal: 0, vat: 0, hasAccessories: false,
    imageUrls: [PNG_DATA], previewUrls: [PNG_DATA], driveUrls: [PNG_DATA],
    canEdit: false, canOperate: true, canShip: false, canDelete: false, canSubmitSettlement: false, detailLoaded: true
  },
  {
    id: 'RC5-WI-3', updatedAt: '2026-11-26T03:00:00Z', customer: 'Khách vãng lai',
    phone: '', date: TODAY, time: '11:15',
    flower: 'Bó hướng dương mua trực tiếp tại tiệm', note: '', tagNoteFree: '',
    orderSource: 'Khách ghé tiệm', orderType: 'WALK_IN', walkInPaymentMethod: 'TRANSFER', createdBy: 'sale1',
    shipping: 'Ghé lấy', address: '',
    flowerTotal: 450000, payment: 'Đã thanh toán 450000 đ (Chuyển khoản - Khách vãng lai)', paid: 450000, totalDue: 450000, debt: 0,
    sale: 'C Mụi', saleUsername: 'cmui', status: 'Đã giao', settled: false, fullPaid: false,
    paymentVerified: false, shipFee: 0, shipConfirmed: false, card: false, banner: false, accessoryTotal: 0, vat: 0, hasAccessories: false,
    imageUrls: [], previewUrls: [], driveUrls: [],
    canEdit: true, canOperate: false, canShip: false, canDelete: true, canSubmitSettlement: false, detailLoaded: true
  },
  {
    id: 'RC5-STD-4', updatedAt: '2026-11-26T04:00:00Z', customer: 'Chị Lan Anh',
    phone: '0909333444', date: TODAY, time: '14:00',
    flower: 'Lẵng hoa khai trương hồng phát', note: 'Gửi hình trước khi giao', tagNoteFree: 'Khai trương hồng phát',
    orderSource: 'Page/IG', orderType: 'STANDARD',
    shipping: 'Khách tự book', address: '12 Hai Bà Trưng, Q1',
    flowerTotal: 1500000, payment: 'Chưa thanh toán', paid: 0, totalDue: 1535000, debt: 1535000,
    sale: 'Sale An', saleUsername: 'sale1', status: 'Chờ lấy', settled: false, fullPaid: false,
    paymentVerified: false, shipFee: 0, shipConfirmed: false, card: false, banner: true, bannerQty: 1, bannerText: 'Chúc Mừng',
    accessoryTotal: 35000, vat: 0, hasAccessories: true,
    imageUrls: [PNG_DATA], previewUrls: [PNG_DATA], driveUrls: [PNG_DATA],
    canEdit: true, canOperate: true, canShip: false, canDelete: true, canSubmitSettlement: false, detailLoaded: true
  }
];

const BUILD = '2026.09.28-supabase-v3';
const LISTING = {
  ok: true, items: SAMPLE_ORDERS, total: SAMPLE_ORDERS.length, scopeTotal: SAMPLE_ORDERS.length,
  counts: { ALL: 4, 'Chờ bó': 1, 'Chờ giao': 1, 'Chờ lấy': 1, 'Đã giao': 1, DEBT: 2 },
  page: 1, pageSize: 80, hasMore: false, range: { start: TODAY, end: TODAY }
};
const PRODUCTION = { ok: true, date: TODAY, orders: SAMPLE_ORDERS.filter((o) => o.orderType !== 'WALK_IN') };
const DASHBOARD = {
  ok: true, range: { start: TODAY, end: TODAY }, hourlyScope: 'SELECTED_RANGE',
  hourlyCounts: [{ hour: 9, count: 1 }, { hour: 10, count: 1 }, { hour: 11, count: 1 }, { hour: 14, count: 1 }], hourlyUnknown: 0,
  summary: {
    orders: 4, revenue: 4000000, grossRevenue: 4000000, walkInOrders: 1, walkInRevenue: 450000,
    walkInTransferUnverifiedRevenue: 450000, settledRevenue: 1200000, unsettledRevenue: 2800000,
    debt: 2130000, cms: 96000, 'Chờ bó': 1, 'Chờ giao': 1, 'Chờ lấy': 1, 'Đã giao': 1
  },
  attention: [], attentionGroups: { nearUnpacked: [], packedOverdue: [] },
  salesDaily: [{ date: TODAY, sale: 'Sale An', saleUsername: 'sale1', orders: 3, settledOrders: 1, unsettledOrders: 2, grossRevenue: 3550000, settledRevenue: 1200000, unsettledRevenue: 2350000 }]
};

const server = http.createServer((req, res) => {
  try {
    let file = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    file = file === '/' ? '/index.html' : file;
    const full = path.resolve(ROOT, '.' + file);
    if (!full.startsWith(ROOT + path.sep) || !fs.existsSync(full)) {
      res.writeHead(404);
      return res.end();
    }
    const type = file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.svg') ? 'image/svg+xml'
      : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(full));
  } catch {
    res.writeHead(404);
    res.end();
  }
});

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.MEEHOA_CHROMIUM ? { executablePath: process.env.MEEHOA_CHROMIUM } : {}),
    args: ['--no-sandbox']
  });

  const matrixReport = [];
  try {
    for (const width of VIEWPORTS) {
      for (const role of ROLES) {
        const height = width <= 420 ? 844 : 900;
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push('pageerror:' + e.message));

        await context.route('**/*', async (route) => {
          const req = route.request();
          const url = new URL(req.url());
          if (url.origin === origin) return route.continue();
          if (url.hostname.endsWith('.supabase.co') && url.pathname.includes('/functions/v1/')) {
            if (req.method() === 'OPTIONS') {
              return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
            }
            const { name, payload = {} } = req.postDataJSON();
            let data;
            if (name === 'loginAndBootstrap' || name === 'getCurrentUserAndBootstrap') {
              const p = role === 'ADMIN' ? 'dashboard' : role === 'THO_OPS' ? 'production' : 'orders';
              data = {
                ok: true, token: 'b'.repeat(64),
                user: { username: 'sale1', name: 'Fixture ' + role, role, active: true },
                options: { sales: ['Sale An', 'C Mụi'], shipping: ['Shop book ship', 'Khách tự book', 'Ghé lấy'], statuses: ['Chờ bó', 'Chờ giao', 'Chờ lấy', 'Đã giao'] },
                initial: { page: p, data: p === 'dashboard' ? DASHBOARD : p === 'production' ? PRODUCTION : LISTING, at: Date.now() }
              };
            } else if (name === 'getOrders') data = LISTING;
            else if (name === 'getProductionOrders') data = PRODUCTION;
            else if (name === 'getDashboardSummary') data = DASHBOARD;
            else if (name === 'getOrder') data = { ok: true, order: SAMPLE_ORDERS.find((o) => o.id === payload.orderId) || SAMPLE_ORDERS[0] };
            else if (name === 'getAppOptions') data = { ok: true, sales: ['Sale An'], shipping: ['Shop book ship', 'Khách tự book', 'Ghé lấy'], statuses: ['Chờ bó', 'Chờ giao', 'Chờ lấy', 'Đã giao'] };
            else data = { ok: true };
            return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ...data, build: BUILD }) });
          }
          if (url.hostname === 'img.vietqr.io') {
            return route.fulfill({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from(PNG_DATA.split(',')[1], 'base64') });
          }
          return route.abort();
        });

        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await page.locator('#loginUser').fill('sale1');
        await page.locator('#loginPass').fill('fixture-pass');
        await page.locator('#loginBtn').click();
        await page.waitForFunction(() => window.S?.user && document.querySelector('#content')?.textContent.length > 20);

        // Navigate explicitly to Orders so ALL 3 roles are tested identically on Orders + topbar + bottom nav
        await page.evaluate(() => MEEOPS7.go('orders'));
        await page.waitForFunction(() => window.S?.page === 'orders' && document.querySelectorAll('.mee3-card').length === 4);

        const baseMetrics = await page.evaluate(() => {
          const isVisible = (el) => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          const createButtons = Array.from(document.querySelectorAll('.mee3-topbar-create, .mee-mobile-create, .fab')).filter(isVisible);
          const mobileNav = document.querySelector('#mobileNav');
          const topCreate = document.querySelector('.mee3-topbar-create');
          const searchWrap = document.querySelector('.topbar-search');
          const searchInput = document.querySelector('#globalSearchInput');
          const grid = document.querySelector('.mee3-grid');
          const cards = Array.from(document.querySelectorAll('.mee3-card'));
          const distinctCardLefts = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left)))];
          const viewToggle = document.querySelector('.mee3-view-toggle');
          return {
            overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            visibleCreateCount: createButtons.length,
            visibleCreateClasses: createButtons.map((b) => b.className),
            mobileNavVisible: isVisible(mobileNav),
            topCreateVisible: isVisible(topCreate),
            searchFontPx: searchInput ? parseFloat(getComputedStyle(searchInput).fontSize) : 0,
            searchWrapWidthPx: searchWrap ? Math.round(searchWrap.getBoundingClientRect().width) : 0,
            gridDisplay: grid ? getComputedStyle(grid).display : '',
            gridColsCount: grid ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length : 0,
            distinctCardLeftCount: distinctCardLefts.length,
            viewToggleVisible: isVisible(viewToggle)
          };
        });

        // Assert zero horizontal overflow at every single viewport (360..1440)
        assert.equal(baseMetrics.overflowPx, 0, `${width}px ${role}: horizontal overflow ${baseMetrics.overflowPx}px`);

        // RC5-01: Single Create CTA & synchronized breakpoint (<=900 uses Bottom Nav, >=901 uses Topbar)
        assert.equal(baseMetrics.visibleCreateCount, 1, `${width}px ${role}: expected exactly 1 visible Create Order button, got ${JSON.stringify(baseMetrics.visibleCreateClasses)}`);
        if (width <= 900) {
          assert.equal(baseMetrics.mobileNavVisible, true, `${width}px ${role}: mobileNav visible <= 900px`);
          assert.equal(baseMetrics.topCreateVisible, false, `${width}px ${role}: topbar Create hidden <= 900px`);
        } else {
          assert.equal(baseMetrics.mobileNavVisible, false, `${width}px ${role}: mobileNav hidden >= 901px`);
          assert.equal(baseMetrics.topCreateVisible, true, `${width}px ${role}: topbar Create visible >= 901px`);
        }

        // RC5-01: Tablet 761-900px (768, 820, 900) exact 2-column Grid
        if (width >= 768 && width <= 900) {
          assert.equal(baseMetrics.gridDisplay, 'grid', `${width}px ${role}: grid visible in Grid mode`);
          assert.equal(baseMetrics.gridColsCount, 2, `${width}px ${role}: expected 2 grid columns at tablet ${width}px, got ${baseMetrics.gridColsCount}`);
          assert.equal(baseMetrics.distinctCardLeftCount, 2, `${width}px ${role}: cards actually laid out in 2 columns`);
        }

        // Screenshot proof at 820px Grid (ADMIN)
        if (width === 820 && role === 'ADMIN') {
          await page.screenshot({ path: path.join(ARTIFACT_DIR, 'rc5-01-tablet-820-grid-2col.png') });
        }

        // RC5-04: Search input >=16px everywhere <=900px and width >=185px at 390px
        if (width <= 900) {
          assert.ok(baseMetrics.searchFontPx >= 16, `${width}px ${role}: search input font-size ${baseMetrics.searchFontPx}px must be >= 16px`);
        }
        if (width === 390) {
          assert.ok(baseMetrics.searchWrapWidthPx >= 185, `390px ${role}: .topbar-search width ${baseMetrics.searchWrapWidthPx}px must be >= 185px`);
          if (role === 'SALE') {
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'rc5-05-mobile-390-search-16px.png') });
          }
        }

        // RC5-01 + RC5-02: Toggle Grid <-> Table at >= 768px (768, 820, 900, 901, 1024, 1440)
        if (width >= 768) {
          assert.equal(baseMetrics.viewToggleVisible, true, `${width}px ${role}: view toggle visible`);
          await page.locator('.mee3-view-btn', { hasText: 'Bảng' }).click();
          await page.waitForFunction(() => document.querySelector('.mee3-orders.mee3-view-table') !== null);

          const tableMetrics = await page.evaluate(() => {
            const wrap = document.querySelector('.mee3-table-wrap');
            const table = document.querySelector('.mee3-table');
            const grid = document.querySelector('.mee3-grid');
            const ths = Array.from(table.querySelectorAll('thead th'));
            const imgs = Array.from(table.querySelectorAll('.table-thumb'));
            const firstImg = imgs[0];
            const firstImgRect = firstImg ? firstImg.getBoundingClientRect() : null;
            const clampContainers = Array.from(table.querySelectorAll('.mee3-clamp-2'));
            const paymentTh = ths[7].getBoundingClientRect();
            const debtTh = ths[8].getBoundingClientRect();
            const wrapRect = wrap.getBoundingClientRect();
            return {
              overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
              wrapDisplay: getComputedStyle(wrap).display,
              gridDisplay: getComputedStyle(grid).display,
              hasLegacySheetTableClass: table.classList.contains('sheet-table'),
              colCount: ths.length,
              imgWidth: firstImgRect ? Math.round(firstImgRect.width) : 0,
              imgHeight: firstImgRect ? Math.round(firstImgRect.height) : 0,
              imgInsideClamp: firstImg ? Boolean(firstImg.closest('.mee3-clamp-2')) : false,
              clampHasImg: clampContainers.some((c) => c.querySelector('img')),
              wrapScrollWidth: wrap.scrollWidth,
              wrapClientWidth: wrap.clientWidth,
              payColRight: Math.round(paymentTh.right),
              debtColRight: Math.round(debtTh.right),
              wrapRight: Math.round(wrapRect.right),
              viewportWidth: window.innerWidth
            };
          });

          assert.equal(tableMetrics.overflowPx, 0, `${width}px ${role} table view: zero full-page overflow`);
          assert.notEqual(tableMetrics.wrapDisplay, 'none', `${width}px ${role}: table wrapper actually displayed on Bảng click`);
          assert.equal(tableMetrics.gridDisplay, 'none', `${width}px ${role}: grid hidden in Table mode`);
          assert.equal(tableMetrics.hasLegacySheetTableClass, false, 'No legacy .sheet-table class');
          assert.equal(tableMetrics.colCount, 9, 'All 9 columns preserved');
          assert.equal(tableMetrics.imgWidth, 48, 'Table thumbnail width 48px');
          assert.equal(tableMetrics.imgHeight, 48, 'Table thumbnail height 48px');
          assert.equal(tableMetrics.imgInsideClamp, false, 'Image MUST NOT be inside .mee3-clamp-2');
          assert.equal(tableMetrics.clampHasImg, false, '.mee3-clamp-2 wraps ONLY text descriptions');

          if (width === 1440) {
            assert.ok(tableMetrics.wrapScrollWidth <= tableMetrics.wrapClientWidth + 1, `1440px table fits without horizontal clip (${tableMetrics.wrapScrollWidth} <= ${tableMetrics.wrapClientWidth})`);
            assert.ok(tableMetrics.payColRight <= tableMetrics.wrapRight + 1, '1440px Payment column inside visible area');
            assert.ok(tableMetrics.debtColRight <= tableMetrics.wrapRight + 1, '1440px Debt column inside visible area');
            assert.ok(tableMetrics.debtColRight <= 1440, '1440px Debt column inside 1440px viewport');
          }

          if (width === 820 && role === 'ADMIN') {
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'rc5-02-tablet-820-table-toggle.png') });
          }
          if (width === 1440 && role === 'ADMIN') {
            await page.screenshot({ path: path.join(ARTIFACT_DIR, 'rc5-03-desktop-1440-table-9col.png') });
          }

          // Toggle back to Grid cleanly
          await page.locator('.mee3-view-btn', { hasText: 'Lưới' }).click();
          await page.waitForFunction(() => document.querySelector('.mee3-orders.mee3-view-grid') !== null);
        }

        // RC5-03: Actual runtime toast(msg, 1) and toast(msg, 0) verification (plus overlap check)
        const toastErr = await page.evaluate(() => {
          toast('Lỗi kiểm thử RC5 thực tế', 1);
          const t = document.getElementById('toast');
          const cs = getComputedStyle(t);
          const tr = t.getBoundingClientRect();
          const nav = document.querySelector('#mobileNav');
          const nr = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
          return {
            className: t.className,
            bg: cs.backgroundColor,
            pointerEvents: cs.pointerEvents,
            toastBottom: Math.round(tr.bottom),
            navTop: nr ? Math.round(nr.top) : null
          };
        });
        assert.ok(toastErr.className.includes('err'), `${width}px ${role}: error toast uses .err class`);
        assert.equal(toastErr.bg, 'rgb(153, 27, 27)', `${width}px ${role}: error toast background must be #991B1B`);
        assert.equal(toastErr.pointerEvents, 'none', 'Toast never blocks clicks');
        if (toastErr.navTop !== null) {
          assert.ok(toastErr.toastBottom < toastErr.navTop, 'Toast does not cover mobile nav');
        }
        if (width === 1440 && role === 'ADMIN') {
          await page.screenshot({ path: path.join(ARTIFACT_DIR, 'rc5-04-error-toast-red.png') });
        }

        const toastOk = await page.evaluate(() => {
          toast('Lưu thành công RC5', 0);
          const t = document.getElementById('toast');
          const cs = getComputedStyle(t);
          return { className: t.className, bg: cs.backgroundColor };
        });
        assert.equal(toastOk.className.includes('err'), false, 'Success toast must NOT carry .err');
        assert.notEqual(toastOk.bg, 'rgb(153, 27, 27)', 'Success toast retains non-error ink color');

        assert.deepEqual(errors, [], `${width}px ${role}: zero runtime page errors`);
        matrixReport.push({ width, role, baseMetrics });
        await context.close();
      }
    }

    const out = { ok: true, combinationsVerified: matrixReport.length, viewports: VIEWPORTS, roles: ROLES };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exitCode = 1;
});
