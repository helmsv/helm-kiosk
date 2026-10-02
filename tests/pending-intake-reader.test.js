const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPendingIntakeReader } = require('../lib/pending-intake-reader');
const { buildIntakePrefill, buildLiabilityPrefill, safePrefillUrl } = require('../lib/waiver-prefill');
const { pendingRows } = require('../rental-data');
const fixture = require('./fixtures/intake.json');
const start = Date.parse('2026-10-02T12:00:00Z');
const input = { templateId: fixture.templateId, fromDts: '2026-10-02T00:00:00Z', toDts: '2026-10-03T00:00:00Z' };
function waiver(id = fixture.waiverId, changes = {}) { return { ...structuredClone(fixture), waiverId: id, createdOn: '2026-10-02 10:15:00', autoTag: 'ls_synthetic_123', ...changes }; }
function summary(value) { return { waiverId: value.waiverId, templateId: value.templateId, createdOn: value.createdOn, autoTag: value.autoTag, firstName: 'Not a participant' }; }
function setup(waivers, options = {}) {
  let time = start;
  const calls = [];
  const request = async route => {
    calls.push(route);
    const url = new URL(route, 'https://api.smartwaiver.com/v4');
    if (url.pathname === '/waivers') {
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      return { waivers: waivers.slice(offset * limit, (offset + 1) * limit).map(summary) };
    }
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (options.detail) return options.detail(id, calls);
    return { waiver: waivers.find(person => person.waiverId === id) };
  };
  return { reader: createPendingIntakeReader({ request, now: () => time, policy: options.policy }), calls, advance(ms) { time += ms; } };
}

test('legacy and UUID Lightspeed tags survive intake prefill, signed rows and final participant linkage', async () => {
  const ids = ['legacy_123', '00000000-0000-4000-8000-000000000000', '00000000000040008000000000000000'];
  const tags = new Set();
  for (const id of ids) {
    const draft = buildIntakePrefill({ email:'fictional@example.invalid', dob:'1990-01-01', minors:false, lightspeed_id:id, mobile:'+1 (202) 555-0134' });
    const url = new URL(safePrefillUrl('https://waiver.smartwaiver.com/p/synthetic-test/', draft.tag, 'synthetic-test'));
    const tag = url.searchParams.get('auto_tag');
    assert.equal(tag, `ls_${id}`);
    tags.add(tag);
    assert.equal(draft.payload.externalId, id.includes('-') ? undefined : `ls_${id}`);
    const signed = waiver(undefined, { autoTag:tag });
    const rows = (await setup([signed]).reader.read(input)).rows;
    assert.ok(rows.every(row => row.lightspeed_id === id));
    const finalDraft = buildLiabilityPrefill(signed, {}, {}, 1);
    const remaining = pendingRows(rows, [{ autoTag:finalDraft.tag, createdOn:'2026-10-02T11:00:00Z' }]);
    assert.deepEqual(remaining.map(row => row.participant_index), [0]);
  }
  assert.equal(tags.size, ids.length, 'UUID punctuation is never stripped or encoded into a colliding tag');
});

