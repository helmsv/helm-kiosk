const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTechnicianPrefill, isTechnicianFieldLabel } = require('../lib/technician-prefill');
const { buildLiabilityPrefill } = require('../lib/waiver-prefill');
const { normalizeIntake } = require('../lib/intake-normalize');

// Deliberately synthetic identities, GUIDs and values. No customer/API access.
const labels = ['Skier Code', 'DIN', 'Boot Sole Length (mm)', 'Final Indicator Setting: Left Toe', 'Final Indicator Setting: Left Heel', 'Final Indicator Setting: Right Toe', 'Final Indicator Setting: Right Heel'];
const def = (guid, label, fieldType = 'textbox', type = 'string') => ({ guid, label, fieldType, type });
function template(scope = 'participant') {
  return { [scope === 'participant' ? 'customParticipantFields' : 'customFields']: labels.map((label, i) => def(`synthetic_final_${i}`, label, i === 1 ? 'optionlist' : i >= 2 ? 'numerictextbox' : 'textbox', i === 1 ? 'enum' : i >= 2 ? 'number' : 'string')) };
}
const sourceTemplate = { customParticipantFields: [def('source_weight', 'Weight'), def('source_height', 'Height (in)'), def('source_type', 'Skier Type', 'optionlist', 'enum')] };
function participant(firstName = 'Sample', dob = '1990-04-17', isMinor = false) {
  return { firstName, lastName: 'Synthetic', dob, isMinor, customParticipantFields: {
    source_weight: { displayText: 'Weight', value: '174' },
    source_height: { displayText: 'Height (in)', value: '71' },
    source_type: { displayText: 'Skier Type', value: 'II' },
  } };
}
function waiver(people = [participant()]) { return { waiverId: 'synthetic_intake_001', email: 'sample@example.com', participants: people }; }
function review(w, index = 0, finals = false) {
  const p = normalizeIntake(w).participants[index];
  const out = {
    reviewed: true, waiverId: w.waiverId, participantIndex: index,
    participant: { first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth },
    source: { weight_lb: p.weight_lb, height_in: p.height_in, age: p.age, skier_type: p.skier_type },
    calculated: { skierCode: 'L', din: '6.00', bootSoleLengthMm: 315 },
  };
  if (finals) out.finalSettings = { leftToe: '6.25', leftHeel: '6.5', rightToe: '5.75', rightHeel: '6.00' };
  return out;
}
const throwsCode = (fn, code) => assert.throws(fn, error => error.statusCode === 400 && error.code === code);

test('maps reviewed calculator values to exact dynamically discovered GUIDs without final-setting inference', () => {
  const w = waiver(), r = review(w), t = template();
  const before = JSON.stringify({ w, r, t });
  const result = buildTechnicianPrefill(w, t, 0, r);
  assert.deepEqual({ ...result.participantFields }, { synthetic_final_0: 'L', synthetic_final_1: '6.00', synthetic_final_2: '315' });
  assert.deepEqual({ ...result.waiverFields }, {});
  assert.equal(result.copiedFields.length, 3);
  assert.equal(JSON.stringify({ w, r, t }), before);
  assert.equal(Object.keys(result.participantFields).some(key => /_[3-6]$/.test(key)), false);
});

test('all four explicitly reviewed final settings remain independent of calculated DIN', () => {
  const w = waiver(), r = review(w, 0, true);
  const result = buildTechnicianPrefill(w, template(), 0, r);
  assert.equal(result.participantFields.synthetic_final_1, '6.00');
  assert.equal(result.participantFields.synthetic_final_3, '6.25');
  assert.equal(result.participantFields.synthetic_final_4, '6.5');
  assert.equal(result.participantFields.synthetic_final_5, '5.75');
  assert.equal(result.participantFields.synthetic_final_6, '6.00');
  for (const value of [null, {}, { leftToe: 6 }, { ...r.finalSettings, inferred: true }]) throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, finalSettings: value }), 'TECHNICIAN_FINAL_SETTINGS_INCOMPLETE');
});

