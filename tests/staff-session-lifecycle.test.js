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
  constructor() { super(); this.hidden = false; this.style = {}; this.children = []; }
  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  appendChild(child) { this.children.push(child); }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent || '').join(''); }
  set textContent(value) { this.children = [value]; }
}

function harness(fetchImpl = async () => ({ status: 200 })) {
  const host = new Node();
  const messages = [], requests = [], timers = new Map(), timerDelays = new Map();
  let nextTimer = 0, now = Date.now();
  class Clock extends Date { static now() { return now; } }
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
    window: host, document, Event, Headers, URL, Date: Clock,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, fn); timerDelays.set(id, delay); return id; },
    clearTimeout(id) { timers.delete(id); timerDelays.delete(id); },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  function send(data, origin = STAFF_ORIGIN, sender = parent) {
    const event = new Event('message');
    Object.assign(event, { origin, source: sender, data });
    host.dispatchEvent(event);
  }
  function start(token = TOKEN_A, leaseMs = 60_000) {
    send({ type: 'snowos-rentals-session', accessToken: token, expiresAt: now + leaseMs });
  }
  function fireTimers(delay) {
    for (const [id, fn] of [...timers]) {
      if (timerDelays.get(id) !== delay) continue;
      timers.delete(id); timerDelays.delete(id); fn();
    }
  }
  return {
    api: host.StaffSession, host, parent, messages, requests, timers, send, start, status, fireTimers,
    now: () => now, advance: ms => { now += ms; },
    end: reason => send({ type: 'snowos-rentals-session-ended', ...(reason === undefined ? {} : { reason }) }),
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

test('same-token valid lease renewals extend expiry without ready events or invalidating in-flight work', async () => {
  const upstream = deferred();
  const h = harness(() => upstream.promise);
  let ready = 0, ended = 0;
  h.host.addEventListener('staff-session-ready', () => { ready++; });
  h.host.addEventListener('staff-session-ended', () => { ended++; });
  h.start();
  const pending = h.api.fetch('/api/intake-details');
  await Promise.resolve();
  h.advance(20_000); h.start(); h.start();
  upstream.resolve({ status: 200, json: async () => ({ synthetic: true }) });
  assert.deepEqual(await (await pending).json(), { synthetic: true });
  assert.equal(ready, 1, 'lease heartbeats must not restart table loads');
  assert.equal(ended, 0);
  assert.equal(h.timers.size, 1, 'only the latest expiry timer remains');
  h.advance(41_000);
  assert.equal(h.api.isReady(), true, 'the renewed lease replaces the original expiry');
});

test('first ready waiters resolve once while subsequent valid renewal remains quiet', async () => {
  const h = harness();
  let ready = 0;
  h.host.addEventListener('staff-session-ready', () => { ready++; });
  const waiting = [h.api.ready(), h.api.ready()];
  h.start(); await Promise.all(waiting);
  h.start();
  assert.equal(ready, 1);
  assert.equal(h.api.isReady(), true);
  assert.equal(h.timers.size, 1);
});

test('end reasons change only wording and always invalidate credentials, old responses and private UI', async () => {
  const expected = new Map([
    ['unavailable', 'Staff verification is temporarily unavailable. Reconnecting…'],
    ['closed', 'Reconnecting to SnowOS staff access…'],
    ['denied', 'Your staff session ended. Sign in again.'],
    [undefined, 'Your staff session ended. Sign in again.'],
    ['unrecognized', 'Your staff session ended. Sign in again.'],
    ['<script>untrusted reason</script>', 'Your staff session ended. Sign in again.'],
  ]);
  for (const [reason, message] of expected) {
    const upstream = deferred();
    const h = harness(() => upstream.promise);
    let ended = 0, emittedReason;
    h.host.addEventListener('staff-session-ended', event => { ended++; emittedReason = event.reason; });
    h.start();
    const pending = h.api.fetch('/api/intake-details');
    await Promise.resolve();
    h.end(reason);
    assert.equal(h.api.isReady(), false, String(reason));
    assert.equal(h.timers.size, 0, String(reason));
    assert.equal(ended, 1, 'page handlers must erase data and dialogs');
    assert.equal(emittedReason, reason === 'unavailable' || reason === 'closed' ? reason : 'denied');
    assert.ok(h.status.textContent.startsWith(message + ' '), String(reason));
    assert.equal(h.status.hidden, false);
    h.start(TOKEN_B);
    upstream.resolve({ status: 200 });
    await assert.rejects(pending, /session changed/);
  }
});

test('every end reason rejects waiters and never replays queued mutations after reconnection', async () => {
  for (const reason of ['unavailable', 'closed', 'denied', undefined, 'unknown']) {
    const h = harness(async () => assert.fail('Queued mutation must not replay'));
    const ready = h.api.ready();
    const action = h.api.fetch('/api/rentals-note', { method: 'POST' });
    h.end(reason);
    const expected = reason === 'unavailable' ? { message: 'Staff verification is temporarily unavailable. Reconnecting…' }
      : reason === 'closed' ? { message: 'Reconnecting to SnowOS staff access…' } : /session ended/;
    await assert.rejects(ready, expected);
    await assert.rejects(action, expected);
    h.start(); await Promise.resolve();
    assert.equal(h.requests.length, 0);
  }
});

test('handshakes are deduplicated but host-ready, pageshow and timeout retry still work', async () => {
  const h = harness();
  const initial = h.messages.length;
  const waiting = [h.api.ready(), h.api.ready(), h.api.ready()];
  assert.equal(h.messages.length, initial, 'reuse the initial outstanding handshake');
  h.send({ type: 'snowos-rentals-host-ready' });
  assert.equal(h.messages.length, initial + 1, 'host-ready must always receive a reply');
  h.host.dispatchEvent(new Event('pageshow'));
  assert.equal(h.messages.length, initial + 2, 'restoration must always request a session');
  h.fireTimers(12_000);
  for (const waiter of waiting) await assert.rejects(waiter, /sign-in is required/);
  const retry = h.api.ready();
  assert.equal(h.messages.length, initial + 3, 'a manual retry after timeout sends a new request');
  h.start(); await retry;
  assert.equal(h.timers.size, 1);
});

test('expiry clears the lease and UI before requesting a new session', async () => {
  const upstream = deferred();
  const h = harness(() => upstream.promise);
  let ended = 0;
  h.host.addEventListener('staff-session-ended', () => { ended++; });
  h.start();
  const pending = h.api.fetch('/api/intake-details');
  await Promise.resolve();
  h.advance(60_000); h.fireTimers(60_000);
  assert.equal(h.api.isReady(), false);
  assert.equal(ended, 1);
  assert.match(h.status.textContent, /session expired\. Sign in again\./);
  assert.equal(h.messages.at(-1).data.type, 'snowos-rentals-ready');
  h.start(); upstream.resolve({ status: 200 });
  await assert.rejects(pending, /session changed/);
});

test('a renewal after a throttled expiry timer still invalidates the expired epoch', async () => {
  const upstream = deferred();
  const h = harness(() => upstream.promise);
  let ready = 0, ended = 0;
  h.host.addEventListener('staff-session-ready', () => { ready++; });
  h.host.addEventListener('staff-session-ended', () => { ended++; });
  h.start(); const pending = h.api.fetch('/api/intake-details'); await Promise.resolve();
  h.advance(60_001); h.start();
  assert.equal(ended, 1);
  assert.equal(ready, 2);
  upstream.resolve({ status: 200 });
  await assert.rejects(pending, /session changed/);
});

test('replacement credentials still clear the old epoch and announce a fresh ready transition', () => {
  const h = harness();
  let ready = 0, ended = 0;
  h.host.addEventListener('staff-session-ready', () => { ready++; });
  h.host.addEventListener('staff-session-ended', () => { ended++; });
  h.start(); h.start(TOKEN_B);
  assert.equal(ready, 2); assert.equal(ended, 1);
  assert.equal(h.api.isReady(), true);
});

test('unknown message types and untrusted sources cannot change state or force handshakes', () => {
  const h = harness(); h.start();
  const before = h.messages.length;
  for (const data of [null, {}, { type: 'snowos-rentals-pending' }, { type: 'snowos-rentals-session-ended', reason: 'unavailable' }, { type: 'snowos-rentals-host-ready' }]) {
    h.send(data, 'https://attacker.invalid'); h.send(data, STAFF_ORIGIN, {});
  }
  h.send({ type: 'snowos-rentals-pending', accessToken: 'invalid' });
  assert.equal(h.api.isReady(), true); assert.equal(h.messages.length, before);
  assert.equal(h.status.hidden, true);
});

test('invalid or already-expired delivered leases fail closed', () => {
  for (const patch of [{ accessToken: 'not-a-token' }, { expiresAt: 0 }, { expiresAt: NaN }]) {
    const h = harness(); h.start();
    h.send({ type: 'snowos-rentals-session', accessToken: TOKEN_A, expiresAt: h.now() + 60_000, ...patch });
    assert.equal(h.api.isReady(), false); assert.equal(h.timers.size, 0);
    assert.equal(h.status.hidden, false);
  }
});

test('actual 401 and 403 responses still revoke the lease, discard bodies and request fresh authentication', async () => {
  for (const status of [401, 403]) {
    const h = harness(async () => ({ status, json: async () => ({ error: 'synthetic denial' }) }));
    let ended = 0;
    h.host.addEventListener('staff-session-ended', () => { ended++; });
    h.start(); const before = h.messages.length;
    const response = await h.api.fetch('/api/open-intakes');
    assert.equal(response.status, status);
    assert.equal(h.api.isReady(), false); assert.equal(ended, 1);
    assert.match(h.status.textContent, /session needs to be refreshed/);
    assert.equal(h.messages.length, before + 1);
    await assert.rejects(response.json(), /session changed/);
  }
});


test('pagehide and unexpired token replacement carry closed while true expiry remains denied', () => {
  const h = harness(); const reasons = [];
  h.host.addEventListener('staff-session-ended', event => reasons.push(event.reason));
  h.start(); h.start(TOKEN_B);
  assert.equal(reasons.at(-1), 'closed');
  h.host.dispatchEvent(new Event('pagehide'));
  assert.equal(reasons.at(-1), 'closed');
  assert.match(h.status.textContent, /Reconnecting to SnowOS staff access/);
  h.start(); h.advance(60_000); h.fireTimers(60_000);
  assert.equal(reasons.at(-1), 'denied');
  assert.match(h.status.textContent, /session expired\. Sign in again/);
});
