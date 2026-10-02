const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIntakePrefill, buildLiabilityPrefill, safePrefillUrl, validDob, fieldList, normalizePhone } = require('../lib/waiver-prefill');
const def = (guid, label, fieldType = 'textbox', type = 'string') => ({ guid, label, fieldType, type });
const adult = (extra = {}) => ({ firstName: 'Adult', lastName: 'Example', dob: '1990-04-17', isMinor: false, ...extra });
const child = (extra = {}) => ({ firstName: 'Child', lastName: 'Example', dob: '2015-07-02', isMinor: true, ...extra });
const waiver = participants => ({ waiverId: 'test_waiver', email: 'test@example.com', autoTag: 'ls_123', participants });
const source = { customParticipantFields: [def('sourceweight13', 'Weight'), def('sourceskier013', 'Skier Type', 'radiobuttons', 'enum')], customFields: [def('sourceaddress', 'Street address')] };
const target = { customParticipantFields: [def('targetweight13', 'Weight'), def('targetskier013', 'Skier Type', 'radiobuttons', 'enum')], customFields: [def('targetaddress', 'Street address')] };

test('welcome email and DOB prefill even when no name or customer record exists', () => {
  const draft = buildIntakePrefill({ email: ' newcomer@example.com ', dob: '19900417', minors: false });
  assert.equal(draft.payload.email, 'newcomer@example.com');
  assert.deepEqual(draft.payload.participants, [{ dob: '1990-04-17' }]);
  assert.equal(draft.payload.adult, true);
  assert.equal(draft.payload.lockdownPrefill, false);
  assert.equal(draft.payload.kiosk, true);
  assert.match(draft.tag, /^intake_[a-z0-9]+$/);
});
test('welcome family DOB belongs only to guardian, never a child', () => {
  const draft = buildIntakePrefill({ email: 'parent@example.com', dob: '1986-10-03', minors: true, first_name: 'Parent', last_name: 'Example', lightspeed_id: '123' });
  assert.equal(draft.payload.guardian.dob, '1986-10-03');
  assert.equal(draft.payload.guardian.firstName, 'Parent');
  assert.equal(draft.payload.guardian.participant, false);
  assert.equal(draft.payload.participants, undefined);
  assert.equal(draft.payload.adult, false);
  assert.equal(draft.tag, 'ls_123');
});
test('validates date, future dates, adult signer, email and explicit minors choice', () => {
  assert.equal(validDob('2024-02-30'), '');
  assert.equal(validDob('2024-02-29'), '2024-02-29');
  assert.equal(validDob('1800-01-01'), '');
  assert.equal(validDob('2999-01-01'), '');
  assert.throws(() => buildIntakePrefill({ email: 'bad', dob: '1990-01-01', minors: false }));
  assert.throws(() => buildIntakePrefill({ email: 'p@example.com', dob: '2020-01-01', minors: true }));
  assert.throws(() => buildIntakePrefill({ email: 'p@example.com', dob: '1990-01-01' }));
});
test('adult maps full name, DOB, phone, common custom answers, address and emergency contact', () => {
  const w = { ...waiver([adult({ phone: '555-0100', customParticipantFields: { sourceweight13: { value: '174', displayText: 'Weight' }, sourceskier013: { value: 'II', displayText: 'Skier Type' } } })]), addressLineOne: '123 Example St', addressCity: 'Example City', emergencyContactName: 'Contact Example', emergencyContactPhone: '555-0101', customWaiverFields: { sourceaddress: { value: '123 Example St', displayText: 'Street address' } } };
  const before = JSON.stringify(w);
  const { payload } = buildLiabilityPrefill(w, source, target);
  assert.equal(payload.participants[0].dob, '1990-04-17');
  assert.equal(payload.participants[0].phone, '5550100');
  assert.equal(payload.participants[0].customFields.targetweight13, '174');
  assert.equal(payload.participants[0].customFields.targetskier013, 'II');
  assert.equal(payload.customWaiverFields.targetaddress, '123 Example St');
  assert.equal(payload.addressLineOne, '123 Example St');
  assert.equal(payload.emergencyContactPhone, '5550101');
  assert.equal(payload.lockdownPrefill, false);
  assert.equal(JSON.stringify(w), before, 'signed data is never mutated');
});
test('suffix-13 signed field IDs resolve uniquely to the full source GUID', () => {
  const suffix = 'bk3xydss4e9dy';
  const long = `LONG_PREFIX_${suffix}`;
  const s = { customParticipantFields: [def(long, 'Weight')] };
  const w = waiver([adult({ customParticipantFields: { [suffix]: { value: '168', displayText: 'Weight' } } })]);
  assert.equal(buildLiabilityPrefill(w, s, target).payload.participants[0].customFields.targetweight13, '168');
  s.customParticipantFields.push(def(`OTHER_${suffix}`, 'Weight'));
  assert.equal(buildLiabilityPrefill(w, s, target).payload.participants[0].customFields, undefined);
});
test('minor-only family retains all children separately and nonparticipating guardian', () => {
  const w = { ...waiver([
    child({ firstName: 'First', customParticipantFields: { sourceweight13: { value: '68', displayText: 'Weight' } } }),
    child({ firstName: 'Second', dob: '2018-01-05', customParticipantFields: { sourceweight13: { value: '47', displayText: 'Weight' } } }),
  ]), guardian: { firstName: 'Guardian', lastName: 'Example', dob: '1984-11-12', relationship: 'Mother' }, customWaiverFields: { sourceweight13: { value: '999', displayText: 'Weight' } } };
  const { payload } = buildLiabilityPrefill(w, source, target, 1);
  assert.equal(payload.adult, false);
  assert.equal(payload.guardian.participant, false);
  assert.equal(payload.guardian.relationship, 'Mother');
  assert.equal(payload.guardian.dob, '1984-11-12');
  assert.equal(payload.participants.length, 2);
  assert.equal(payload.participants[0].firstName, 'First');
  assert.equal(payload.participants[0].customFields.targetweight13, '68');
  assert.equal(payload.participants[1].customFields.targetweight13, '47');
  assert.equal(payload.participants[1].dob, '2018-01-05');
});
test('participating guardian is extracted from adult-plus-minors without duplicating identities', () => {
  const { payload } = buildLiabilityPrefill(waiver([adult({ relationship: 'Father' }), child()]), source, target, 1);
  assert.equal(payload.guardian.firstName, 'Adult');
  assert.equal(payload.guardian.participant, true);
  assert.equal(payload.guardian.relationship, 'Father');
  assert.equal(payload.participants.length, 1);
  assert.equal(payload.participants[0].firstName, 'Child');
});
test('never imports signatures, initials, consent, marketing opt-ins, files, or identifiers', () => {
  const labels = ['Signature', 'Initials', 'I agree', 'Consent', 'Release', 'I acknowledge the risks', 'I confirm', 'Newsletter opt-in', 'Drivers License Number'];
  const definitions = labels.map((l, i) => def(`f${i}`, l));
  const fields = Object.fromEntries(labels.map((l, i) => [`f${i}`, { value: 'yes', displayText: l }]));
  const w = { ...waiver([adult({ customParticipantFields: fields, signature: 'secret' })]), signatures: 'secret', typedSignatures: 'secret', driversLicenseNumber: 'secret', insurancePolicyNumber: 'secret' };
  const { payload } = buildLiabilityPrefill(w, { customParticipantFields: definitions }, { customParticipantFields: definitions });
  assert.equal(payload.participants[0].customFields, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /secret|agree|Newsletter/);
});
test('does not infer between differently named units, duplicate labels, or different field types', () => {
  const s = { customParticipantFields: [def('height', 'Height (in)'), def('weight1', 'Weight'), def('weight2', 'Weight'), def('skier', 'Skier Type', 'radiobuttons', 'enum')] };
  const t = { customParticipantFields: [def('height2', 'Height (cm)'), def('weight3', 'Weight'), def('skier2', 'Skier Type', 'numerictextbox', 'number')] };
  const w = waiver([adult({ customParticipantFields: { height: { value: '71', displayText: 'Height (in)' }, weight1: { value: '180', displayText: 'Weight' }, weight2: { value: '181', displayText: 'Weight' }, skier: { value: 'II', displayText: 'Skier Type' } } })]);
  assert.equal(buildLiabilityPrefill(w, s, t).payload.participants[0].customFields, undefined);
});
test('refuses invalid selected participant, missing guardian, ambiguous adults, unknown minor status', () => {
  assert.throws(() => buildLiabilityPrefill(waiver([adult()]), source, target, 2));
  assert.throws(() => buildLiabilityPrefill(waiver([child()]), source, target));
  assert.throws(() => buildLiabilityPrefill(waiver([adult(), adult(), child()]), source, target));
  assert.throws(() => buildLiabilityPrefill(waiver([{ firstName: 'Unknown' }]), source, target));
});
test('only one known adult may use waiver-level fields as participant fallback', () => {
  const w = { ...waiver([adult()]), customWaiverFields: { sweight: { value: '178', displayText: 'Weight' } } };
  const { payload } = buildLiabilityPrefill(w, { customFields: [def('sweight', 'Weight')] }, target);
  assert.equal(payload.participants[0].customFields.targetweight13, '178');
  const family = { ...w, participants: [adult(), child()] };
  assert.equal(buildLiabilityPrefill(family, { customFields: [def('sweight', 'Weight')] }, target).payload.participants[0].customFields, undefined);
});
test('validates generated URL and matching prefill ID; tag contains no DOB or email', () => {
  const url = new URL(safePrefillUrl('https://waiver.smartwaiver.com/p/abc123/', 'ls_123', 'abc123'));
  assert.equal(url.searchParams.get('auto_tag'), 'ls_123');
  for (const input of ['http://waiver.smartwaiver.com/p/a/', 'https://evil.example/p/a/', 'https://waiver.smartwaiver.com.evil.example/p/a/', 'https://waiver.smartwaiver.com/w/a/', 'https://waiver.smartwaiver.com/p/a/?email=secret']) assert.throws(() => safePrefillUrl(input, 'tag'));
  assert.throws(() => safePrefillUrl('https://waiver.smartwaiver.com/p/a/', 'tag', 'b'));
});
test('supports both documented template participant field spellings', () => {
  assert.equal(fieldList({ participantCustomFields: [def('id', 'Weight')] }, true)[0].guid, 'id');
});