test('only selected child receives participant-scoped values; siblings and guardian remain separate', () => {
  const w = { ...waiver([participant('First', '2014-03-01', true), participant('Second', '2017-08-20', true)]), guardian: { firstName: 'Guardian', lastName: 'Synthetic', dob: '1980-01-01' } };
  const payload = buildLiabilityPrefill(w, sourceTemplate, template(), 1, review(w, 1)).payload;
  assert.equal(payload.participants[0].customFields, undefined);
  assert.equal(payload.guardian.customFields, undefined);
  assert.equal(payload.participants[1].firstName, 'Second');
  assert.equal(payload.participants[1].customFields.synthetic_final_0, 'L');
  assert.equal(payload.participants[1].customFields.synthetic_final_1, '6.00');
  assert.equal(payload.lockdownPrefill, false);
});

test('participating guardian maps to guardian fields without borrowing from a child', () => {
  const w = waiver([participant(), participant('Child', '2014-03-01', true)]);
  const payload = buildLiabilityPrefill(w, sourceTemplate, template(), 0, review(w)).payload;
  assert.equal(payload.guardian.participant, true);
  assert.equal(payload.guardian.customFields.synthetic_final_1, '6.00');
  assert.equal(payload.participants[0].customFields, undefined);
  const childPayload = buildLiabilityPrefill(w, sourceTemplate, template(), 1, review(w, 1)).payload;
  assert.equal(childPayload.guardian.customFields, undefined);
  assert.equal(childPayload.participants[0].customFields.synthetic_final_1, '6.00');
});

test('waiver-scoped technician fields require exactly one participant, including guardian families', () => {
  const single = waiver(), t = template('waiver');
  const result = buildLiabilityPrefill(single, sourceTemplate, t, 0, review(single)).payload;
  assert.equal(result.customWaiverFields.synthetic_final_1, '6.00');
  assert.equal(result.participants[0].customFields, undefined);
  const oneChild = { ...waiver([participant('Child', '2014-03-01', true)]), guardian: { firstName: 'Guardian', lastName: 'Synthetic', dob: '1980-01-01' } };
  assert.equal(buildLiabilityPrefill(oneChild, sourceTemplate, t, 0, review(oneChild)).payload.customWaiverFields.synthetic_final_1, '6.00');
  for (const w of [waiver([participant(), participant('Child', '2014-03-01', true)]), { ...oneChild, participants: [participant('Child', '2014-03-01', true), participant('Other', '2017-08-20', true)] }]) {
    throwsCode(() => buildLiabilityPrefill(w, sourceTemplate, t, 1, review(w, 1)), 'TECHNICIAN_FAMILY_SCOPE_UNSUPPORTED');
  }
  const mixed = template();
  mixed.customFields = [mixed.customParticipantFields.pop()];
  const multi = waiver([participant(), participant('Child', '2014-03-01', true)]);
  assert.equal(buildTechnicianPrefill(multi, mixed, 1, review(multi, 1)).copiedFields.length, 3, 'unrequested final settings do not block a safe draft');
  throwsCode(() => buildTechnicianPrefill(multi, mixed, 1, review(multi, 1, true)), 'TECHNICIAN_FAMILY_SCOPE_UNSUPPORTED');
});

test('missing or false technician review cannot be treated as authorization', () => {
  const w = waiver();
  for (const r of [undefined, null, {}, { ...review(w), reviewed: false }, { ...review(w), reviewed: 'true' }, { authorized: true, staff: true }]) throwsCode(() => buildTechnicianPrefill(w, template(), 0, r), 'TECHNICIAN_REVIEW_REQUIRED');
});

test('stale, missing, reordered, or ambiguous participant identity fails closed', () => {
  const w = waiver(), r = review(w);
  for (const change of [{ waiverId: 'different_intake' }, { participantIndex: 1 }, { participantIndex: '0' }]) throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, ...change }), 'TECHNICIAN_SELECTION_STALE');
  throwsCode(() => buildTechnicianPrefill(w, template(), -1, { ...r, participantIndex: -1 }), 'TECHNICIAN_SELECTION_STALE');
  throwsCode(() => buildTechnicianPrefill(w, template(), 1, { ...r, participantIndex: 1 }), 'TECHNICIAN_SELECTION_STALE');
  for (const person of [undefined, {}, { ...r.participant, first_name: 'Other' }, { ...r.participant, date_of_birth: '1991-04-17' }]) throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, participant: person }), 'TECHNICIAN_IDENTITY_UNVERIFIED');
  const duplicate = waiver([participant(), participant()]);
  throwsCode(() => buildTechnicianPrefill(duplicate, template(), 0, review(duplicate)), 'TECHNICIAN_IDENTITY_AMBIGUOUS');
  const family = waiver([participant(), participant('Child', '2014-03-01', true)]), old = review(family, 1);
  family.participants.reverse();
  throwsCode(() => buildTechnicianPrefill(family, template(), 1, old), 'TECHNICIAN_IDENTITY_UNVERIFIED');
  const missingName = waiver([{ ...participant(), lastName: '' }]);
  throwsCode(() => buildTechnicianPrefill(missingName, template(), 0, review(missingName)), 'TECHNICIAN_IDENTITY_UNVERIFIED');
});

