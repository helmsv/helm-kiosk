const test = require('node:test');
const assert = require('node:assert/strict');
const sw = require('../lib/smartwaiver');

const SECRET = 'PRIVATE_PROVIDER_VALUE_DO_NOT_EXPOSE';
const INTAKE = 'synthetic_intake_template';
const LIABILITY = 'synthetic_liability_template';
const WAIVER = 'synthetic_private_waiver';
require('./fixtures/technician-enum-contract')([LIABILITY]);
const AUTH = 'https://helm-snowos.vercel.app/api/rentals/authorize';
const request = (body, authorization = 'Bearer synthetic.staff.session') => ({
  method: 'POST', headers: { host: 'kiosk.example', origin: 'https://kiosk.example', 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body,
});
const response = () => ({
  headers: {}, statusCode: 200,
  setHeader(name, value) { this.headers[name] = value; },
  status(value) { this.statusCode = value; return this; },
  json(value) { this.body = value; return this; },
});
const success = body => ({ ok: true, status: 200, json: async () => body });
function failure(status, retryAfter = '83') {
  return {
    ok: false, status, headers: { get: name => name === 'retry-after' ? retryAfter : SECRET },
    json: async () => assert.fail('Never read provider error JSON: ' + SECRET),
    text: async () => assert.fail('Never read provider error text: ' + SECRET),
  };
}

async function environment(action) {
  const oldFetch = global.fetch, oldEnv = { ...process.env };
  process.env.SW_API_KEY = SECRET;
  process.env.SW_BASE_URL = 'https://api.smartwaiver.com';
  process.env.INTAKE_WAIVER_ID = INTAKE;
  process.env.LIABILITY_WAIVER_ID = LIABILITY;
  try { return await action(); }
  finally { global.fetch = oldFetch; process.env = oldEnv; }
}

function assertPrivate(out) {
  const serialized = JSON.stringify({ headers: out.headers, body: out.body });
  for (const value of [SECRET, INTAKE, LIABILITY, WAIVER, 'synthetic.staff.session', 'example.invalid', '1990-01-01', 'https://', 'Bearer']) {
    assert.equal(serialized.includes(value), false, 'Private value escaped: ' + value);
  }
  assert.equal(out.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(Object.keys(out.body), ['error']);
}

// Reloading the handler resets its private template cache for every case.
async function invoke({ phase, providerStatus = 402, mode = 'http', auth = true, authorized = true, rejectSecondAuth = false, body } = {}) {
  delete require.cache[require.resolve('../api/waiver-prefill')];
  const handler = require('../api/waiver-prefill');
  const calls = [];
  let authCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (url === AUTH) {
      calls.push('staff-auth');
      authCalls += 1;
      return authorized && !(rejectSecondAuth && authCalls === 2) ? success({ authorized: true }) : failure(403);
    }
    const operation = url.endsWith('/prefill') ? 'prefill-create'
      : url.includes('/waivers/') ? 'intake-read'
      : url.includes(INTAKE) ? 'intake-template' : 'liability-template';
    calls.push(operation);
    assert.equal(options.headers.Authorization, 'Bearer ' + SECRET);
    if (operation === phase) {
      if (mode === 'network') throw new Error('Provider transport token ' + SECRET);
      if (mode === 'json') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid provider JSON ' + SECRET); } };
      if (mode === 'null') return success(null);
      if (mode === 'template-mismatch') return success({ template: { templateId: SECRET } });
      return failure(providerStatus);
    }
    if (operation === 'intake-read') return success({ waiver: {
      waiverId: WAIVER, templateId: INTAKE, email: 'private@example.invalid',
      participants: [{ firstName: SECRET, lastName: 'Synthetic', dob: '1990-01-01', isMinor: false }],
    } });
    if (operation === 'intake-template' || operation === 'liability-template') return success({ template: { templateId: operation === 'intake-template' ? INTAKE : LIABILITY, customParticipantFields: [] } });
    assert.equal(options.method, 'POST');
    if (phase === 'prefill-response') {
      if (mode === 'missing-id') return success({ prefill: { url: 'https://waiver.smartwaiver.com/p/' + SECRET } });
      if (mode === 'null') return success(null);
      return success({ prefill: { uuid: SECRET, url: 'https://untrusted.example/p/' + SECRET } });
    }
    return success({ prefill: { uuid: 'synthetic_link', url: 'https://waiver.smartwaiver.com/p/synthetic_link/' } });
  };
  const out = response();
  await handler(request(body || { stage: 'liability', waiverId: WAIVER }, auth ? 'Bearer synthetic.staff.session' : ''), out);
  return { out, calls };
}

test('shared client keeps only numeric HTTP status and never consumes failed response bodies', async () => environment(async () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500]) {
    global.fetch = async () => failure(status);
    await assert.rejects(sw.request('/synthetic/' + SECRET), error => {
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.status, status === 404 || status === 429 ? status : 502);
      assert.equal(error.retryAfterSeconds, status === 429 ? 83 : undefined);
      assert.equal(JSON.stringify(error).includes(SECRET), false);
      assert.equal(error.message.includes(SECRET), false);
      return true;
    });
  }
  global.fetch = async () => failure(SECRET);
  await assert.rejects(sw.request('/synthetic'), error => error.status === 502 && error.upstreamStatus === undefined);
}));

