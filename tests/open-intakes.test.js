const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./fixtures/intake.json');
const source = fs.readFileSync(path.join(__dirname, '../api/open-intakes.js'), 'utf8');
const input = { method: 'GET', query: { from: '2026-10-02', to: '2026-10-02' } };
function response() { return { headers: {}, statusCode: 200, setHeader(key, value) { this.headers[key] = value; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } }; }
function loadHandler({ authorize, request } = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => {
    if (name === '../lib/staff-auth') return { requireStaff: authorize || (async () => {}) };
    if (name === '../lib/smartwaiver') return { ...require(name), ...(request ? { request } : {}) };
    return require(name);
  }, module, module.exports);
  return module.exports;
}
async function configured(run) {
  const previous = { ...process.env };
  process.env.SW_API_KEY = 'synthetic_staff_intake_key';
  process.env.INTAKE_WAIVER_ID = fixture.templateId;
  try { await run(); } finally { process.env = previous; }
}
function requestFixture(calls) { return async route => {
  calls.push(route);
  return route.startsWith('/waivers?') ? { waivers: [{ waiverId: fixture.waiverId, templateId: fixture.templateId, createdOn: '2026-10-02 09:00:00' }] } : { waiver: fixture };
}; }

test('staff authentication rejects missing/invalid/unauthorized sessions before any upstream read or cache return', async () => configured(async () => {
  for (const status of [401, 403, 503]) {
    let allowed = true, count = 0;
    const handler = loadHandler({ authorize: async () => { if (!allowed) throw Object.assign(new Error('PRIVATE_AUTH_TOKEN'), { status }); }, request: async route => { count++; return requestFixture([])(route); } });
    const good = response(); await handler(input, good); assert.equal(good.statusCode, 200); assert.equal(count, 2);
    allowed = false;
    const bad = response(); await handler(input, bad);
    assert.equal(bad.statusCode, status); assert.deepEqual(bad.body.rows, []); assert.equal(count, 2);
    assert.equal(bad.headers['Cache-Control'], 'private, no-store'); assert.doesNotMatch(JSON.stringify(bad.body), /PRIVATE|synthetic_staff_intake_key/);
  }
}));

test('authentication completes before Smartwaiver reads and all participant rows stay private', async () => configured(async () => {
  const calls = [];
  const handler = loadHandler({ authorize: async () => calls.push('staff-authorized'), request: requestFixture(calls) });
  const res = response(); await handler(input, res);
  assert.equal(calls[0], 'staff-authorized'); assert.equal(calls.length, 3);
  assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.body.count, 2); assert.equal(res.body.rows[0].weight_lb, 180); assert.equal(res.body.rows[1].participant_index, 1);
  assert.equal(res.body.from, '2026-10-02T00:00:00.000Z'); assert.equal(res.body.to, '2026-10-03T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(res.body), /date_of_birth|1985-10-03|2017-10-02|customParticipantFields|synthetic_staff_intake_key/);
}));

test('invalid ranges/pages and mutation methods fail without calling Smartwaiver', async () => configured(async () => {
  const handler = loadHandler({ request: async () => assert.fail('must not fetch') });
  for (const query of [{ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-03', to: '2026-10-01' }, { from: ['2026-10-02'], to: '2026-10-02' }, { from: '2026-10-02' }, { ...input.query, page: ['0'] }, { ...input.query, page: '-1' }]) {
    const res = response(); await handler({ ...input, query }, res); assert.equal(res.statusCode, 400);
  }
  const badMethod = response(); await handler({ ...input, method: 'POST' }, badMethod);
  assert.equal(badMethod.statusCode, 405); assert.equal(badMethod.headers.Allow, 'GET');
}));

test('missing Smartwaiver configuration fails safely after authentication', async () => configured(async () => {
  let authorized = false;
  delete process.env.SW_API_KEY; delete process.env.SMARTWAIVER_API_KEY;
  const handler = loadHandler({ authorize: async () => { authorized = true; }, request: async () => assert.fail('must not fetch') });
  const res = response(); await handler(input, res); assert.equal(authorized, true); assert.equal(res.statusCode, 503);
}));

test('upstream errors are sanitized and 429 exposes only safe retry information', async () => configured(async () => {
  for (const [upstreamStatus, expected] of [[403, 502], [500, 502], [429, 429]]) {
    const handler = loadHandler({ request: async () => { throw Object.assign(new Error('SENSITIVE_UPSTREAM API_SECRET'), { status: upstreamStatus, retryAfterSeconds: 90 }); } });
    const res = response(); await handler(input, res);
    assert.equal(res.statusCode, expected); assert.doesNotMatch(JSON.stringify(res.body), /SENSITIVE|API_SECRET/);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    if (upstreamStatus === 429) { assert.equal(res.headers['Retry-After'], '90'); assert.equal(res.body.retry_after_seconds, 90); }
  }
}));

test('server-side account-key changes never reuse another account detail cache', async () => configured(async () => {
  let calls = 0;
  const handler = loadHandler({ request: async route => { calls++; return requestFixture([])(route); } });
  await handler(input, response()); assert.equal(calls, 2);
  await handler(input, response()); assert.equal(calls, 2);
  process.env.SW_API_KEY = 'synthetic_second_account_key';
  await handler(input, response()); assert.equal(calls, 4);
}));

test('real staff gate verifies SnowOS before Smartwaiver and rechecks authorization on cached results', async () => configured(async () => {
  const priorFetch = global.fetch;
  const calls = [];
  let staffAuthorized = true;
  process.env.SW_BASE_URL = 'https://api.smartwaiver.com';
  const token = 'e30.e30.synthetic_signature';
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://helm-snowos.vercel.app/api/rentals/authorize') {
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      return { ok: staffAuthorized, status: staffAuthorized ? 200 : 403, json: async () => ({ authorized: staffAuthorized }) };
    }
    assert.equal(options.headers.Authorization, 'Bearer synthetic_staff_intake_key', 'the staff token must never reach Smartwaiver');
    return { ok: true, json: async () => url.includes('/waivers?') ? { waivers: [{ waiverId: fixture.waiverId, templateId: fixture.templateId, createdOn: '2026-10-02 09:00:00' }] } : { waiver: fixture } };
  };
  try {
    delete require.cache[require.resolve('../api/open-intakes')];
    const handler = require('../api/open-intakes');
    const missing = response(); await handler(input, missing);
    assert.equal(missing.statusCode, 401); assert.equal(calls.length, 0);
    const authorized = response();
    await handler({ ...input, headers: { authorization: `Bearer ${token}` } }, authorized);
    assert.equal(authorized.statusCode, 200); assert.equal(authorized.body.count, 2); assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://helm-snowos.vercel.app/api/rentals/authorize');
    staffAuthorized = false;
    const revoked = response(); await handler({ ...input, headers: { authorization: `Bearer ${token}` } }, revoked);
    assert.equal(revoked.statusCode, 403); assert.equal(calls.length, 4); assert.deepEqual(revoked.body.rows, []);
    assert.doesNotMatch(JSON.stringify(authorized.body), /synthetic_signature|synthetic_staff_intake_key/);
  } finally { global.fetch = priorFetch; delete require.cache[require.resolve('../api/open-intakes')]; }
}));
