// Actual-page pending-queue regression. All records and signed events are
// fictional; production APIs and every non-GET request are blocked.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { sourceTag } = require('../rental-data');
const root = path.resolve(__dirname, '..');
const files = ['/tech.html', '/nav.js', '/nav.css', '/rental-mobile.css', '/rental-data.js', '/rental-dialog.js'];
const row = (index, overrides = {}) => ({
  waiver_id: 'synthetic_rental', participant_index: index, lightspeed_id: 'synthetic_customer',
  first_name: `Fictional ${index}`, last_name: 'Example', email: 'family@example.invalid',
  signed_on: new Date().toISOString(), age: 10, weight_lb: 75, height_in: 55, skier_type: 'I', ...overrides
});
const rows = [row(0), row(1), row(2), row(3, { lightspeed_id: 'different_customer' }),
  row(0, { waiver_id: 'separate_rental' }), row(0, { waiver_id: 'blank_id_rental', lightspeed_id: '' }),
  row(1, { waiver_id: 'blank_id_rental', lightspeed_id: '' })];
const final = { waiverId: 'synthetic_signed_final', signed: true, autoTag: sourceTag('synthetic_rental', 0), createdOn: new Date(Date.now() + 1000).toISOString() };

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext();
  const unexpected = [], errors = [];
  let liabilities = [];
  await context.addInitScript(() => { window.EventSource = class { addEventListener() {} }; window.setInterval = () => 1; });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'GET' && url.hostname === 'cdn.tailwindcss.com') return route.continue();
    if (req.method() !== 'GET' || url.hostname !== 'reconciliation.test') { unexpected.push(req.url()); return route.abort(); }
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (files.includes(url.pathname)) return route.fulfill({ path: path.join(root, url.pathname) });
    if (url.pathname === '/staff-session.js') return route.fulfill({ contentType: 'application/javascript', body: 'window.StaffSession={ready:async()=>{},isReady:()=>true,fetch:(...args)=>fetch(...args)};' });
    if (url.pathname === '/api/hidden') return json({ keys: [] });
    if (url.pathname === '/api/open-intakes') return json({ rows, partial: false });
    if (url.pathname === '/api/open-liabilities') return json({ rows: liabilities });
    unexpected.push(req.url()); return route.abort();
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [375, 1268]) {
      liabilities = [];
      await page.setViewportSize({ width, height: 812 });
      await page.goto('https://reconciliation.test/tech.html');
      // Count the user-visible row actions rather than internal app state.
      const waitRows = expected => page.waitForFunction(value => document.querySelectorAll('button[data-action="din"]').length === value, expected);
      await waitRows(7);
      liabilities = [{ ...final, signed: false }];
      await Promise.all([page.waitForResponse(response => response.url().includes('/api/open-liabilities')), page.locator('#refreshBtn').click()]);
      await waitRows(7);
      liabilities = [final];
      await Promise.all([page.waitForResponse(response => response.url().includes('/api/open-liabilities')), page.locator('#refreshBtn').click()]);
      await waitRows(4);
      assert.equal(await page.locator('button[data-action="din"][data-intake="synthetic_rental"]').count(), 1, 'different LS ID on the intake stays pending');
      assert.equal(await page.locator('button[data-action="din"][data-intake="separate_rental"]').count(), 1, 'a separate rental for the same customer stays pending');
      assert.equal(await page.locator('button[data-action="din"][data-intake="blank_id_rental"]').count(), 2, 'blank customer IDs remain separate');
      liabilities = [final, final];
      await Promise.all([page.waitForResponse(response => response.url().includes('/api/open-liabilities')), page.locator('#refreshBtn').click()]);
      await waitRows(4);
      await page.reload();
      await waitRows(4);
    }
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, widths: [375, 1268], before: 7, after: 4, duplicateEvents: 'idempotent', productionRequests: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