test('shared client sanitizes transport and successful-status JSON parsing errors', async () => environment(async () => {
  global.fetch = async () => { throw new Error(SECRET); };
  await assert.rejects(sw.request('/synthetic'), error => error.status === 502 && error.upstreamStatus === undefined && !error.message.includes(SECRET));
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(SECRET); } });
  await assert.rejects(sw.request('/synthetic'), error => error.status === 502 && error.upstreamStatus === 200 && !error.message.includes(SECRET));
}));

test('each concurrent read/template and create failure reports only its fixed operation and status', async () => environment(async () => {
  for (const phase of ['intake-read', 'intake-template', 'liability-template', 'prefill-create']) {
    const { out } = await invoke({ phase });
    assert.equal(out.statusCode, 502);
    assert.ok(out.body.error.endsWith(`[${phase}; HTTP 402]`));
    assertPrivate(out);
  }
}));

test('local template mismatch, transport and response-validation errors retain safe boundaries', async () => environment(async () => {
  const cases = [
    ['intake-template', 'template-mismatch', 'intake-template'],
    ['liability-template', 'template-mismatch', 'liability-template'],
    ['intake-read', 'network', 'intake-read'],
    ['intake-read', 'null', 'intake-read'],
    ['prefill-create', 'network', 'prefill-create'],
    ['prefill-response', 'missing-id', 'prefill-response'],
    ['prefill-response', 'url', 'prefill-response'],
    ['prefill-response', 'null', 'prefill-response'],
  ];
  for (const [phase, mode, expected] of cases) {
    const { out } = await invoke({ phase, mode });
    assert.equal(out.statusCode, 502);
    assert.ok(out.body.error.endsWith(`[${expected}]`));
    assertPrivate(out);
  }
  for (const phase of ['intake-read', 'intake-template', 'liability-template', 'prefill-create']) {
    const { out } = await invoke({ phase, mode: 'json' });
    assert.equal(out.statusCode, 502);
    assert.ok(out.body.error.endsWith(`[${phase === 'prefill-create' ? 'prefill-response' : phase}; HTTP 200]`));
    assertPrivate(out);
  }
}));

test('rate-limit response preserves status and Retry-After without revealing headers or body', async () => environment(async () => {
  const { out } = await invoke({ phase: 'prefill-create', providerStatus: 429 });
  assert.equal(out.statusCode, 429);
  assert.equal(out.headers['Retry-After'], '83');
  assert.ok(out.body.error.endsWith('[prefill-create; HTTP 429]'));
  assertPrivate(out);
}));

test('validation and missing/denied staff authorization retain existing status and ordering', async () => environment(async () => {
  for (const options of [{ auth: false }, { authorized: false }, { rejectSecondAuth: true }]) {
    const { out, calls } = await invoke(options);
    assert.equal(out.statusCode, options.auth === false ? 401 : 403);
    assert.equal(calls.includes('prefill-create'), false);
    if (options.auth === false) assert.equal(calls.length, 0);
    if (options.authorized === false) assert.deepEqual(calls, ['staff-auth']);
    assert.equal(out.body.error.includes('['), false);
    assertPrivate(out);
  }
  const { out, calls } = await invoke({ body: { stage: 'liability', waiverId: WAIVER, participantIndex: -1 } });
  assert.equal(out.statusCode, 400);
  assert.ok(out.body.error.endsWith('[prefill-build]'));
  assert.equal(calls.includes('prefill-create'), false);
  assertPrivate(out);
}));

