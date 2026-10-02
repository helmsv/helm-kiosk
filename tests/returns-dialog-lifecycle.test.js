const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../returns.html'), 'utf8');
const start = html.indexOf('  const dialogCleanups');
const end = html.indexOf('  let inFlight', start);
assert.ok(start >= 0 && end > start, 'the dialog lifecycle implementation must be present');

class Node extends EventTarget {
  constructor() { super(); this.open = false; this.value = ''; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}

function harness() {
  const nodes = Object.fromEntries([
    'noteDialog', 'cancelNoteBtn', 'noteForm', 'noteText',
    'returnDialog', 'cancelReturnBtn', 'returnForm', 'returnDate', 'returnComment',
  ].map(id => [id, new Node()]));
  const context = { el: id => nodes[id], setToast() {} };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end) + `
    this.openNote = openNoteDialog;
    this.openReturn = openReturnDialog;
    this.endSession = () => { for (const cleanup of dialogCleanups.values()) cleanup(null); };
    this.pendingDialogs = () => dialogCleanups.size;
  `, context);
  return { nodes, context };
}

for (const kind of ['Note', 'Return']) {
  for (const reason of ['close', 'Escape', 'Cancel button', 'session end']) {
    test(`${kind}: ${reason} cancels A and cannot submit A when B is opened`, async () => {
      const { nodes, context } = harness();
      const prefix = kind.toLowerCase();
      const dialog = nodes[`${prefix}Dialog`];
      const form = nodes[`${prefix}Form`];
      const open = context[`open${kind}`];
      const first = open(kind === 'Return' ? '2026-10-02' : 'Synthetic A note');
      assert.equal(context.pendingDialogs(), 1);
      if (reason === 'close') dialog.close();
      if (reason === 'Escape') dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      if (reason === 'Cancel button') nodes[`cancel${kind}Btn`].dispatchEvent(new Event('click'));
      if (reason === 'session end') context.endSession();
      assert.equal(await first, null, 'the old agreement operation must be canceled');
      assert.equal(dialog.open, false);
      assert.equal(context.pendingDialogs(), 0);

      const second = open(kind === 'Return' ? '2026-10-03' : 'Synthetic B note');
      nodes.noteText.value = 'Only B receives this note';
      nodes.returnComment.value = 'Only B receives this return';
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      const result = await second;
      if (kind === 'Note') assert.equal(result.note, 'Only B receives this note');
      else {
        assert.equal(result.returnDate, '2026-10-03');
        assert.equal(result.comment, 'Only B receives this return');
      }
      assert.equal(context.pendingDialogs(), 0);
      assert.equal(await first, null, 'a later submit cannot revive A');
    });
  }

  test(`${kind}: a repeated open cancels the previous operation and cleanup is idempotent`, async () => {
    const { nodes, context } = harness();
    const open = context[`open${kind}`];
    const first = open(kind === 'Return' ? '2026-10-02' : 'Synthetic A');
    const second = open(kind === 'Return' ? '2026-10-03' : 'Synthetic B');
    assert.equal(await first, null);
    assert.equal(context.pendingDialogs(), 1);
    context.endSession(); context.endSession();
    nodes[`${kind.toLowerCase()}Dialog`].close();
    assert.equal(await second, null);
    assert.equal(context.pendingDialogs(), 0);
  });
}

test('the actual session-ended handler invokes dialog cleanup rather than only hiding dialogs', () => {
  const match = html.match(/window\.addEventListener\('staff-session-ended',[\s\S]*?\n  \}\);/);
  assert.ok(match, 'session-ended handler must exist');
  assert.match(match[0], /dialogCleanups\.values\(\)/);
  assert.match(match[0], /cleanup\(null\)/);
});
