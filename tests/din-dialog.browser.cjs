/* Real-browser geometry/lifecycle checks with a synthetic, shorter-than-window
 * Kiosk iframe. No production API, customer record or credential is used.
 * Run with installed Playwright/Chromium:
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium \
 *   node tests/din-dialog.browser.cjs
 * The public Tailwind CDN is the only network request allowed through.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { normalizeIntake } = require('../lib/intake-normalize');
const root = path.resolve(__dirname, '..');
const fixture = structuredClone(require('./fixtures/intake.json'));
const details = normalizeIntake(fixture, new Date('2026-10-02T00:00:00Z'));
const output = process.env.DIALOG_QA_OUTPUT || '/tmp/din-dialog-qa';
const cases = [
  { name: 'embedded-desktop', width: 1268, height: 607 },
  { name: 'short-desktop', width: 1024, height: 420 },
  { name: 'tablet', width: 820, height: 560 },
  { name: 'ipad-mini', width: 744, height: 480 },
  { name: 'ipad-portrait', width: 768, height: 560 },
  { name: 'phone', width: 375, height: 520 },
  { name: 'phone-wide', width: 390, height: 520 },
  { name: 'small-phone', width: 320, height: 400 },
  { name: 'short-landscape', width: 844, height: 220 }
];

async function geometry(frame) {
  return frame.evaluate(() => {
    const rect = selector => {
      const node = document.querySelector(selector), r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    };
    const close = document.getElementById('dinClose'), r = close.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panel: rect('.rental-din-panel'), body: rect('#dinBody'), close: rect('#dinClose'),
      actions: rect('.rental-dialog-actions'), bsl: rect('#inp_bsl'),
      bodyOverflowY: getComputedStyle(document.getElementById('dinBody')).overflowY,
      closeHit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button')?.id,
      scrollTop: document.getElementById('dinBody').scrollTop,
      scrollHeight: document.getElementById('dinBody').scrollHeight,
      clientHeight: document.getElementById('dinBody').clientHeight,
      fontSize: getComputedStyle(document.getElementById('inp_bsl')).fontSize
    };
  });
}

function checkFits(result, name) {
  const { panel, body, close, viewport } = result;
  assert.ok(panel.top >= 0 && panel.bottom <= viewport.height + 1, `${name}: panel fits iframe height`);
  assert.ok(panel.left >= 0 && panel.right <= viewport.width + 1, `${name}: panel fits iframe width`);
  assert.ok(close.top >= panel.top && close.bottom <= body.top + 1, `${name}: Close remains above the scroll region`);
  assert.equal(result.closeHit, 'dinClose', `${name}: Close is not covered by the navigation button`);
  assert.equal(result.bodyOverflowY, 'auto');
  assert.ok(body.scrollWidth <= body.clientWidth + 1, `${name}: no horizontal body overflow`);
  assert.ok(result.bsl.height >= 44, `${name}: readable BSL input height`);
  assert.equal(result.fontSize, '16px');
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const unexpected = [], errors = [], results = [];
  await context.addInitScript(() => { window.EventSource = class { addEventListener() {} }; window.setInterval = () => 1; });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname === 'cdn.tailwindcss.com' && req.method() === 'GET') return route.continue();
    const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.hostname !== 'din-layout.test' || req.method() !== 'GET') { unexpected.push(req.url()); return route.abort(); }
    if (url.pathname === '/staff-session.js') return route.fulfill({ contentType: 'application/javascript', body: 'window.StaffSession={ready:async()=>{},isReady:()=>true,fetch:(...args)=>window.fetch(...args)};' });
    if (url.pathname === '/api/config') return json({ liability_waiver_id: 'synthetic_only' });
    if (url.pathname === '/api/hidden') return json({ keys: [] });
    if (url.pathname === '/api/open-liabilities') return json({ rows: [] });
    if (url.pathname === '/api/open-intakes') return json({ rows: details.participants.map(person => ({ ...person, waiver_id: fixture.waiverId, signed_on: new Date().toISOString() })) });
    if (url.pathname === '/api/intake-details') return json(details);
    if (['/tech.html', '/rental-mobile.css', '/nav.css', '/nav.js', '/rental-data.js', '/rental-dialog.js'].includes(url.pathname)) {
      return route.fulfill({ body: fs.readFileSync(path.join(root, url.pathname)), contentType: url.pathname.endsWith('.html') ? 'text/html' : url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
    }
    unexpected.push(req.url()); return route.abort();
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const item of cases) {
      await page.setViewportSize({ width: item.width + 40, height: item.height + 190 });
      await page.setContent(`<html><body style="margin:0;background:#f5f6fb"><header style="height:150px;padding:20px;box-sizing:border-box;font:24px system-ui">Synthetic SnowOS rental host</header><iframe title="Synthetic Kiosk" src="https://din-layout.test/tech.html" style="display:block;margin-left:20px;border:0;width:${item.width}px;height:${item.height}px"></iframe></body></html>`);
      const frame = await (await page.$('iframe')).contentFrame();
      await frame.waitForFunction(() => getComputedStyle(document.querySelector('main')).maxWidth === '1280px');
      const opener = frame.getByRole('button', { name: 'Compute DIN', exact: true }).first();
      await opener.waitFor();
      const tableDisplay = await frame.locator('table').evaluate(node => getComputedStyle(node).display);
      assert.equal(tableDisplay, item.width < 640 ? 'block' : 'table', `${item.name}: tablet table retained`);
      await opener.click();
      await frame.locator('#dinModal').waitFor({ state: 'visible' });
      assert.equal(await frame.evaluate(() => document.activeElement.id), 'dinClose');
      const initial = await geometry(frame); checkFits(initial, item.name);
      assert.equal(initial.scrollTop, 0);
      await page.screenshot({ path: path.join(output, `${item.name}-top.png`) });

      await frame.locator('#dinBody').evaluate(node => { node.scrollTop = node.scrollHeight; });
      const bottom = await geometry(frame); checkFits(bottom, item.name);
      assert.ok(bottom.scrollTop > 0, `${item.name}: overflow can be scrolled`);
      assert.ok(bottom.actions.top >= bottom.body.top && bottom.actions.bottom <= bottom.body.bottom + 1, `${item.name}: bottom actions reachable`);
      await page.screenshot({ path: path.join(output, `${item.name}-bottom.png`) });

      // Exercise the actual final action when enabled, not only the earlier
      // review checkbox that is last in the initial disabled state.
      await frame.getByLabel('Boot Sole Length (mm)', { exact: true }).fill('315');
      await frame.locator('#reviewTechnician').check();
      assert.equal(await frame.locator('#btnCopy').isEnabled(), true);
      assert.equal(await frame.locator('#btnOpenLiab').isEnabled(), true);
      await frame.locator('#dinBody').evaluate(node => { node.scrollTop = 0; });
      await frame.locator('#dinClose').press('Shift+Tab');
      assert.equal(await frame.evaluate(() => document.getElementById('dinModal').contains(document.activeElement)), true);
      assert.equal(await frame.evaluate(() => document.activeElement.id), 'btnOpenLiab');
      assert.equal(await frame.evaluate(() => {
        const control = document.activeElement.getBoundingClientRect();
        const body = document.getElementById('dinBody').getBoundingClientRect();
        return control.top >= body.top && control.bottom <= body.bottom + 1;
      }), true, 'Shift+Tab scrolls the final control into view');
      await page.keyboard.press('Tab');
      assert.equal(await frame.evaluate(() => document.activeElement.id), 'dinClose');
      await frame.locator('#dinParticipant').focus();
      await frame.locator('#dinParticipant').selectOption('1');
      assert.equal(await frame.evaluate(() => document.activeElement.id), 'dinParticipant', 'participant update preserves focus');
      await frame.locator('#dinParticipant').press('Escape');
      assert.equal(await frame.locator('#dinModal').isVisible(), false);
      assert.equal(await opener.evaluate(node => document.activeElement === node), true);
      assert.equal(await frame.locator('main').evaluate(node => node.inert), false);

      await opener.click();
      assert.equal((await geometry(frame)).scrollTop, 0, 'reopen resets scroll');
      await frame.locator('#dinClose').click();
      assert.equal(await frame.locator('#dinModal').isVisible(), false);
      await opener.click();
      await frame.evaluate(() => window.dispatchEvent(new Event('staff-session-ended')));
      assert.equal(await frame.locator('#dinModal').isVisible(), false);
      assert.equal(await frame.locator('main').evaluate(node => node.inert), false);
      assert.notEqual(await frame.evaluate(() => document.documentElement.style.overflow), 'hidden');
      results.push({ ...item, panelHeight: initial.panel.height, bodyHeight: initial.body.height, scrollHeight: initial.scrollHeight, finalScrollTop: bottom.scrollTop });
    }
    assert.deepEqual(unexpected, [], 'no customer/API writes or unmocked destinations');
    assert.deepEqual(errors, [], 'no JavaScript errors');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, results, productionRequests: 0 }, null, 2));
    console.log(JSON.stringify({ passed: true, results, screenshots: output, productionRequests: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
