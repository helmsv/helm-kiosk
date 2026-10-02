const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../tech.html'), 'utf8');
const source = html.slice(html.indexOf("    document.getElementById('checkWaiverFields')"), html.indexOf("    window.addEventListener('staff-session-ended'"));

function harness(response, popup = true) {
  const nodes = new Map(), requests = [], navigations = [], notices = [];
  const tab = { opener: {}, closed: false, document: { body: { textContent: '' } }, location: { replace: value => navigations.push(value) } };
  const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', addEventListener(type, callback) { this[type] = callback; } }); return nodes.get(id); };
  const context = { document: { getElementById: node }, URL, window: { open: () => popup ? tab : null }, showToast: message => notices.push(message), StaffSession: { fetch: async (url, options) => { requests.push({ url, options }); return response; } } };
  vm.runInNewContext(source, context);
  return { node, requests, navigations, notices, tab, click: () => node('testWaiverPreview').click() };
}

test('unsigned setup preview visibly reports only synthetic field evidence and opens the provider form', async () => {
  const technicalFields = [{ label: 'Skier Code', guid: 'synthetic_code', scope: 'participant', value: 'M' }];
  const h = harness({ ok: true, json: async () => ({ url: 'https://waiver.smartwaiver.com/p/synthetic_preview/', technicalFields, email: 'not-for-diagnostics@example.invalid', copiedFields: ['unrelated audit'] }) });
  await h.click();
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { stage: 'synthetic-preview' });
  assert.equal(h.requests[0].url, '/api/waiver-prefill');
  assert.match(h.node('waiverSetupResult').textContent, /accepted request alone does not verify/);
  assert.match(h.node('waiverSetupResult').textContent, /synthetic_code/);
  assert.doesNotMatch(h.node('waiverSetupResult').textContent, /example\.invalid|smartwaiver\.com|unrelated audit/);
  assert.equal(h.tab.opener, null);
  assert.deepEqual(h.navigations, ['https://waiver.smartwaiver.com/p/synthetic_preview/']);
});

test('setup preview errors replace prior evidence and never navigate to an untrusted host', async () => {
  for (const response of [
    { ok: false, json: async () => ({ error: 'Unsigned test unavailable [prefill-create; HTTP 402]' }) },
    { ok: true, json: async () => ({ url: 'https://attacker.invalid/p/example', technicalFields: [{ label: 'Skier Code', value: 'M' }] }) },
  ]) {
    const h = harness(response); h.node('waiverSetupResult').textContent = 'previous diagnostic';
    await h.click();
    assert.equal(h.navigations.length, 0);
    assert.equal(h.notices.length, 1);
    assert.equal(h.node('waiverSetupResult').textContent, h.tab.document.body.textContent);
    assert.doesNotMatch(h.node('waiverSetupResult').textContent, /previous diagnostic|"M"/);
  }
});

test('blocked setup popup does not create a draft', async () => {
  const h = harness(null, false); await h.click();
  assert.equal(h.requests.length, 0);
  assert.match(h.notices[0], /Allow popups/);
});