test('array answers are explicitly reported for review rather than silently dropped or coerced', () => {
  const s = { customParticipantFields: [def('sourceActivities', 'Activities', 'optionlist', 'array')] };
  const t = { customParticipantFields: [def('targetActivities', 'Activities', 'optionlist', 'array')] };
  const w = waiver([adult({ customParticipantFields: { sourceActivities: { value: ['Ski', 'Snowboard'], displayText: 'Activities' } } })]);
  const result = buildLiabilityPrefill(w, s, t);
  assert.equal(result.payload.participants[0].customFields, undefined);
  assert.match(result.skippedFields[0], /Activities.*enter this answer/);
});


test('display-formatted phones preserve supplied country code and digits without invention', () => {
  for (const [input, expected] of [
    ['+1 (202) 555-0134', '+12025550134'],
    [' +44 20 7946 0018 ', '+442079460018'],
    ['202.555.0134', '2025550134'],
    ['(202) 555-0134', '2025550134'],
    ['+12025550134', '+12025550134'],
    ['020 7946 0018', '02079460018'],
  ]) assert.equal(normalizePhone(input), expected);
  for (const input of ['+1 202 555 0134 ext 99', '+1 202 555 0134 x99', '202/555/0134', '++12025550134', '+1+2025550134', 'call me', '+0123456789', '+1234567890123456', 12025550134]) assert.equal(normalizePhone(input), '');
});
test('welcome adult and guardian normalize formatted phone without blocking a draft', () => {
  for (const minors of [false, true]) {
    const draft = buildIntakePrefill({ email: 'test@example.com', dob: '1990-01-01', minors, mobile: '+1 (202) 555-0134' });
    const person = minors ? draft.payload.guardian : draft.payload.participants[0];
    assert.equal(person.phone, '+12025550134');
    assert.equal(draft.skippedFields.length, 0);
    const invalid = buildIntakePrefill({ email: 'test@example.com', dob: '1990-01-01', minors, mobile: '+1 (202) 555-0134 ext 9' });
    assert.equal((minors ? invalid.payload.guardian : invalid.payload.participants[0]).phone, undefined);
    assert.equal(invalid.payload.email, 'test@example.com');
    assert.match(invalid.skippedFields[0], /Phone.*enter this phone number/);
    assert.doesNotMatch(JSON.stringify(invalid.skippedFields), /202|0134|ext 9/);
  }
});
test('UUID Lightspeed IDs retain the original auto_tag without an invalid externalId', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  const draft = buildIntakePrefill({ email: 'test@example.com', dob: '1990-01-01', minors: false, lightspeed_id: id });
  assert.equal(draft.tag, `ls_${id}`);
  assert.equal(draft.payload.externalId, undefined);
  const url = new URL(safePrefillUrl('https://waiver.smartwaiver.com/p/abc123/', draft.tag, 'abc123'));
  assert.equal(url.searchParams.get('auto_tag'), `ls_${id}`);
  const compatible = buildIntakePrefill({ email: 'test@example.com', dob: '1990-01-01', minors: false, lightspeed_id: 'abc_123' });
  assert.equal(compatible.payload.externalId, 'ls_abc_123');
});
test('liability normalizes each family and emergency phone without mutating signed data', () => {
  const w = { ...waiver([child({ phone: '+1 (202) 555-0134' })]), guardian: { firstName: 'Guardian', lastName: 'Example', dob: '1980-01-01', phone: '+44 20 7946 0018' }, emergencyContactPhone: '(202) 555-0135' };
  const before = JSON.stringify(w);
  const result = buildLiabilityPrefill(w, source, target);
  assert.equal(result.payload.participants[0].phone, '+12025550134');
  assert.equal(result.payload.guardian.phone, '+442079460018');
  assert.equal(result.payload.emergencyContactPhone, '2025550135');
  assert.equal(JSON.stringify(w), before);
  w.guardian.phone = '+1 (202) 555-0134 ext 9';
  w.emergencyContactPhone = 'ask guardian';
  const invalid = buildLiabilityPrefill(w, source, target);
  assert.equal(invalid.payload.guardian.phone, undefined);
  assert.equal(invalid.payload.emergencyContactPhone, undefined);
  assert.equal(invalid.payload.participants[0].phone, '+12025550134');
  assert.ok(invalid.skippedFields.some(x => x.startsWith('Guardian: Phone')));
  assert.ok(invalid.skippedFields.some(x => x.startsWith('Waiver: Emergency contact phone')));
});

