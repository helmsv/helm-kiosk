const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tech = read('tech.html');
const returns = read('returns.html');
const css = read('rental-mobile.css');

test('all mobile styles are inside the phone breakpoint, never iPad widths', () => {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.ok(source.startsWith('@media (max-width: 639px) {'));
  let depth = 0;
  for (let i = source.indexOf('{'); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    assert.ok(depth >= 0);
    if (depth === 0) assert.equal(i, source.length - 1, 'no rules outside the phone query');
  }
  assert.equal(depth, 0);
  for (const [, width] of source.matchAll(/@media \(max-width:\s*(\d+)px\)/g)) {
    assert.ok(Number(width) <= 639, 'nested overrides also stay phone-only');
  }
  const maxWidth = Number(source.match(/max-width:\s*(\d+)px/)[1]);
  for (const width of [320, 375, 390, 430]) assert.ok(width <= maxWidth);
  for (const width of [640, 744, 768, 820, 1024]) assert.ok(width > maxWidth);
});

test('both pages opt in to mobile styles and retain table accessibility metadata', () => {
  for (const html of [tech, returns]) {
    assert.ok(html.indexOf('href="/rental-mobile.css"') > html.indexOf('</style>'));
    assert.match(html, /<body class="rental-page rental-/);
    assert.match(html, /<table[^>]+class="rental-table[^>]+role="table"[^>]+aria-label=/);
    assert.match(html, /<thead[^>]+role="rowgroup"/);
    assert.match(html, /<tbody[^>]+role="rowgroup"/);
  }
  assert.match(css, /\.rental-page \.rental-table thead\s*\{[^}]*clip:\s*rect\(0, 0, 0, 0\)/);
  assert.doesNotMatch(css, /thead\s*\{[^}]*display:\s*none/);
});

test('populated cards have a visible mobile label for every existing column', () => {
  const labels = html => [...html.matchAll(/<td[^>]+data-label="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(labels(tech), ['Signed', 'Participant', 'Email', 'Age', 'Wt (lb)', 'Ht (cm)', 'Skier Type', 'LS ID', 'Intake PDF', 'Actions']);
  assert.deepEqual(labels(returns), ['Signed', 'Signer', 'Phone', 'Agreement', 'Status', 'Returned', 'Actions']);
  assert.match(css, /content:\s*attr\(data-label\)/);
  assert.doesNotMatch(returns, /colspan="6"/);
});

test('phone overrides allow wrapping and scrolling rather than clipping content', () => {
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.rental-page \.rental-toolbar\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.rental-page \.rental-row-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.rental-page \.rental-din-panel,\s*\.rental-page dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 24px\)[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.rental-page button\s*\{[^}]*min-height:\s*44px/);
  assert.doesNotMatch(css, /\.rental-page\s*\{[^}]*overflow(?:-x)?:\s*hidden/);
});

test('both pages retain syntactically valid inline JavaScript', () => {
  for (const [name, html] of [['tech', tech], ['returns', returns]]) {
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new vm.Script(script, { filename: name + '.html' }));
    }
  }
});

test('Pending Liability renders labeled synthetic rows without changing row actions', () => {
  const rows = [];
  const synthetic = {
    waiver_id: 'synthetic_mobile', participant_index: 0,
    signed_on: '2026-10-02T00:00:00Z', first_name: 'Synthetic', last_name: 'Long Participant Name',
    email: 'long-synthetic-address-for-layout@example.invalid',
    age: 40, weight_lb: 180, height_in: 71, skier_type: 'III', lightspeed_id: 'synthetic-only'
  };
  const context = {
    escapeHTML: value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    store: new Map([['synthetic_mobile#0', synthetic]]), showHidden: false, hiddenSet: new Set(),
    rowKey: (id, index) => `${id}#${index}`, parseSWDateMs: Date.parse,
    fmtTime: value => value, toCm: value => Math.round(value * 2.54), displaySkier: value => value,
    tb: { innerHTML: '', appendChild: row => rows.push(row) },
    fromDateEl: { value: '2026-10-02' }, toDateEl: { value: '2026-10-02' }, REFRESH_MS: 3000,
    document: {
      createElement: () => ({ setAttribute() {}, classList: { add() {} }, querySelectorAll: () => [] }),
      getElementById: () => ({ textContent: '' })
    }
  };
  vm.createContext(context);
  const render = tech.slice(tech.indexOf('    function renderTable(){'), tech.indexOf('    // Data fetch helpers'));
  vm.runInContext(render + '\nrenderTable();', context);
  assert.equal(rows.length, 1);
  const html = rows[0].innerHTML;
  assert.equal((html.match(/data-label=/g) || []).length, 10);
  assert.match(html, /data-label="Wt \(lb\)"[^>]*><span>180<\/span>/);
  assert.match(html, /data-label="Skier Type"[^>]*><span>III<\/span>/);
  assert.match(html, /data-intake="synthetic_mobile"/);
  for (const action of ['din', 'liab', 'toggle-hide']) assert.ok(html.includes(`data-action="${action}"`));
});

test('Rental Returns renders both OUT and RETURNED cards with unchanged action targets', async () => {
  const rows = [];
  const nodes = {
    name: { value: '' }, startDate: { value: '2026-10-01' }, endDate: { value: '2026-10-02' },
    statusFilter: { value: 'ALL' }, count: {},
    rows: { innerHTML: '', appendChild: row => rows.push(row), querySelectorAll: () => [] }
  };
  const context = {
    inFlight: null, AbortController, URLSearchParams, setToast() {},
    el: id => nodes[id], fmtDate: value => value, phoneCell: value => value || '',
    document: { createElement: () => ({ setAttribute() {} }) },
    fetch: async () => ({ ok: true, json: async () => ({ rentals: [
      { id: 123, signer_first: 'Synthetic', signer_last: 'Out Example', signed_at: '2026-10-01', status: 'OUT' },
      { id: 124, signer_first: 'Synthetic', signer_last: 'Returned Example', signed_at: '2026-10-01', status: 'RETURNED', returned_at: '2026-10-02' }
    ] }) })
  };
  context.StaffSession={fetch:context.fetch,isReady:()=>true};
  vm.createContext(context);
  const search = returns.slice(returns.indexOf('  async function search() {'), returns.indexOf('  async function doReturn(btn) {'));
  const escapeHTML = returns.slice(returns.indexOf('  function escapeHTML(value) {'), returns.indexOf('  function fmtDate(iso) {'));
  await vm.runInContext(escapeHTML + search + '\nsearch();', context);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal((row.innerHTML.match(/data-label=/g) || []).length, 7);
  assert.match(rows[0].innerHTML, /data-action="return" data-id="123"/);
  assert.match(rows[0].innerHTML, /data-action="note" data-id="123"/);
  assert.doesNotMatch(rows[1].innerHTML, /data-action="return"/);
  assert.match(rows[1].innerHTML, /data-action="note" data-id="124"/);
});
