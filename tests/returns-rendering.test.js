const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../returns.html'), 'utf8');
const helpers = html.slice(html.indexOf('  const el ='), html.indexOf('  function toYMD(d) {'));
const search = html.slice(html.indexOf('  async function search() {'), html.indexOf('  async function doReturn(btn) {'));
const doNote = html.slice(html.indexOf('  async function doNote(btn) {'), html.indexOf('  async function exportCsv() {'));
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"
}[entity]));

function harness(response, extra = {}) {
  const rows = [];
  const nodes = {
    name: { value: '' }, startDate: { value: '' }, endDate: { value: '' },
    statusFilter: { value: 'ALL' }, count: {}, toast: {},
    rows: { innerHTML: '', appendChild: row => rows.push(row), querySelectorAll: () => [] }
  };
  const context = {
    inFlight: null, AbortController, URLSearchParams,
    document: { getElementById: id => nodes[id], createElement: () => ({ setAttribute() {} }) },
    fetch: async () => ({ ok: true, json: async () => response }),
    ...extra
  };
  context.StaffSession={fetch:context.fetch,isReady:()=>true};
  vm.createContext(context);
  vm.runInContext(helpers + search + doNote, context);
  return { context, rows, nodes };
}

test('customer text and attribute values remain literal, including entity-based XSS payloads', async () => {
  const attack = '<img src=x onerror="alert(1)">';
  const id = '12" autofocus onfocus="alert(2)';
  const note = 'Skis "received" & boots <img src=x onerror="alert(3)"> &quot; onfocus="alert(4)';
  const { context, rows } = harness({ rentals: [{
    id, signer_first: attack, signer_last: 'O\'Brien & Family', phone: attack,
    signed_at: attack, returned_at: attack, status: attack, note
  }] }, { Date: class { constructor() { throw new Error('synthetic formatting fallback'); } } });
  await vm.runInContext('search()', context);
  assert.equal(rows.length, 1);
  const rendered = rows[0].innerHTML;
  assert.doesNotMatch(rendered, /<img\b/i);
  assert.doesNotMatch(rendered, /<script\b/i);
  assert.ok(rendered.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  const renderedNote = rendered.match(/data-note="([^"]*)"/)[1];
  assert.equal(decode(renderedNote), note, 'the note round-trips as text without attribute injection');
  for (const [, renderedId] of rendered.matchAll(/data-id="([^"]*)"/g)) assert.equal(decode(renderedId), id);
  assert.match(rendered, /data-label="Signed"><span>&lt;img/);
  assert.match(rendered, /data-label="Returned"><span>&lt;img/);
  assert.match(rendered, /O&#39;Brien &amp; Family/);
});

test('nondialable phone fallback is escaped and valid Zoom Phone dialing is preserved', () => {
  const { context } = harness({ rentals: [] });
  const attack = '<img src=x onerror="alert()">';
  const escaped = context.phoneCell(attack);
  assert.doesNotMatch(escaped, /<img/i);
  assert.equal(decode(escaped), attack);
  assert.equal(context.phoneCell(''), '');
  assert.equal(context.phoneCell('+1 (555) 010-0100'), '<a href="zoomphonecall://+15550100100" title="Call with Zoom Phone">+1 (555) 010-0100</a>');
  const link = context.phoneCell('+1 <img src=x onerror="alert(5)">');
  assert.match(link, /^<a href="zoomphonecall:\/\/\+15"/);
  assert.doesNotMatch(link, /<img/i);
});

test('API error messages cannot inject HTML into the result table', async () => {
  const attack = '<img src=x onerror="alert(6)">';
  const { context, nodes } = harness({}, {
    fetch: async () => ({ ok: false, json: async () => ({ error: attack }) })
  });
  await vm.runInContext('search()', context);
  assert.doesNotMatch(nodes.rows.innerHTML, /<img/i);
  assert.ok(nodes.rows.innerHTML.includes('&lt;img src=x onerror=&quot;alert(6)&quot;&gt;'));
});

test('normal signer, agreement and OUT return action values are unchanged', async () => {
  const { context, rows } = harness({ rentals: [{
    id: 123, signer_first: 'Synthetic', signer_last: 'Example', phone: '+1 555 0100',
    signed_at: '2026-10-02T00:00:00Z', status: 'OUT', note: 'Skis & "boots"'
  }] });
  await vm.runInContext('search()', context);
  assert.match(rows[0].innerHTML, /<span>Synthetic Example<\/span>/);
  assert.match(rows[0].innerHTML, /data-label="Agreement"><span>123<\/span>/);
  assert.match(rows[0].innerHTML, /data-action="return" data-id="123"/);
  assert.equal(decode(rows[0].innerHTML.match(/data-note="([^"]*)"/)[1]), 'Skis & "boots"');
});

test('saving a note keeps literal quotes and entities when reopening, with the same request body', async () => {
  const original = 'Original "note" &quot; <img src=x onerror="alert(7)">';
  const saved = 'Updated "note" &quot; <img src=x onerror="alert(8)">';
  const attributes = { 'data-id': '123', 'data-note': original };
  const btn = {
    getAttribute: key => attributes[key], setAttribute: (key, value) => { attributes[key] = value; },
    closest: () => ({ querySelectorAll: () => [btn] })
  };
  const requests = [];
  const { context } = harness({}, {
    openNoteDialog: async value => { assert.equal(value, original); return { note: saved }; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ agreement: { note: saved } }) };
    }
  });
  await context.doNote(btn);
  assert.equal(attributes['data-note'], saved, 'setAttribute takes literal text, not HTML entities');
  assert.equal(btn.disabled, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/rentals-note');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { agreementId: 123, note: saved });
});