test('matched Lightspeed UUID and formatted mobile produce compatible prefill together', () => {
  const input = { email: 'snowos-unsigned-test@example.com', dob: '1990-01-01', minors: false, first_name: 'SnowOS', last_name: 'Unsigned Test', mobile: '+1 (202) 555-0134', lightspeed_id: '01234567-89ab-cdef-0123-456789abcdef' };
  const before = JSON.stringify(input);
  const draft = buildIntakePrefill(input);
  assert.equal(draft.payload.participants[0].phone, '+12025550134');
  assert.equal(draft.payload.participants[0].firstName, 'SnowOS');
  assert.equal(draft.payload.participants[0].dob, '1990-01-01');
  assert.equal(draft.payload.email, input.email);
  assert.equal(draft.payload.externalId, undefined);
  assert.equal(draft.tag, `ls_${input.lightspeed_id}`);
  assert.equal(new URL(safePrefillUrl('https://waiver.smartwaiver.com/p/abc123/', draft.tag, 'abc123')).searchParams.get('auto_tag'), `ls_${input.lightspeed_id}`);
  assert.equal(JSON.stringify(input), before);
});
test('customer tags are never truncated or sanitized into another customer identity', () => {
  const base = { email: 'test@example.com', dob: '1990-01-01', minors: false };
  const first = buildIntakePrefill({ ...base, lightspeed_id: 'customer-id' });
  const second = buildIntakePrefill({ ...base, lightspeed_id: 'customer_id' });
  assert.notEqual(first.tag, second.tag);
  assert.equal(first.tag, 'ls_customer-id');
  assert.equal(second.tag, 'ls_customer_id');
  assert.throws(() => buildIntakePrefill({ ...base, lightspeed_id: 'a'.repeat(62) }));
  assert.throws(() => buildIntakePrefill({ ...base, lightspeed_id: 'customer id' }));
});

test('malformed optional phones are omitted and audited without object coercion', () => {
  for (const mobile of [{ toString: null }, ['202', '555', '0134'], {}, true, 12025550134]) {
    const draft = buildIntakePrefill({ email: 'test@example.com', dob: '1990-01-01', minors: false, mobile });
    assert.equal(draft.payload.participants[0].phone, undefined);
    assert.match(draft.skippedFields[0], /Phone.*enter this phone number/);
  }
});
