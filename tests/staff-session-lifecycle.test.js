const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../staff-session.js'), 'utf8');
const STAFF_ORIGIN = 'https://helm-snowos.vercel.app';
const KIOSK_ORIGIN = 'https://helm-kiosk.vercel.app';
const TOKEN_A = 'e30.e30.synthetic_a';
const TOKEN_B = 'e30.e30.synthetic_b';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class Node extends EventTarget {
  constructor() { super(); this.hidden = false; this.style = {}; }
  setAttribute() {}
  replaceChildren() {}
  appendChild() {}
}

function harness(fetchImpl = async () => ({ status: 200 })) {
  const host = new Node();
  const messages = [], requests = [], timers = new Map();
  let nextTimer = 0;
  const parent = { postMessage(data, origin) { messages.push({ data, origin }); } };
  host.parent = parent;
  host.location = { href: `${KIOSK_ORIGIN}/tech.html`, origin: KIOSK_ORIGIN };
  const status = new Node();
  const document = {
    readyState: 'complete', getElementById: () => status,
    createElement: () => new Node(), createTextNode: value => value,
    body: { prepend() {} },
  };
  const context = {
    window: host, document, Event, Headers, URL, Date,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  function send(data, origin = STAFF_ORIGIN, sender = parent) {
    const event = new Event('message');
    Object.assign(event, { origin, source: sender, data });
    host.dispatchEvent(event);
  }
  function start(token = TOKEN_A) {
    send({ type: 'snowos-rentals-session', accessToken: token, expiresAt: Date.now() + 60_000 });
  }
  return {
    api: host.StaffSession, host, parent, messages, requests, timers, send, start,
    end: () => send({ type: 'snowos-rentals-session-ended' }),
  };
}

test('only the exact SnowOS parent can provide or end a staff session', () => {
  const h = harness();
  const session = { type: 'snowos-rentals-session', accessToken: TOKEN_A, expiresAt: Date.now() + 60_000 };
  h.send(session, 'https://attacker.invalid');
  h.send(session, STAFF_ORIGIN, {});
  assert.equal(h.api.isReady(), false);
  h.start();
  assert.equal(h.api.isReady(), true);
  h.send({ type: 'snowos-rentals-session-ended' }, 'https://attacker.invalid');
  h.send({ type: 'snowos-rentals-session-ended' }, STAFF_ORIGIN, {});
  assert.equal(h.api.isReady(), true);
  h.end();
  assert.equal(h.api.isReady(), false);
  assert.ok(h.messages.every(message => message.origin === STAFF_ORIGIN));
});

test('staff fetch adds only a same-origin header and disallows another credential destination', async () => {
  const h = harness();
  h.start();
  await h.api.fetch('/api/intake-details?waiverId=synthetic_intake');
  assert.equal(h.requests.length, 1);
  const { url, options } = h.requests[0];
  assert.equal(new URL(url).origin, KIOSK_ORIGIN);
  assert.equal(options.headers.get('Authorization'), `Bearer ${TOKEN_A}`);
  assert.equal(options.cache, 'no-store');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.ok(!url.includes(TOKEN_A));
  await assert.rejects(h.api.fetch('https://attacker.invalid/customer'), /inside the rental app/);
  assert.equal(h.requests.length, 1);
});

test('a successful response from session A is rejected after logout and session B sign-in', async () => {
  const upstream = deferred();
  const h = harness(() => upstream.promise);
  h.start();
  const pending = h.api.fetch('/api/intake-details');
  await Promise.resolve();
  assert.equal(h.requests.length, 1);
  h.end(); h.start(TOKEN_B);
  upstream.resolve({ status: 200, json: async () => ({ customer: 'synthetic A' }) });
  await assert.rejects(pending, /session changed/);
  assert.equal(h.api.isReady(), true, 'the new session remains usable');
});

test('delayed response bodies from session A are rejected even after fetch has resolved', async () => {
  for (const method of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
    const body = deferred();
    const h = harness(async () => ({ status: 200, [method]: () => body.promise }));
    h.start();
    const response = await h.api.fetch('/api/intake-details');
    const pending = response[method]();
    h.end(); h.start(TOKEN_B);
    body.resolve({ customer: 'synthetic A' });
    await assert.rejects(pending, /session changed/, method);
  }
});

test('clear rejects pending ready and fetch waiters rather than replaying actions on later login', async () => {
  const h = harness(async () => assert.fail('An ended session must not replay a queued action'));
  const ready = h.api.ready();
  const pending = h.api.fetch('/api/rentals-note', { method: 'POST' });
  h.end();
  await assert.rejects(ready, /session ended/);
  await assert.rejects(pending, /session ended/);
  h.start(TOKEN_B);
  await Promise.resolve();
  assert.equal(h.requests.length, 0);
});

test('pagehide clears the lease and customer UI; pageshow requests a fresh handshake', () => {
  const h = harness();
  let ended = 0;
  h.host.addEventListener('staff-session-ended', () => { ended++; });
  h.start();
  h.host.dispatchEvent(new Event('pagehide'));
  assert.equal(h.api.isReady(), false);
  assert.equal(ended, 1);
  assert.equal(h.timers.size, 0);
  const before = h.messages.length;
  h.host.dispatchEvent(new Event('pageshow'));
  assert.equal(h.messages.length, before + 1);
  assert.equal(h.messages.at(-1).data.type, 'snowos-rentals-ready');
});

test('a replacement token invalidates old reads even without an explicit session-ended message', async () => {
  const upstream = deferred();
  const h = harness(() => upstream.promise);
  let ended = 0;
  h.host.addEventListener('staff-session-ended', () => { ended++; });
  h.start();
  const pending = h.api.fetch('/api/intake-details');
  await Promise.resolve();
  h.start(TOKEN_B);
  upstream.resolve({ status: 200 });
  await assert.rejects(pending, /session changed/);
  assert.equal(ended, 1);
});