test('raw DOB is not needed in browser review; optional supplied DOB must match', () => {
  const w = waiver(), r = review(w);
  delete r.participant.date_of_birth;
  assert.equal(buildTechnicianPrefill(w, template(), 0, r).participantFields.synthetic_final_1, '6.00');
  throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, participant: { ...r.participant, date_of_birth: '1900-01-01' } }), 'TECHNICIAN_IDENTITY_UNVERIFIED');
});

test('all reviewed source measurements must still match the selected signed intake', () => {
  const w = waiver(), r = review(w);
  for (const key of ['weight_lb', 'height_in', 'age', 'skier_type']) {
    const changed = { ...r.source, [key]: key === 'skier_type' ? 'III' : 12345 };
    throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, source: changed }), 'TECHNICIAN_SOURCE_STALE');
    delete changed[key];
    throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, source: changed }), 'TECHNICIAN_SOURCE_STALE');
  }
  w.participants[0].customParticipantFields.source_weight.value = '175';
  throwsCode(() => buildTechnicianPrefill(w, template(), 0, r), 'TECHNICIAN_SOURCE_STALE');
});

test('missing and almost-matching labels are not guessed; each error identifies its missing destination', () => {
  const w = waiver();
  for (const index of [0, 1, 2]) {
    const t = template(); t.customParticipantFields.splice(index, 1);
    assert.throws(() => buildTechnicianPrefill(w, t, 0, review(w)), error => error.code === 'TECHNICIAN_FIELD_MISSING' && error.message.includes(labels[index]));
  }
  for (const label of ['Din', 'Calculated DIN', 'DIN ', '<b>DIN</b>']) {
    const t = template(); t.customParticipantFields[1].label = label;
    throwsCode(() => buildTechnicianPrefill(w, t, 0, review(w)), 'TECHNICIAN_FIELD_MISSING');
  }
  const t = template(); t.customParticipantFields.pop();
  assert.equal(buildTechnicianPrefill(w, t, 0, review(w)).copiedFields.length, 3);
  throwsCode(() => buildTechnicianPrefill(w, t, 0, review(w, 0, true)), 'TECHNICIAN_FIELD_MISSING');
});

test('duplicate labels or GUIDs, conflicting metadata aliases and dictionary IDs fail closed', () => {
  const w = waiver(), r = review(w);
  for (const configure of [
    t => t.customParticipantFields.push(def('other', 'DIN', 'optionlist', 'enum')),
    t => { t.customFields = [def('other', 'DIN', 'optionlist', 'enum')]; },
    t => { t.participantCustomFields = [...t.customParticipantFields]; },
  ]) { const t = template(); configure(t); throwsCode(() => buildTechnicianPrefill(w, t, 0, r), 'TECHNICIAN_FIELD_AMBIGUOUS'); }
  const duplicateGuid = template(); duplicateGuid.customParticipantFields.push(def('synthetic_final_1', 'Unrelated'));
  throwsCode(() => buildTechnicianPrefill(w, duplicateGuid, 0, r), 'TECHNICIAN_GUID_INVALID');
  for (const guid of ['', ' bad ', '__proto__', 'constructor', 'prototype', undefined, 123]) {
    const t = template(); t.customParticipantFields[0].guid = guid;
    throwsCode(() => buildTechnicianPrefill(w, t, 0, r), 'TECHNICIAN_GUID_INVALID');
  }
  const malformed = { customParticipantFields: { different: def('conflicting', 'Skier Code') } };
  throwsCode(() => buildTechnicianPrefill(w, malformed, 0, r), 'TECHNICIAN_METADATA_INVALID');
});

