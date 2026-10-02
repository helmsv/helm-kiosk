/*
 * Synthetic browser QA, deliberately separate from dependency-free `npm test`.
 * Requires Playwright + its Chromium browser. No production API is contacted.
 * Run: node tests/rental-mobile.browser.cjs
 * Optional: PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium
 * Tailwind's public CDN is the only network request allowed through the mock.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const { normalizeIntake } = require('../lib/intake-normalize');
const fixture = structuredClone(require('./fixtures/intake.json'));
fixture.email = 'synthetic-long-email-address-for-mobile-layout@example.invalid';
fixture.participants[0].lastName = 'Example With A Long Family Name';
const details = normalizeIntake(fixture, new Date('2026-10-02T00:00:00Z'));
const outDir = process.env.RENTAL_QA_OUTPUT || '/tmp/rental-mobile-qa';
const widths = [320, 375, 390, 430, 640, 744, 768, 820, 1024];
const staticFiles = ['/tech.html', '/returns.html', '/rental-mobile.css', '/nav.css', '/nav.js', '/rental-data.js'];

async function noOverflow(page, selector = 'html') {
  const sizes = await page.locator(selector).evaluate(node => ({
    scroll: node.scrollWidth,
    client: node.clientWidth,
    viewport: innerWidth
  }));
  assert.ok(sizes.scroll <= sizes.client + 1, `${selector} overflows: ${JSON.stringify(sizes)}`);
}

async function dialogFits(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const view = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= view.width + 1, `${selector} fits horizontally`);
  assert.ok(box.y >= 0 && box.y + box.height <= view.height + 1, `${selector} fits vertically`);
  assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).overflowY), 'auto');
  await noOverflow(page, selector);
}

async function tabletUnchanged(page) {
  const snapshot = () => page.evaluate(() => [...document.querySelectorAll('body, main, .wrap, .card, h1, table, thead, tbody, td, input, select, button')].map(node => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return [node.tagName, node.id, style.display, style.padding, style.fontSize, box.x, box.y, box.width, box.height];
  }));
  const withSheet = await snapshot();
  await page.evaluate(() => { document.querySelector('link[href="/rental-mobile.css"]').disabled = true; });
  assert.deepEqual(await snapshot(), withSheet, 'mobile stylesheet must have no effect on tablet geometry');
  await page.evaluate(() => { document.querySelector('link[href="/rental-mobile.css"]').disabled = false; });
  assert.equal(await page.locator('table').evaluate(node => getComputedStyle(node).display), 'table');
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const requests = [];
  const unexpected = [];
  const errors = [];
  await context.addInitScript(() => {
    window.EventSource = class { addEventListener() {} };
    window.setInterval = () => 1;
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === 'cdn.tailwindcss.com' && request.method() === 'GET') return route.continue();
    requests.push({ path: url.pathname, method: request.method() });
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.hostname !== 'rental-layout.test' || request.method() !== 'GET') {
      unexpected.push(request.url());
      return route.abort();
    }
    if (url.pathname === '/api/config') return json({ liability_waiver_id: 'synthetic_liability' });
    if (url.pathname === '/api/hidden') return json({ keys: [] });
    if (url.pathname === '/api/open-liabilities') return json({ rows: [] });
    if (url.pathname === '/api/open-intakes') return json({ rows: details.participants.map(p => ({ ...p, waiver_id: fixture.waiverId, signed_on: new Date().toISOString(), lightspeed_id: 'synthetic-layout-only' })) });
    if (url.pathname === '/api/intake-details') return json(details);
    if (url.pathname === '/api/rentals-outstanding') return json({ rentals: [
      { id: 123456789, signer_first: 'Synthetic', signer_last: 'Example With A Long Family Name', signed_at: '2026-10-02T00:00:00Z', phone: '+1 (555) 010-0100', status: 'OUT', note: 'Synthetic equipment note only' },
      { id: 123456790, signer_first: 'Returned', signer_last: 'Example', signed_at: '2026-10-01T00:00:00Z', phone: '', status: 'RETURNED', returned_at: '2026-10-02T00:00:00Z', note: '' }
    ] });
    if (staticFiles.includes(url.pathname)) return route.fulfill({
      body: fs.readFileSync(path.join(root, url.pathname)),
      contentType: url.pathname.endsWith('.html') ? 'text/html' : url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript'
    });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    unexpected.push(request.url());
    return route.abort();
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const width of widths) {
      const phone = width < 640;
      await page.setViewportSize({ width, height: 844 });
      await page.goto('https://rental-layout.test/tech.html');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('main')).maxWidth === '1280px');
      await page.locator('#tbody tr').first().waitFor();
      if (phone) {
        await noOverflow(page);
        assert.equal(await page.locator('#tbody td').first().evaluate(node => getComputedStyle(node, '::before').content), '"Signed"');
      } else await tabletUnchanged(page);
      await page.screenshot({ path: path.join(outDir, `pending-${width}.png`), fullPage: true });
      if (phone) {
        await page.getByRole('button', { name: 'Compute DIN', exact: true }).first().click();
        await page.locator('#dinModal').waitFor({ state: 'visible' });
        await dialogFits(page, '.rental-din-panel');
        await page.locator('#inp_bsl').fill('315');
        assert.notEqual(await page.locator('#out_din').textContent(), '—');
        await page.locator('#dinParticipant').selectOption('1');
        assert.equal(await page.locator('#inp_bsl').inputValue(), '');
        await page.locator('#btnCopy').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(outDir, `din-bottom-${width}.png`) });
        await page.locator('#dinClose').click();
        assert.equal(await page.locator('#dinModal').isVisible(), false);
      }

      await page.goto('https://rental-layout.test/returns.html');
      await page.locator('#rows td[data-label]').first().waitFor();
      if (phone) await noOverflow(page);
      else await tabletUnchanged(page);
      await page.screenshot({ path: path.join(outDir, `returns-${width}.png`), fullPage: true });
      if (phone) {
        for (const [name, dialog, cancel] of [['Return', '#returnDialog', '#cancelReturnBtn'], ['Note', '#noteDialog', '#cancelNoteBtn']]) {
          await page.getByRole('button', { name, exact: true }).first().click();
          await page.locator(dialog).waitFor({ state: 'visible' });
          await dialogFits(page, dialog);
          await page.setViewportSize({ width, height: 360 });
          await dialogFits(page, dialog);
          await page.locator(cancel).scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(outDir, `${name.toLowerCase()}-short-${width}.png`) });
          await page.locator(cancel).click();
          assert.equal(await page.locator(dialog).isVisible(), false);
          await page.setViewportSize({ width, height: 844 });
        }
      }
    }
    assert.deepEqual(unexpected, [], 'no unexpected network calls or writes');
    assert.deepEqual(errors, [], 'no JavaScript errors');
    assert.ok(requests.every(request => request.method === 'GET'), 'no return or note writes');
    console.log(JSON.stringify({ passed: true, widths, screenshots: outDir, productionRequests: 0 }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
