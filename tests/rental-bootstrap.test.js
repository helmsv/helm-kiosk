const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('pending liability starts its staff-gated refresh without an unused config handshake', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../tech.html'), 'utf8');
  const start = html.indexOf('    // Boot');
  const code = html.slice(html.indexOf('    (async ()=>{', start), html.indexOf('  </script>', start));
  assert.ok(start >= 0 && code.includes('refreshPoll'));
  const calls = [], context = {
    showHidden: true, REFRESH_MS: 15000,
    reflectHiddenToggle() { calls.push('hidden'); },
    setDefaultDatesToday() { calls.push('dates'); },
    refreshPoll: async () => { calls.push('staff-gated-refresh'); },
    setInterval(fn, delay) { calls.push(['interval', delay]); assert.equal(fn, context.refreshPoll); },
    StaffSession: { fetch() { assert.fail('Boot must not request the unused configuration'); } },
    showToast() { assert.fail('No false config failure warning'); },
  };
  await vm.runInNewContext(code, context);
  assert.equal(context.showHidden, false);
  assert.deepEqual(calls, ['hidden', 'dates', 'staff-gated-refresh', ['interval', 15000]]);
  assert.doesNotMatch(html, /LIABILITY_WAIVER_ID|config fetch failed|Failed to load config/);
});

for (const reason of ['unavailable', 'closed', 'denied', undefined, 'untrusted explanation']) {
  const expected = reason === 'unavailable' ? 'Staff verification is temporarily unavailable. Reconnecting…'
    : reason === 'closed' ? 'Reconnecting to SnowOS staff access…' : 'Staff sign-in is required.';
  test(`both rental pages clear private state and use fixed wording for ${String(reason)}`, () => {
    for (const filename of ['tech.html', 'returns.html']) {
      const html = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
      const start = html.indexOf("window.addEventListener('staff-session-ended'");
      const end = html.indexOf("window.addEventListener('staff-session-ready'", start);
      assert.ok(start >= 0 && end > start);
      const nodes = new Map(), calls = [];
      function node(id) { if (!nodes.has(id)) nodes.set(id, { textContent: 'private value', value: 'private note', replaceChildren() { calls.push(`clear:${id}`); } }); return nodes.get(id); }
      let handler;
      const context = {
        window: { addEventListener(type, callback) { assert.equal(type, 'staff-session-ended'); handler = callback; } },
        document: { getElementById: node }, el: node,
        refreshGeneration: 0, dinRequestId: 0, current: {}, activeIntakeDetails: {}, activeIntakeMeta: {},
        store: new Map([['private', {}]]), hiddenSet: new Set(['private']), tb: node('tbody'),
        dinDialog: { hide(options) { assert.equal(options.restoreFocus, false); calls.push('hide:din'); } },
        inFlight: { abort() { calls.push('abort'); } },
        dialogCleanups: new Map([['private', result => { assert.equal(result, null); calls.push('cancel:dialog'); }]]),
        setToast(value) { calls.push(`toast:${value}`); },
      };
      vm.runInNewContext(html.slice(start, end), context);
      handler({ reason });
      if (filename === 'tech.html') {
        assert.equal(context.current, null); assert.equal(context.activeIntakeDetails, null); assert.equal(context.activeIntakeMeta, null);
        assert.equal(context.store.size, 0); assert.equal(context.hiddenSet.size, 0);
        assert.equal(context.refreshGeneration, 1); assert.equal(context.dinRequestId, 1);
        assert.ok(calls.includes('clear:tbody')); assert.ok(calls.includes('hide:din'));
        assert.equal(node('intakeLoadStatus').textContent, expected);
        assert.equal(node('waiverSetupResult').textContent, '');
      } else {
        assert.ok(calls.includes('abort')); assert.ok(calls.includes('clear:rows')); assert.ok(calls.includes('cancel:dialog'));
        assert.equal(node('count').textContent, ''); assert.equal(node('returnComment').value, ''); assert.equal(node('noteText').value, '');
        assert.ok(calls.includes(`toast:${expected}`));
      }
    }
  });
}