test('reader requires an explicit server client and does not issue implicit fetches', () => {
  assert.throws(() => createPendingIntakeReader(), /Inject/);
  const source = fs.readFileSync(path.join(__dirname, '../lib/pending-intake-reader.js'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /require\(['"].*smartwaiver/);
});

test('all signed participants populate distinct rows with strict privacy allowlist', async () => {
  const value = waiver(undefined, { address: 'PRIVATE_ADDRESS', signatures: 'PRIVATE_SIGNATURE' });
  const { reader, calls } = setup([value]);
  const result = await reader.read(input);
  assert.equal(result.partial, false);
  assert.equal(result.count, 2); assert.equal(result.loaded_waivers, 1);
  const [adult, child] = result.rows;
  assert.equal(adult.email, fixture.email);
  assert.equal(adult.age, 40); assert.equal(adult.height_in, 71); assert.equal(adult.weight_lb, 180); assert.equal(adult.skier_type, 'III');
  assert.equal(adult.signed_on, '2026-10-02T10:15:00.000Z');
  assert.equal(adult.lightspeed_id, 'synthetic_123'); assert.equal(adult.intake_pdf_url, '');
  assert.equal(adult.participant_index, 0); assert.equal(child.participant_index, 1);
  assert.equal(child.first_name, 'Child'); assert.equal(child.age, 9);
  assert.equal(child.height_in, 130 / 2.54); assert.equal(child.weight_lb, 30 * 2.2046226218); assert.equal(child.skier_type, 'I');
  assert.deepEqual(Object.keys(adult).sort(), ['waiver_id','participant_index','signed_on','intake_pdf_url','lightspeed_id','email','first_name','last_name','age','height_in','weight_lb','skier_type'].sort());
  assert.doesNotMatch(JSON.stringify(result), /date_of_birth|1985-10-03|2017-10-02|PRIVATE_|guardian|customParticipantFields|signature/);
  assert.equal(calls[1], `/waivers/${fixture.waiverId}?pdf=false`);
  assert.ok(calls.every(route => route.startsWith('/waivers')));
  result.rows[0].weight_lb = 999;
  assert.equal((await reader.read(input)).rows[0].weight_lb, 180, 'response mutation must not poison cache');
  assert.equal(calls.length, 2, 'hot polls use normalized cache');
});

test('guardian and sibling measurements are not copied into missing participant values', async () => {
  const value = waiver();
  value.participants[1].customParticipantFields = {};
  value.guardian = { dob: '1960-01-01', customParticipantFields: { x: { displayText: 'Weight', value: '250' } } };
  const result = await setup([value]).reader.read(input);
  assert.equal(result.rows[1].age, 9);
  assert.equal(result.rows[1].height_in, null); assert.equal(result.rows[1].weight_lb, null); assert.equal(result.rows[1].skier_type, '');
});

test('wrong signed ID, wrong signed template and invalid participants fail closed without leaking upstream detail', async () => {
  for (const changes of [{ waiverId: 'different_customer' }, { templateId: 'liability_template' }, { participants: [] }, { participants: [null] }, { participants: [[{ firstName: 'Nested' }]] }]) {
    const value = waiver();
    const { reader } = setup([value], { detail: async () => ({ waiver: { ...value, ...changes, email: 'SENSITIVE_WRONG_RECORD' } }) });
    const result = await reader.read(input);
    assert.deepEqual(result.rows, []); assert.equal(result.failed_waivers, 1); assert.equal(result.partial, true);
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|different_customer|liability_template/);
  }
});

test('summary IDs/templates are validated and duplicates never duplicate participant rows', async () => {
  const value = waiver(); const calls = [];
  const reader = createPendingIntakeReader({ now: () => start, request: async route => {
    calls.push(route);
    if (route.startsWith('/waivers?')) return { waivers: [summary(value), summary(value), { ...summary(value), waiverId: '../escape' }, { ...summary(value), waiverId: 'other', templateId: 'wrong' }, { ...summary(value), waiverId: 'missing', templateId: undefined }] };
    return { waiver: value };
  } });
  const result = await reader.read(input);
  assert.equal(result.count, 2); assert.equal(result.waiver_count, 1); assert.equal(result.rejected_waivers, 3);
  assert.equal(result.partial, true); assert.equal(calls.length, 2);
});

test('bounded progressive hydration reports pending counts until all participants load', async () => {
  const { reader, calls } = setup(Array.from({ length: 5 }, (_, n) => waiver(`waiver_${n}`)), { policy: { detailsPerRead: 2 } });
  const first = await reader.read(input);
  assert.equal(first.loaded_waivers, 2); assert.equal(first.pending_waivers, 3); assert.equal(first.count, 4); assert.equal(first.partial, true);
  assert.equal(calls.length, 3);
  const second = await reader.read(input);
  assert.equal(second.loaded_waivers, 4); assert.equal(second.pending_waivers, 1); assert.equal(calls.length, 5);
  const third = await reader.read(input);
  assert.equal(third.loaded_waivers, 5); assert.equal(third.count, 10); assert.equal(third.partial, false); assert.equal(calls.length, 6);
});

test('rolling request budget includes summary GETs and pauses subsequent polls', async () => {
  const { reader, calls, advance } = setup(Array.from({ length: 4 }, (_, n) => waiver(`waiver_${n}`)), { policy: { requestsPerMinute: 3 } });
  const first = await reader.read(input);
  assert.equal(calls.length, 3); assert.equal(first.loaded_waivers, 2); assert.equal(first.pending_waivers, 2); assert.equal(first.retry_after_seconds, 60);
  assert.equal((await reader.read(input)).pending_waivers, 2); assert.equal(calls.length, 3);
  advance(60001);
  const next = await reader.read(input);
  assert.equal(calls.length, 6); assert.equal(next.loaded_waivers, 4); assert.equal(next.partial, false);
});

test('upstream 429 halts the batch, obeys Retry-After and resumes without exposing raw errors', async () => {
  let reject = true;
  const values = [waiver('first'), waiver('second')];
  const { reader, calls, advance } = setup(values, { detail: async id => {
    if (reject) { reject = false; throw Object.assign(new Error('SENSITIVE_UPSTREAM API_SECRET'), { status: 429, retryAfterSeconds: 120 }); }
    return { waiver: values.find(value => value.waiverId === id) };
  } });
  const first = await reader.read(input);
  assert.equal(calls.length, 2); assert.equal(first.failed_waivers, 1); assert.equal(first.pending_waivers, 1); assert.equal(first.retry_after_seconds, 120);
  assert.doesNotMatch(JSON.stringify(first), /SENSITIVE|API_SECRET/);
  advance(5000); await reader.read(input); assert.equal(calls.length, 2);
  advance(120000); const recovered = await reader.read(input);
  assert.equal(recovered.failed_waivers, 0); assert.equal(recovered.pending_waivers, 0); assert.equal(recovered.count, 4);
});

test('invalid/malformed list responses and upstream failures are sanitized', async () => {
  for (const request of [async () => ({ waivers: {} }), async () => { throw new Error('SENSITIVE_UPSTREAM'); }, async () => { throw Object.assign(new Error('API_SECRET'), { status: 429 }); }]) {
    const reader = createPendingIntakeReader({ request, now: () => start });
    await assert.rejects(reader.read(input), cause => !/SENSITIVE|API_SECRET/.test(cause.message) && [429, 502].includes(cause.status));
  }
});

test('pagination uses page offsets and explicitly signals possible extra pages', async () => {
  const values = Array.from({ length: 3 }, (_, n) => waiver(`page_${n}`));
  const { reader, calls } = setup(values, { policy: { pageSize: 2 } });
  const first = await reader.read(input);
  assert.deepEqual(first.pagination, { page: 0, page_size: 2, has_more: true, next_page: 1 }); assert.equal(first.partial, true);
  const second = await reader.read({ ...input, page: 1 });
  assert.equal(second.count, 2); assert.equal(second.rows[0].waiver_id, 'page_2'); assert.equal(second.partial, false);
  assert.deepEqual(second.pagination, { page: 1, page_size: 2, has_more: false, next_page: null });
  assert.ok(calls.some(route => route.includes('offset=1')));
});

test('summary cache refreshes while detail cache avoids repeated participant fanout', async () => {
  const { reader, calls, advance } = setup([waiver()]);
  await reader.read(input); advance(11000); await reader.read(input);
  assert.equal(calls.length, 3); assert.equal(calls.filter(route => !route.includes('?templateId=')).length, 1);
});

test('cache expiry recomputes birthday age at UTC midnight without retaining raw DOB', async () => {
  const { reader, calls, advance } = setup([waiver()], { policy: { detailTtlMs: 2 * 86400000 } });
  assert.equal((await reader.read(input)).rows[0].age, 40);
  advance(12 * 3600000 + 1);
  assert.equal((await reader.read(input)).rows[0].age, 41); assert.equal(calls.length, 4);
});

test('negative cache backs off malformed detail and retries after expiry', async () => {
  let broken = true; const value = waiver();
  const { reader, calls, advance } = setup([value], { detail: async () => ({ waiver: broken ? {} : value }) });
  assert.equal((await reader.read(input)).failed_waivers, 1);
  broken = false;
  await reader.read(input); assert.equal(calls.length, 2);
  advance(30001);
  assert.equal((await reader.read(input)).count, 2); assert.equal(calls.length, 4);
});

test('concurrent identical reads coalesce list and signed detail GETs', async () => {
  const value = waiver(), calls = [];
  const reader = createPendingIntakeReader({ now: () => start, request: async route => {
    calls.push(route);
    await new Promise(resolve => setImmediate(resolve));
    return route.startsWith('/waivers?') ? { waivers: [summary(value)] } : { waiver: value };
  } });
  const results = await Promise.all([reader.read(input), reader.read(input), reader.read(input)]);
  assert.equal(calls.length, 2); assert.ok(results.every(result => result.count === 2));
});

test('bounded LRU evicts old pages/details rather than retaining unbounded user records', async () => {
  const values = Array.from({ length: 4 }, (_, n) => waiver(`entry_${n}`));
  const { reader, calls } = setup(values, { policy: { pageSize: 2, maxDetailEntries: 2, maxSummaryEntries: 1 } });
  await reader.read(input); await reader.read({ ...input, page: 1 }); await reader.read(input);
  assert.equal(calls.length, 9, 'first page must be fetched again after the bounded cache evicts it');
});

test('invalid input rejects before any upstream read', async () => {
  const reader = createPendingIntakeReader({ request: async () => assert.fail('must not fetch') });
  for (const bad of [{ templateId: '../bad' }, { page: -1 }, { page: '1' }, { fromDts: 'garbage' }, { toDts: input.fromDts }, { fromDts: ['2026-10-02'] }]) {
    await assert.rejects(reader.read({ ...input, ...bad }), cause => cause.status === 400);
  }
  assert.throws(() => createPendingIntakeReader({ request: async () => {}, policy: { pageSize: 301 } }));
  assert.throws(() => createPendingIntakeReader({ request: async () => {}, policy: { maxDetailEntries: 1 } }));
});
