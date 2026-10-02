const test = require('node:test');
const assert = require('node:assert/strict');
const { request, retryAfterSeconds } = require('../lib/smartwaiver');

test('Retry-After supports seconds and HTTP dates with a conservative safe fallback', () => {
  const time = Date.parse('2026-10-02T12:00:00Z');
  const response = value => ({ headers: { get: () => value } });
  assert.equal(retryAfterSeconds(response('120'), time), 120);
  assert.equal(retryAfterSeconds(response('0'), time), 1);
  assert.equal(retryAfterSeconds(response('Fri, 02 Oct 2026 12:01:30 GMT'), time), 90);
  for (const value of [null, '', '-1', 'SECRET', 'Fri, 02 Oct 2026 11:00:00 GMT', '9'.repeat(100)]) assert.equal(retryAfterSeconds(response(value), time), 60);
  assert.equal(retryAfterSeconds({}, time), 60);
});

test('shared client propagates sanitized 429 retry delay without consuming upstream body', async () => {
  const previousFetch = global.fetch, previous = { ...process.env };
  process.env.SW_API_KEY = 'synthetic_key';
  global.fetch = async () => ({ ok: false, status: 429, headers: { get: () => '75' }, text: async () => assert.fail('must not read upstream error body') });
  try { await assert.rejects(request('/waivers'), cause => cause.status === 429 && cause.retryAfterSeconds === 75 && !cause.message.includes('synthetic_key')); }
  finally { global.fetch = previousFetch; process.env = previous; }
});