test('only explicit supported field/data type pairs are accepted, including DIN dropdown enum', () => {
  const w = waiver(), r = review(w);
  for (const [fieldType, type] of [['textbox', 'string'], ['optionlist', 'array'], ['checkboxes', 'enum'], ['radiobuttons', 'enum'], ['optionlist', ''], ['optionlist', undefined], ['OPTIONLIST', 'enum']]) {
    const t = template(); t.customParticipantFields[1].fieldType = fieldType; t.customParticipantFields[1].type = type;
    throwsCode(() => buildTechnicianPrefill(w, t, 0, r), 'TECHNICIAN_FIELD_TYPE_UNSUPPORTED');
  }
  const textBsl = template(); textBsl.customParticipantFields[2] = def('bsl_text', labels[2]);
  assert.equal(buildTechnicianPrefill(w, textBsl, 0, r).participantFields.bsl_text, '315');
});

test('invalid value shapes, blank fields, booleans and nonfinite values are never coerced into settings', () => {
  const w = waiver(), r = review(w);
  for (const key of ['din', 'bootSoleLengthMm']) for (const value of [null, undefined, '', ' ', true, false, [], {}, '6abc', '6,5', '1e3', NaN, Infinity]) {
    throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, calculated: { ...r.calculated, [key]: value } }), 'TECHNICIAN_VALUE_INVALID');
  }
  for (const value of ['', 'l', 'Q', null, true, ['L']]) throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, calculated: { ...r.calculated, skierCode: value } }), 'TECHNICIAN_VALUE_INVALID');
  throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...r, calculated: { ...r.calculated, bootSoleLengthMm: 315.5 } }), 'TECHNICIAN_VALUE_INVALID');
  const full = review(w, 0, true);
  throwsCode(() => buildTechnicianPrefill(w, template(), 0, { ...full, finalSettings: { ...full.finalSettings, rightHeel: '' } }), 'TECHNICIAN_VALUE_INVALID');
});

test('generic intake mapping never copies old technician values, signatures, or consent', () => {
  const t = template(), w = waiver();
  t.customParticipantFields.push(def('signature', 'Signature'), def('consent', 'I agree'));
  const s = { customParticipantFields: t.customParticipantFields };
  for (const f of t.customParticipantFields) w.participants[0].customParticipantFields[f.guid] = { displayText: f.label, value: 'OLD_UNREVIEWED' };
  w.signatures = 'SIGNATURE_SECRET';
  const without = buildLiabilityPrefill(w, s, t);
  assert.equal(without.payload.participants[0].customFields, undefined);
  const r = review(w); r.signature = 'SIGNATURE_SECRET'; r.consent = true;
  const withReview = buildLiabilityPrefill(w, s, t, 0, r);
  assert.equal(withReview.payload.participants[0].customFields.synthetic_final_1, '6.00');
  assert.equal(withReview.payload.participants[0].customFields.synthetic_final_3, undefined);
  assert.doesNotMatch(JSON.stringify(withReview.payload), /OLD_UNREVIEWED|SIGNATURE_SECRET|consent/);
  assert.equal(withReview.payload.lockdownPrefill, false);
  for (const label of labels) assert.equal(isTechnicianFieldLabel(label.toLowerCase()), true);
});

test('source records stay unchanged; final name, email and reviewed values are editable defaults', () => {
  const w = waiver(), r = review(w), before = JSON.stringify(w);
  const payload = buildLiabilityPrefill(w, sourceTemplate, template(), 0, r).payload;
  assert.equal(payload.participants[0].firstName, 'Sample');
  assert.equal(payload.participants[0].lastName, 'Synthetic');
  assert.equal(payload.email, 'sample@example.com');
  assert.equal(payload.lockdownPrefill, false);
  payload.participants[0].firstName = 'Edited'; payload.email = 'edited@example.com';
  assert.equal(JSON.stringify(w), before);
});

test('both documented participant metadata spellings and GUID-keyed dictionaries resolve without hardcoded IDs', () => {
  const w = waiver(), r = review(w), fields = template().customParticipantFields;
  const alternate = { participantCustomFields: fields };
  assert.equal(buildTechnicianPrefill(w, alternate, 0, r).participantFields.synthetic_final_1, '6.00');
  const dictionary = { participantCustomFields: Object.fromEntries(fields.map(({ guid, ...rest }) => [guid, rest])) };
  assert.equal(buildTechnicianPrefill(w, dictionary, 0, r).participantFields.synthetic_final_1, '6.00');
});
