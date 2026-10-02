const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../rental-dialog');

function fixture() {
  const listeners = new Map();
  const doc = {
    documentElement: { style: { overflow: 'auto' } }, activeElement: null,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }
  };
  function node(tagName = 'BUTTON', parent = null) {
    const item = {
      tagName, parentElement: parent, ownerDocument: doc, isConnected: true,
      disabled: false, tabIndex: 0, inert: false, attrs: {}, children: [],
      setAttribute(key, value) { this.attrs[key] = value; },
      getClientRects: () => [{}],
      closest() { let current = this; while (current) { if (current.inert) return current; current = current.parentElement; } return null; },
      focus(options) { this.lastFocusOptions = options; doc.activeElement = this; }, blur() { doc.activeElement = doc.body; },
      contains(other) { while (other) { if (other === this) return true; other = other.parentElement; } return false; }
    };
    if (parent) parent.children.push(item);
    return item;
  }
  doc.body = node('BODY');
  const main = node('MAIN', doc.body), alreadyInert = node('ASIDE', doc.body);
  alreadyInert.inert = true;
  const root = node('DIV', doc.body), opener = node('BUTTON', main), fallback = node('BUTTON', main);
  node('SCRIPT', doc.body);
  const classes = new Set(['hidden']);
  root.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  const close = node('BUTTON', root), select = node('SELECT', root), disabled = node('BUTTON', root), last = node('BUTTON', root);
  disabled.disabled = true;
  root.querySelectorAll = () => [close, select, disabled, last];
  const scroll = { scrollTop: 120 };
  let dismisses = 0;
  const dialog = create(root, { initialFocus: close, scrollRegion: scroll, returnFocusFallback: fallback, onDismiss: () => { dismisses++; dialog.hide(); } });
  const fire = (type, fields) => {
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...fields };
    for (const listener of [...(listeners.get(type) || [])]) listener(event);
    return event;
  };
  opener.focus();
  return { doc, root, opener, fallback, main, alreadyInert, close, select, last, scroll, dialog, listeners, fire, get dismisses() { return dismisses; } };
}

test('opening a DIN dialog isolates background, focuses Close and resets only its scroll region', () => {
  const f = fixture();
  f.dialog.show(f.opener);
  assert.equal(f.dialog.isOpen(), true);
  assert.equal(f.doc.activeElement, f.close);
  assert.equal(f.main.inert, true);
  assert.equal(f.doc.documentElement.style.overflow, 'hidden');
  assert.equal(f.root.attrs['aria-hidden'], 'false');
  assert.equal(f.scroll.scrollTop, 0);
});

test('participant changes do not refocus, reset scroll, duplicate listeners or lose the opener', () => {
  const f = fixture();
  f.dialog.show(f.opener);
  f.select.focus(); f.scroll.scrollTop = 75;
  f.dialog.show(f.select);
  assert.equal(f.doc.activeElement, f.select);
  assert.equal(f.scroll.scrollTop, 75);
  assert.equal(f.listeners.get('keydown').size, 1);
  f.dialog.hide();
  assert.equal(f.doc.activeElement, f.opener);
  assert.equal(f.main.inert, false);
  assert.equal(f.alreadyInert.inert, true);
  assert.equal(f.doc.documentElement.style.overflow, 'auto');
  f.doc.documentElement.style.overflow = 'scroll';
  f.dialog.hide();
  assert.equal(f.doc.documentElement.style.overflow, 'scroll', 'repeated close does not restore stale state');
  assert.equal(f.listeners.get('keydown').size, 0);
});

test('Tab and Shift+Tab wrap, and programmatic focus outside is redirected', () => {
  const f = fixture(); f.dialog.show(f.opener);
  let event = f.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(event.prevented, true); assert.equal(f.doc.activeElement, f.last);
  assert.equal(f.last.lastFocusOptions.preventScroll, false, 'keyboard wrap reveals an offscreen control');
  event = f.fire('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(event.prevented, true); assert.equal(f.doc.activeElement, f.close);
  assert.equal(f.close.lastFocusOptions.preventScroll, false);
  f.fire('focusin', { target: f.opener });
  assert.equal(f.doc.activeElement, f.close);
});

test('Escape closes exactly once and restores focus without leaving background inert', () => {
  const f = fixture(); f.dialog.show(f.opener);
  const event = f.fire('keydown', { key: 'Escape' });
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.equal(f.dismisses, 1); assert.equal(f.dialog.isOpen(), false);
  assert.equal(f.doc.activeElement, f.opener); assert.equal(f.main.inert, false);
  assert.equal(f.root.attrs['aria-hidden'], 'true');
  f.fire('keydown', { key: 'Escape' }); assert.equal(f.dismisses, 1);
});

test('a polled-away row restores focus to a live fallback; session end blurs hidden controls', () => {
  const f = fixture(); f.dialog.show(f.opener); f.opener.isConnected = false;
  f.dialog.hide(); assert.equal(f.doc.activeElement, f.fallback);
  f.dialog.show(f.fallback); f.dialog.hide({ restoreFocus: false });
  assert.equal(f.doc.activeElement, f.doc.body); assert.equal(f.main.inert, false);
  f.scroll.scrollTop = 100; f.dialog.show(f.fallback); assert.equal(f.scroll.scrollTop, 0);
});
