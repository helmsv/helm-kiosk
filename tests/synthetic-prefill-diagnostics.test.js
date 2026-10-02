const test = require('node:test');
const assert = require('node:assert/strict');
const INTAKE = 'synthetic_intake_template', LIABILITY = 'synthetic_liability_template';
require('./fixtures/technician-enum-contract')([LIABILITY]);
const AUTH = 'https://helm-snowos.vercel.app/api/rentals/authorize';
const PRIVATE = 'REQUEST_CUSTOMER_VALUE_MUST_NOT_APPEAR';
const defs = [
  { label: 'Skier Code', guid: '5ktkNvPGcPnv4o2ea9jBuv' },
  { label: 'Initial Indicator Value', guid: 'k26zGhNRXqxW4AamXpHUEx' },
  { label: 'Boot Sole Length (mm)', guid: 'cVR22k9ALMuAs6EtVsau14' },
].map(field => ({ ...field, fieldType: 'optionlist', type: 'enum', extra: PRIVATE }));
const req = (body, authorization = 'Bearer synthetic.staff.session') => ({ method: 'POST', headers: { host: 'kiosk.example', origin: 'https://kiosk.example', 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body });
const res = () => ({ headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
const ok = body => ({ ok: true, status: 200, json: async () => body });

async function scenario(action, { scope = 'participant', rejected = false, providerFailure = false, metadata } = {}) {
  const oldFetch = global.fetch, oldEnv = { ...process.env };
  process.env.SW_API_KEY = 'synthetic_server_key';
  process.env.SW_BASE_URL = 'https://api.smartwaiver.com';
  process.env.INTAKE_WAIVER_ID = INTAKE;
  process.env.LIABILITY_WAIVER_ID = LIABILITY;
  delete require.cache[require.resolve('../api/waiver-prefill')];
  const handler = require('../api/waiver-prefill');
  const calls = [], payloads = [];
  const extra = [{ label: PRIVATE, guid: 'unrelated_private_field', fieldType: 'textbox', type: 'string' }, { label: 'Final Indicator Setting: Left Toe', guid: 'left_toe_not_requested', fieldType: 'textbox', type: 'string' }];
  const final = metadata || { templateId: LIABILITY, publishedVersion: 1, [scope === 'participant' ? 'customParticipantFields' : 'customFields']: [...defs, ...extra], unrelated: PRIVATE };
  global.fetch = async (url, options = {}) => {
    if (url === AUTH) { calls.push('authorize'); return rejected ? { ok: false, status: 403 } : ok({ authorized: true }); }
    assert.equal(calls[0], 'authorize', 'Protected preview must authorize before any provider request');
    if (url.endsWith('/prefill')) {
      calls.push('create');
      payloads.push(JSON.parse(options.body));
      if (providerFailure) return { ok: false, status: 402, json: async () => assert.fail('Do not consume provider error body'), text: async () => assert.fail('Do not consume provider error body') };
      return ok({ prefill: { uuid: 'synthetic_token', url: 'https://waiver.smartwaiver.com/p/synthetic_token/' } });
    }
    if (url.includes('/waivers/')) {
      calls.push('signed-read');
      return ok({ waiver: { waiverId: 'synthetic_source', templateId: INTAKE, participants: [{ firstName: 'Synthetic', lastName: 'Example', dob: '1990-01-01', isMinor: false }] } });
    }
    calls.push('template');
    return ok({ template: url.includes(LIABILITY) ? final : { templateId: INTAKE, customParticipantFields: [] } });
  };
  const run = async (body, authorization) => { const out = res(); await handler(req(body, authorization), out); return out; };
  try { await action({ run, calls, payloads }); }
  finally { global.fetch = oldFetch; process.env = oldEnv; }
}

test('synthetic diagnostics expose exactly the actual three outgoing defaults and exact metadata scope', async () => {
  for (const scope of ['participant', 'waiver']) await scenario(async ({ run, calls, payloads }) => {
    const out = await run({ stage: 'synthetic-preview', waiverId: PRIVATE, first_name: PRIVATE, email: PRIVATE, participants: [{ firstName: PRIVATE }], technicianReview: { calculated: { skierCode: PRIVATE } }, technicalFields: [{ label: PRIVATE, guid: PRIVATE, value: PRIVATE }], templateId: PRIVATE });
    assert.equal(out.statusCode, 200, out.body.error);
    assert.equal(out.headers['Cache-Control'], 'private, no-store');
    assert.equal(calls.includes('signed-read'), false);
    assert.equal(calls.filter(call => call === 'authorize').length, 2);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].participants[0].firstName, 'SnowOS');
    const values = scope === 'participant' ? payloads[0].participants[0].customFields : payloads[0].customWaiverFields;
    assert.deepEqual(out.body.technicalFields, defs.map(({ label, guid }) => ({ label, guid, scope, value: values[guid] })));
    assert.deepEqual(out.body.technicalFields.map(field => field.value), ['M', '7', '315']);
    assert.equal(JSON.stringify(out.body.technicalFields).includes(PRIVATE), false);
    assert.equal(JSON.stringify(payloads).includes(PRIVATE), false);
    for (const field of out.body.technicalFields) assert.deepEqual(Object.keys(field), ['label', 'guid', 'scope', 'value']);
    assert.equal(out.body.technicalFields.some(field => field.guid === 'left_toe_not_requested'), false);
  }, { scope });
});

test('the verified DIN alias is reported using its exact metadata label', async () => {
  const fields = defs.map(field => ({ ...field, label: field.label === 'Initial Indicator Value' ? 'DIN' : field.label }));
  await scenario(async ({ run }) => {
    const out = await run({ stage: 'synthetic-preview' });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.technicalFields[1].label, 'DIN');
  }, { metadata: { templateId: LIABILITY, publishedVersion: 1, customParticipantFields: fields } });
});

