'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ADMIN_TOKEN = 'ba09a68b99b0b18f2c94cde918e38d15071fafc5d7c86574d484f0638b12b071';
const PROD_URL = 'https://ops.meehoasg.com';
const OUT_DIR = '/Users/heymac/.gemini/antigravity/brain/3972d1a8-c5a3-4d65-b59a-dc6ab75e30fd/release_verify';

fs.mkdirSync(OUT_DIR, { recursive: true });

async function run() {
  console.log('--- STARTING LIVE PRODUCTION VERIFICATION ON OPS.MEEHOASG.COM ---');
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true
  });

  const results = {
    releaseVersion: null,
    paymentCheck: {},
    modules: {},
    desktopScreenshots: [],
    mobileScreenshots: []
  };

  // 1. DESKTOP RUN (1440x900)
  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  await desktopContext.addCookies([
    { name: 'mee_token', value: ADMIN_TOKEN, domain: 'ops.meehoasg.com', path: '/' }
  ]);
  const page = await desktopContext.newPage();

  // Set localStorage token before loading
  await page.addInitScript((token) => {
    localStorage.setItem('mee_token', token);
  }, ADMIN_TOKEN);

  console.log('Navigating to production...');
  await page.goto(PROD_URL, { waitUntil: 'networkidle' });

  // Get active release version
  results.releaseVersion = await page.evaluate(() => {
    return window.__MEE_SHELL_VERSION__ || (document.querySelector('script') ? document.querySelector('script').textContent.match(/RELEASE\s*=\s*'([^']+)'/)?.[1] : null);
  });
  console.log('Live Release Version:', results.releaseVersion);

  // Navigate to Payment Check
  console.log('Opening Payment Check...');
  const t0 = Date.now();
  await page.click('button[data-p="payment"], nav button:has-text("Payment Check"), a:has-text("Payment Check")');
  
  // Wait for settlement cards or content (allow up to 35s for live response)
  await page.waitForSelector('.settlement-card, .empty', { timeout: 35000 });
  const loadDurationMs = Date.now() - t0;
  console.log(`Payment Check rendered in ${loadDurationMs}ms`);

  const paymentData = await page.evaluate(() => {
    const cards = document.querySelectorAll('.settlement-card');
    const pagination = document.querySelector('.payment-pagination-bar');
    const headSub = document.querySelector('.section-head .sub');
    const selectAll = document.querySelector('#mee-settlement-select-all-v364');
    const errorBanner = document.querySelector('.error-banner, #fatalError:not(.hidden)');
    return {
      cardCount: cards.length,
      headSubText: headSub ? headSub.textContent.trim() : '',
      paginationText: pagination ? pagination.textContent.trim() : '',
      hasPagination: !!pagination,
      hasSelectAll: !!selectAll,
      errorText: errorBanner ? errorBanner.textContent.trim() : null,
      firstCard: cards.length ? {
        title: cards[0].querySelector('h4')?.textContent.trim(),
        meta: cards[0].querySelector('.meta')?.textContent.trim(),
        money: cards[0].querySelector('.money')?.textContent.trim(),
        billCount: cards[0].querySelectorAll('.thumbs img').length
      } : null
    };
  });

  results.paymentCheck.desktop = {
    loadDurationMs,
    ...paymentData
  };
  console.log('Desktop Payment Check Data:', JSON.stringify(results.paymentCheck.desktop, null, 2));

  // Capture desktop screenshot
  const desktopImg = path.join(OUT_DIR, 'desktop_payment_check.png');
  await page.screenshot({ path: desktopImg, fullPage: false });
  results.desktopScreenshots.push(desktopImg);

  // Test Pagination Click: Page 2
  const nextBtn = page.locator('.payment-pagination-bar button:has-text("Trang sau")');
  if (await nextBtn.isVisible() && !(await nextBtn.isDisabled())) {
    console.log('Testing Pagination: Clicking Trang sau...');
    const tPage2 = Date.now();
    await nextBtn.click();
    await page.waitForTimeout(1000);
    const p2Duration = Date.now() - tPage2;
    const p2Data = await page.evaluate(() => {
      const cards = document.querySelectorAll('.settlement-card');
      const pagination = document.querySelector('.payment-pagination-bar');
      return {
        cardCount: cards.length,
        paginationText: pagination ? pagination.textContent.trim() : ''
      };
    });
    results.paymentCheck.page2 = {
      durationMs: p2Duration,
      ...p2Data
    };
    console.log('Page 2 Data:', results.paymentCheck.page2);
    const p2Img = path.join(OUT_DIR, 'desktop_payment_check_page2.png');
    await page.screenshot({ path: p2Img });

    // Navigate back to Page 1
    const prevBtn = page.locator('.payment-pagination-bar button:has-text("Trang trước")');
    await prevBtn.click();
    await page.waitForTimeout(1000);
  }

  // 2. SPOT-CHECK OTHER MODULES ON DESKTOP
  const checkModule = async (name, navSelector, waitSelector) => {
    try {
      const t = Date.now();
      await page.click(navSelector);
      await page.waitForSelector(waitSelector, { timeout: 8000 });
      const durationMs = Date.now() - t;
      const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, waitSelector);
      results.modules[name] = { ok: true, durationMs, count };
      console.log(`Module [${name}] loaded OK in ${durationMs}ms (${count} items)`);
      const img = path.join(OUT_DIR, `desktop_${name}.png`);
      await page.screenshot({ path: img });
    } catch (e) {
      results.modules[name] = { ok: false, error: e.message };
      console.error(`Module [${name}] failed:`, e.message);
    }
  };

  await checkModule('dashboard', 'button[data-p="dashboard"]', '.stat-card, .section');
  await checkModule('production', 'button[data-p="production"]', '.ops-tile, .order, .empty');
  await checkModule('orders', 'button[data-p="orders"]', '.order, .empty');
  await checkModule('debt', 'button[data-p="debt"]', '.order, .empty');
  await checkModule('kpi', 'button[data-p="kpi"]', '.kpi-card, .table-wrap, .section');
  await checkModule('flowers', 'button[data-p="flowers"]', '.order, .empty');

  await desktopContext.close();

  // 3. MOBILE VERIFICATION (390x844 - iPhone 14/15 size)
  console.log('Testing Mobile Viewport (390x844)...');
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  await mobileContext.addCookies([
    { name: 'mee_token', value: ADMIN_TOKEN, domain: 'ops.meehoasg.com', path: '/' }
  ]);
  const mobPage = await mobileContext.newPage();
  await mobPage.addInitScript((token) => {
    localStorage.setItem('mee_token', token);
  }, ADMIN_TOKEN);

  await mobPage.goto(PROD_URL, { waitUntil: 'networkidle' });

  // Open Mobile More menu or Payment tab
  // Mobile nav may have more button
  const paymentBtn = mobPage.locator('button[data-p="payment"]');
  if (await paymentBtn.isVisible()) {
    await paymentBtn.click();
  } else {
    // Click "Thêm" or more menu
    const moreBtn = mobPage.locator('#mobileMoreBtn, button:has-text("Thêm"), button:has-text("…")');
    if (await moreBtn.isVisible()) {
      await moreBtn.click();
      await mobPage.waitForSelector('.mobile-menu-sheet', { timeout: 3000 });
      await mobPage.click('button:has-text("Payment Check")');
    }
  }

  await mobPage.waitForSelector('.settlement-card, .empty', { timeout: 35000 });
  const mobImg = path.join(OUT_DIR, 'mobile_payment_check.png');
  await mobPage.screenshot({ path: mobImg });
  results.mobileScreenshots.push(mobImg);

  const mobData = await mobPage.evaluate(() => {
    const cards = document.querySelectorAll('.settlement-card');
    const pagination = document.querySelector('.payment-pagination-bar');
    return {
      cardCount: cards.length,
      paginationText: pagination ? pagination.textContent.trim() : ''
    };
  });
  results.paymentCheck.mobile = mobData;
  console.log('Mobile Payment Check Data:', mobData);

  await mobileContext.close();
  await browser.close();

  fs.writeFileSync(path.join(OUT_DIR, 'verification_summary.json'), JSON.stringify(results, null, 2));
  console.log('--- VERIFICATION COMPLETED SUCCESSFULLY ---');
}

run().catch(err => {
  console.error('VERIFICATION ERROR:', err);
  process.exit(1);
});