test('both draft stages refresh destination metadata and reject publication changes before creating a reviewed prefill', async () => environment(async () => {
  const { normalizeIntake } = require('../lib/intake-normalize');
  const waiver = { waiverId: WAIVER, templateId: INTAKE, email: 'private@example.invalid', participants: [{
    firstName: 'Synthetic', lastName: 'Example', dob: '1990-01-01', isMinor: false,
    customParticipantFields: { w: { displayText: 'Weight (lbs)', value: '180' }, h: { displayText: 'Height (in)', value: '71' }, s: { displayText: 'Skier Type', value: 'II' } },
  }] };
  const person = normalizeIntake(waiver).participants[0];
  const technicianReview = { reviewed: true, waiverId: WAIVER, participantIndex: 0,
    participant: { first_name: person.first_name, last_name: person.last_name },
    source: { weight_lb: person.weight_lb, height_in: person.height_in, age: person.age, skier_type: person.skier_type },
    calculated: { skierCode: 'M', din: '7', bootSoleLengthMm: 315 },
  };
  for (const stage of ['synthetic-preview', 'liability']) {
    delete require.cache[require.resolve('../api/waiver-prefill')];
    const handler = require('../api/waiver-prefill');
    let publishedVersion = 1, metadataReads = 0, prefillPosts = 0, signedReads = 0, rejectMetadata = false;
    global.fetch = async (url, options = {}) => {
      if (url === AUTH) return success({ authorized: true });
      if (url.includes('/waivers/')) { signedReads += 1; return success({ waiver: structuredClone(waiver) }); }
      if (url.endsWith('/prefill')) {
        assert.equal(options.method, 'POST');
        prefillPosts += 1;
        return success({ prefill: { uuid: 'synthetic_link', url: 'https://waiver.smartwaiver.com/p/synthetic_link/' } });
      }
      if (url.includes(LIABILITY)) {
        metadataReads += 1;
        if (rejectMetadata) return failure(503);
        return success({ template: { templateId: LIABILITY, publishedVersion, customFields: [
          { guid: 'synthetic_code', label: 'Skier Code', fieldType: 'textbox', type: 'string' },
          { guid: 'synthetic_din', label: 'DIN', fieldType: 'optionlist', type: 'enum' },
          { guid: 'synthetic_bsl', label: 'Boot Sole Length (mm)', fieldType: 'numerictextbox', type: 'number' },
        ] } });
      }
      assert.ok(url.includes(INTAKE));
      return success({ template: { templateId: INTAKE, customParticipantFields: [] } });
    };
    const run = async body => { const out = response(); await handler(request(body), out); return out; };
    const body = stage === 'liability' ? { stage, waiverId: WAIVER, participantIndex: 0, technicianReview } : { stage };
    let out = await run({ stage: 'template-check' });
    assert.equal(out.statusCode, 200);
    assert.equal(metadataReads, 1);
    out = await run(body);
    assert.equal(out.statusCode, 200, out.body.error);
    assert.equal(metadataReads, 2, 'A draft must not use metadata warmed by template-check');
    assert.equal(prefillPosts, 1);
    publishedVersion = 2;
    out = await run({ stage: 'template-check' });
    assert.equal(out.body.templates[1].publishedVersion, 1, 'Read-only template-check may retain its cache');
    assert.equal(metadataReads, 2);
    out = await run(body);
    assert.equal(out.statusCode, 400);
    assert.match(out.body.error, /dropdown choices are not verified for this template version/);
    assert.ok(out.body.error.endsWith('[prefill-build]'));
    assert.equal(metadataReads, 3);
    assert.equal(prefillPosts, 1, 'Changed publication must fail before any new prefill POST');
    assertPrivate(out);
    rejectMetadata = true;
    out = await run(body);
    assert.equal(out.statusCode, 502);
    assert.ok(out.body.error.endsWith('[liability-template; HTTP 503]'));
    assert.equal(metadataReads, 4);
    assert.equal(prefillPosts, 1, 'Fresh-fetch failure must never fall back to cached metadata');
    assertPrivate(out);
    if (stage === 'synthetic-preview') assert.equal(signedReads, 0);
  }
}));