test('missing and denied staff sessions cannot retrieve synthetic diagnostics or call provider', async () => {
  await scenario(async ({ run, calls }) => {
    const out = await run({ stage: 'synthetic-preview' }, '');
    assert.equal(out.statusCode, 401);
    assert.equal(calls.length, 0);
    assert.equal(Object.hasOwn(out.body, 'technicalFields'), false);
  });
  await scenario(async ({ run, calls }) => {
    const out = await run({ stage: 'synthetic-preview' });
    assert.equal(out.statusCode, 403);
    assert.deepEqual(calls, ['authorize']);
    assert.equal(Object.hasOwn(out.body, 'technicalFields'), false);
  }, { rejected: true });
});

test('diagnostics are absent from liability, template-check, public intake and all error responses', async () => {
  await scenario(async ({ run }) => {
    for (const body of [{ stage: 'liability', waiverId: 'synthetic_source', technicalFields: [PRIVATE] }, { stage: 'template-check', technicalFields: [PRIVATE] }]) {
      const out = await run(body);
      assert.equal(out.statusCode, 200, out.body.error);
      assert.equal(Object.hasOwn(out.body, 'technicalFields'), false);
    }
  });
  // The public intake never uses staff auth or reads templates; mock only its POST.
  const oldFetch = global.fetch, oldEnv = { ...process.env };
  process.env.SW_API_KEY = 'synthetic_server_key'; process.env.INTAKE_WAIVER_ID = INTAKE;
  global.fetch = async () => ok({ prefill: { uuid: 'synthetic_token', url: 'https://waiver.smartwaiver.com/p/synthetic_token/' } });
  try {
    const out = res();
    await require('../api/waiver-prefill')(req({ stage: 'intake', email: 'test@example.invalid', dob: '1990-01-01', minors: false, technicalFields: [PRIVATE] }, ''), out);
    assert.equal(out.statusCode, 200);
    assert.equal(Object.hasOwn(out.body, 'technicalFields'), false);
  } finally { global.fetch = oldFetch; process.env = oldEnv; }
  await scenario(async ({ run }) => {
    const out = await run({ stage: 'synthetic-preview' });
    assert.equal(out.statusCode, 502);
    assert.deepEqual(Object.keys(out.body), ['error']);
    assert.equal(out.body.error.includes(PRIVATE), false);
  }, { providerFailure: true });
  await scenario(async ({ run, payloads }) => {
    const out = await run({ stage: 'synthetic-preview' });
    assert.equal(out.statusCode, 400);
    assert.deepEqual(Object.keys(out.body), ['error']);
    assert.equal(payloads.length, 0);
  }, { metadata: { templateId: LIABILITY, publishedVersion: 1, customParticipantFields: [...defs, { ...defs[0], guid: 'ambiguous_code' }] } });
});
