// Isolated actual-page QA. Every API/provider request is mocked; never sign.
// PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chrome node tests/synthetic-prefill.browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const files = ['/tech.html', '/nav.js', '/nav.css', '/rental-mobile.css', '/rental-data.js', '/rental-dialog.js'];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const context = await browser.newContext();
  const calls = [], errors = [], unexpected = [];
  await context.addInitScript(() => {
    window.setInterval = () => 1;
    window.EventSource = class { addEventListener() {} close() {} };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname === 'cdn.tailwindcss.com') return route.continue();
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.hostname === 'waiver.smartwaiver.com' && req.method() === 'GET') return route.fulfill({ contentType: 'text/html', body: '<h1>Mock unsigned form — do not sign</h1>' });
    if (url.hostname !== 'synthetic-prefill.test') { unexpected.push(url.hostname); return route.abort(); }
    if (url.pathname === '/staff-session.js') return route.fulfill({ contentType: 'application/javascript', body: 'window.StaffSession={ready:async()=>{},isReady:()=>true,fetch:(...args)=>fetch(...args)};' });
    if (files.includes(url.pathname)) return route.fulfill({ path: path.join(root, url.pathname) });
    if (url.pathname === '/api/hidden') return json({ keys: [] });
    if (['/api/open-intakes', '/api/open-liabilities'].includes(url.pathname)) return json({ rows: [] });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/waiver-prefill' && req.method() === 'POST') {
      const body = req.postDataJSON(); calls.push(body);
      assert.equal(body.stage, 'synthetic-preview');
      return json({ url: 'https://waiver.smartwaiver.com/p/mock-only/', testEvidence: { kiosk: body.syntheticKiosk, requestStartedAtUtc: '2026-10-03T19:00:00.000Z', responseReceivedAtUtc: '2026-10-03T19:00:00.100Z', expiresInSeconds: 3600 }, technicalFields: [{ label: 'Skier Code', guid: 'mock-field', scope: 'participant', value: 'M', fieldType: 'optionlist', type: 'enum' }] });
    }
    unexpected.push(url.pathname); return route.abort();
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [375, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('https://synthetic-prefill.test/tech.html');
      await page.getByText('Waiver setup checks', { exact: true }).click();
      for (const kiosk of [true, false]) {
        const popupPromise = page.waitForEvent('popup');
        await page.locator(kiosk ? '#testWaiverPreview' : '#testWaiverPreviewNonKiosk').click();
        const popup = await popupPromise;
        await popup.waitForURL('https://waiver.smartwaiver.com/p/mock-only/');
        assert.deepEqual(calls.at(-1), { stage: 'synthetic-preview', syntheticKiosk: kiosk });
        const panel = await page.locator('#waiverSetupResult').textContent();
        assert.ok(panel.includes(`"kiosk": ${kiosk}`));
        assert.match(panel, /optionlist/); assert.match(panel, /2026-10-03T19:00:00.000Z/);
        assert.doesNotMatch(panel, /mock-only|smartwaiver\.com/);
        assert.equal(await popup.evaluate(() => window.opener), null);
        await popup.close();
      }
      const box = await page.locator('#testWaiverPreviewNonKiosk').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    }
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ passed: true, widths: [375, 1024], syntheticRequests: calls.length, productionRequests: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
