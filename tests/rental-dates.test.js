const test = require('node:test');
const assert = require('node:assert/strict');
const { rentalDates, TEMPLATE_ID, DATE_FIELDS } = require('../lib/rental-dates');
const { buildLiabilityPrefill } = require('../lib/waiver-prefill');
const { normalizeIntake } = require('../lib/intake-normalize');
const { dropdowns, finals, dates } = require('./fixtures/rental-technical-fields');
const dateDefs = () => structuredClone(dates);
const template = () => ({ templateId: TEMPLATE_ID, publishedVersion: 1616022, customFields: dateDefs(), customParticipantFields: [...dropdowns, ...finals] });
const fixture = () => ({ waiverId: 'synthetic_rental_dates', email: 'snowos-unsigned-test@example.invalid', participants: [{ firstName: 'SnowOS', lastName: 'Unsigned Test', dob: '1990-01-01', isMinor: false, customParticipantFields: { w: { displayText: 'Weight (lbs)', value: '180' }, h: { displayText: 'Height (in)', value: '71' }, s: { displayText: 'Skier Type', value: 'II' } } }] });
const at = timestamp => ({ now: new Date(timestamp) });

test('Date Out follows Pacific midnight, year boundaries and DST; return date stays fixed', () => {
  const boundaries = [
    ['2026-10-14T06:59:59.999Z', '2026-10-13'], ['2026-10-14T07:00:00.000Z', '2026-10-14'],
    ['2027-01-01T07:59:59.999Z', '2026-12-31'], ['2027-01-01T08:00:00.000Z', '2027-01-01'],
    ['2027-03-14T07:59:59.999Z', '2027-03-13'], ['2027-03-14T08:00:00.000Z', '2027-03-14'],
    ['2027-03-14T09:59:59.999Z', '2027-03-14'], ['2027-03-14T10:00:00.000Z', '2027-03-14'],
    ['2026-11-01T08:59:59.999Z', '2026-11-01'], ['2026-11-01T09:00:00.000Z', '2026-11-01'],
  ];
  for (const [timestamp, dateOut] of boundaries) assert.deepEqual(rentalDates(new Date(timestamp)), { dateOut, dateReturning: '2027-05-16' }, timestamp);
});

test('final waiver replaces stale intake dates without changing signed data or DIN/manual workflow', () => {
  const w = fixture(), t = template();
  w.customWaiverFields = Object.fromEntries(dateDefs().map(f => [f.guid, { value: '2020-01-01', displayText: f.label }]));
  const p = normalizeIntake(w).participants[0];
  const review = { reviewed: true, waiverId: w.waiverId, participantIndex: 0, participant: { first_name: p.first_name, last_name: p.last_name }, source: { weight_lb: p.weight_lb, height_in: p.height_in, age: p.age, skier_type: p.skier_type }, calculated: { skierCode: 'M', din: '7', bootSoleLengthMm: 315 }, finalSettings: { leftToe: '6.25', leftHeel: '6.50', rightToe: '5.75', rightHeel: '6.00' } };
  const before = JSON.stringify({ w, t, review });
  const result = buildLiabilityPrefill(w, t, t, 0, review, at('2026-10-14T06:59:59Z'));
  assert.deepEqual(result.payload.customWaiverFields, { [DATE_FIELDS[0].guid]: '2026-10-13', [DATE_FIELDS[1].guid]: '2027-05-16' });
  assert.deepEqual(finals.map(f => result.payload.participants[0].customFields[f.guid]), ['6.25', '6.50', '5.75', '6.00']);
  for (const f of dropdowns) assert.equal(Object.hasOwn(result.payload.participants[0].customFields, f.guid), false);
  assert.deepEqual(result.manualFields.map(f => f.value), ['M', '7', '315']);
  assert.equal(JSON.stringify({ w, t, review }), before);
  assert.equal(buildLiabilityPrefill(w, t, t, 0, undefined, at('2026-10-14T07:00:00Z')).payload.customWaiverFields[DATE_FIELDS[0].guid], '2026-10-14', 'reopening creates a fresh Pacific date');
});

test('rental dates apply once per family at waiver scope', () => {
  const w = fixture();
  w.guardian = { ...w.participants[0] };
  w.participants = [{ firstName: 'Fictional', lastName: 'Child', dob: '2020-01-01', isMinor: true }];
  const result = buildLiabilityPrefill(w, {}, template(), 0, undefined, at('2026-10-14T08:00:00Z'));
  assert.equal(Object.keys(result.payload.customWaiverFields).length, 2);
  assert.equal(result.payload.guardian.customFields, undefined);
  assert.equal(result.payload.participants[0].customFields, undefined);
});

test('missing, duplicate, moved or repurposed date fields stay unfilled and report manual dates', () => {
  for (const mutate of [
    t => { t.customFields = []; },
    t => { t.customFields.forEach(f => { f.guid = 'changed_' + f.guid; }); },
    t => { t.customFields.push(...dateDefs()); },
    t => { t.customParticipantFields.push(...dateDefs()); },
    t => { t.customFields.forEach(f => { f.type = 'string'; f.fieldType = 'textbox'; }); },
    t => { t.customFields.forEach(f => { f.label = 'Unrelated question'; }); },
  ]) {
    const t = template(); mutate(t);
    const result = buildLiabilityPrefill(fixture(), {}, t, 0, undefined, at('2026-10-14T08:00:00Z'));
    assert.equal(result.payload.customWaiverFields, undefined);
    assert.deepEqual(result.manualFields.map(f => f.value), ['2026-10-14', '2027-05-16']);
    assert.equal(result.skippedFields.filter(f => f.includes('rental date field could not be verified')).length, 2);
  }
});

test('date policy does not affect another template', () => {
  const t = template(); t.templateId = 'unrelated_template';
  const result = buildLiabilityPrefill(fixture(), {}, t);
  assert.equal(result.payload.customWaiverFields, undefined);
  assert.deepEqual(result.manualFields, []);
});
