const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../lib/technician-enum-contracts.json');
const { buildTechnicianPrefill, isTechnicianFieldLabel } = require('../lib/technician-prefill');
const { buildLiabilityPrefill } = require('../lib/waiver-prefill');
const { normalizeIntake } = require('../lib/intake-normalize');

// Actual unsigned-template option contract, synthetic GUIDs and participant.
// No network calls, signed customer data, signature or consent submission.
const templateId = 'a2njtmnzxs7icea9mdxff6', publishedVersion = 1616022;
const definition = (guid, label) => ({ guid, label, fieldType: 'optionlist', type: 'enum' });
function template() {
  return { templateId, publishedVersion, customFields: [
    definition('synthetic_dynamic_code', 'Skier Code'),
    definition('synthetic_dynamic_din', 'Initial Indicator Value'),
    definition('synthetic_dynamic_bsl', 'Boot Sole Length (mm)'),
  ] };
}
function waiver() {
  return { waiverId: 'synthetic_enum_check', participants: [{ firstName: 'Synthetic', lastName: 'Options', dob: '1990-01-01', isMinor: false, customParticipantFields: {
    weight: { displayText: 'Weight', value: '174' }, height: { displayText: 'Height (in)', value: '71' }, type: { displayText: 'Skier Type', value: 'II' },
  } }] };
}
function review(w, values = {}) {
  const p = normalizeIntake(w).participants[0];
  return { reviewed: true, waiverId: w.waiverId, participantIndex: 0,
    participant: { first_name: p.first_name, last_name: p.last_name },
    source: { weight_lb: p.weight_lb, height_in: p.height_in, age: p.age, skier_type: p.skier_type },
    calculated: { skierCode: 'L', skierType: 'II', din: 7, bootSoleLengthMm: 315, ...values },
  };
}
function build(values = {}, target = template()) { const w = waiver(); return buildTechnicianPrefill(w, target, 0, review(w, values)); }
function rejects(fn, code) { assert.throws(fn, error => error.statusCode === 400 && error.code === code); }
function mutateContract(fn, run) {
  const before = structuredClone(contracts);
  try { fn(contracts); run(); }
  finally { contracts.splice(0, contracts.length, ...before); }
}

test('captured three-dropdown contract serializes exact options and leaves raw review values unchanged', () => {
  const w = waiver(), r = review(w), before = JSON.stringify({ w, r });
  const result = buildTechnicianPrefill(w, template(), 0, r);
  assert.deepEqual({ ...result.waiverFields }, { synthetic_dynamic_code: 'L', synthetic_dynamic_din: '7,00', synthetic_dynamic_bsl: '311–330' });
  assert.equal(JSON.stringify({ w, r }), before);
  assert.equal(Object.keys(result.participantFields).length, 0);
  assert.match(result.copiedFields[1], /Initial Indicator Value/);
  const payload = buildLiabilityPrefill(w, {}, template(), 0, r).payload;
  assert.equal(payload.lockdownPrefill, false);
  assert.equal(payload.customWaiverFields.synthetic_dynamic_din, '7,00');
  assert.equal(payload.customWaiverFields.synthetic_dynamic_bsl, '311–330');
});

test('original participant GUIDs receive all seven explicit values independently, with final settings absent unless supplied', () => {
  const { dropdowns, finals } = require('./fixtures/rental-technical-fields');
  const target = { templateId, publishedVersion, customParticipantFields: structuredClone([...dropdowns, ...finals]) };
  const w = waiver(), r = review(w, { skierCode: 'M' });
  r.finalSettings = { leftToe: '6.25', leftHeel: '6.50', rightToe: '5.75', rightHeel: '6.00' };
  const before = JSON.stringify({ w, r, target });
  const result = buildLiabilityPrefill(w, {}, target, 0, r);
  assert.deepEqual(result.payload.participants[0].customFields, {
    '5ktkNvPGcPnv4o2ea9jBuv': 'M',
    k26zGhNRXqxW4AamXpHUEx: '7,00',
    cVR22k9ALMuAs6EtVsau14: '311–330',
    byaj6QE3jt8u4FBcs5NQUU: '6.25',
    hQBJX42Bf4rTgA2whsjen2: '6.50',
    '4iaqE8mr6v1KmHuRtJf2Uu': '5.75',
    '5vcq7mUTY11uT9Bf6wzmeh': '6.00',
  });
  assert.equal(result.payload.customWaiverFields, undefined);
  assert.equal(result.payload.lockdownPrefill, false);
  assert.equal(result.copiedFields.filter(value => value.includes('(technician reviewed)')).length, 7);
  assert.equal(JSON.stringify({ w, r, target }), before, 'Source, explicit review and metadata are immutable');
  const withoutFinals = { ...r }; delete withoutFinals.finalSettings;
  const onlyCalculated = buildLiabilityPrefill(w, {}, target, 0, withoutFinals).payload.participants[0].customFields;
  assert.equal(Object.keys(onlyCalculated).length, 3);
  for (const field of finals) assert.equal(Object.hasOwn(onlyCalculated, field.guid), false);
  for (const field of finals) {
    const missing = { ...target, customParticipantFields: target.customParticipantFields.filter(item => item.guid !== field.guid) };
    rejects(() => buildLiabilityPrefill(w, {}, missing, 0, r), 'TECHNICIAN_FIELD_MISSING');
  }
  for (const key of Object.keys(r.finalSettings)) {
    const incomplete = { ...r, finalSettings: { ...r.finalSettings } }; delete incomplete.finalSettings[key];
    rejects(() => buildLiabilityPrefill(w, {}, target, 0, incomplete), 'TECHNICIAN_FINAL_SETTINGS_INCOMPLETE');
  }
});

test('all 46 captured DIN options and all 16 skier codes match exactly without rounding', () => {
  const contract = contracts.find(item => item.templateId === templateId && item.publishedVersion === publishedVersion);
  const dinOptions = contract.fields.find(field => field.label === 'Initial Indicator Value').values;
  assert.equal(dinOptions.length, 46);
  for (const option of dinOptions) {
    const exact = option.replace(',', '.');
    assert.equal(build({ din: exact }).waiverFields.synthetic_dynamic_din, option);
    assert.equal(build({ din: Number(exact) }).waiverFields.synthetic_dynamic_din, option);
  }
  for (const code of 'ABCDEFGHIJKLMNOP') assert.equal(build({ skierCode: code }).waiverFields.synthetic_dynamic_code, code);
  assert.equal(build({ din: '7.0000' }).waiverFields.synthetic_dynamic_din, '7,00');
  for (const din of [0.5, 0.76, 1.1, 7.01, 12.25, '7.000000000000001']) rejects(() => build({ din }), 'TECHNICIAN_ENUM_VALUE_UNSUPPORTED');
});

test('all eight verified BSL columns have exact inclusive boundaries and out-of-range measurements fail closed', () => {
  const boundaries = [[200, '≤230'], [230, '≤230'], [231, '231–250'], [250, '231–250'], [251, '251–270'], [270, '251–270'], [271, '271–290'], [290, '271–290'], [291, '291–310'], [310, '291–310'], [311, '311–330'], [315, '311–330'], [330, '311–330'], [331, '331–350'], [350, '331–350'], [351, '≥351'], [420, '≥351']];
  for (const [length, option] of boundaries) assert.equal(build({ bootSoleLengthMm: length }).waiverFields.synthetic_dynamic_bsl, option, `${length} mm`);
  for (const length of [0, 199, 421, 315.5, '', null]) rejects(() => build({ bootSoleLengthMm: length }), 'TECHNICIAN_VALUE_INVALID');
});

test('an explicitly verified full BSL contract supports its lowest column without inventing a live template binding', () => {
  // Test both supported spellings without changing the live contract's exact
  // Unicode option text or trusting any different publication version.
  for (const [low, high, separator] of [['<=230', '>=351', '-'], ['≤230', '≥351', '–']]) {
    const options = [low, ...['231-250', '251-270', '271-290', '291-310', '311-330', '331-350'].map(v => v.replace('-', separator)), high];
    mutateContract(list => { list[0].fields.find(field => field.label === 'Boot Sole Length (mm)').values = options; }, () => {
      const boundaries = [[200, 0], [230, 0], [231, 1], [250, 1], [251, 2], [270, 2], [271, 3], [290, 3], [291, 4], [310, 4], [311, 5], [330, 5], [331, 6], [350, 6], [351, 7], [420, 7]];
      for (const [length, index] of boundaries) assert.equal(build({ bootSoleLengthMm: length }).waiverFields.synthetic_dynamic_bsl, options[index]);
      for (const length of [199, 421, 230.5]) rejects(() => build({ bootSoleLengthMm: length }), 'TECHNICIAN_VALUE_INVALID');
      rejects(() => build({}, { ...template(), publishedVersion: 1616021 }), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED');
    });
  }
});

test('damaged BSL operators are rejected and overlapping lowest columns remain ambiguous', () => {
  for (const option of ['=351', '>351', '<230', '≤NaN', '<=9007199254740992']) {
    mutateContract(list => { list[0].fields.find(field => field.label === 'Boot Sole Length (mm)').values = [option]; }, () => {
      rejects(() => build(), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED');
    });
  }
  mutateContract(list => { list[0].fields.find(field => field.label === 'Boot Sole Length (mm)').values.unshift('≤250'); }, () => {
    rejects(() => build({ bootSoleLengthMm: 240 }), 'TECHNICIAN_ENUM_VALUE_AMBIGUOUS');
  });
});

test('unverified template IDs or publication versions cannot reuse the captured contract', () => {
  for (const changed of [{ templateId: 'another_template' }, { templateId: '' }, { publishedVersion: 1051919 }, { publishedVersion: 1616021 }, { publishedVersion: 1616023 }, { publishedVersion: '1616022' }, { publishedVersion: undefined }]) rejects(() => build({}, { ...template(), ...changed }), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED');
  mutateContract(list => list.splice(0), () => rejects(() => build(), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED'));
  mutateContract(list => list.push(structuredClone(list[0])), () => rejects(() => build(), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED'));
});

test('ambiguous decimal-equivalent options or overlapping ranges never choose the first match', () => {
  mutateContract(list => list[0].fields.find(field => field.label === 'Initial Indicator Value').values.push('7,000'), () => rejects(() => build(), 'TECHNICIAN_ENUM_VALUE_AMBIGUOUS'));
  mutateContract(list => list[0].fields.find(field => field.label === 'Boot Sole Length (mm)').values.push('300-320'), () => rejects(() => build(), 'TECHNICIAN_ENUM_VALUE_AMBIGUOUS'));
  mutateContract(list => list[0].fields.find(field => field.label === 'Boot Sole Length (mm)').values.push('330-311'), () => rejects(() => build(), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED'));
  mutateContract(list => list[0].fields.find(field => field.label === 'Initial Indicator Value').values.push('7.00'), () => rejects(() => build(), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED'));
});

test('captured option values, field contracts and serialization cannot be replaced by client metadata', () => {
  const w = waiver(), r = review(w, { din: 7.01 });
  r.enumContracts = [{ templateId, publishedVersion, values: ['7.01'] }];
  r.calculated.choices = ['7.01'];
  const t = template(); t.customFields[1].options = ['7.01']; t.customFields[1].choices = ['7.01'];
  rejects(() => buildTechnicianPrefill(w, t, 0, r), 'TECHNICIAN_ENUM_VALUE_UNSUPPORTED');
  mutateContract(list => { list[0].fields[0].serialization = 'unverified'; }, () => rejects(() => build(), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED'));
  mutateContract(list => { list[0].fields[0].type = 'string'; }, () => rejects(() => build(), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED'));
  mutateContract(list => list[0].fields[0].values.push('L'), () => rejects(() => build(), 'TECHNICIAN_ENUM_CONTRACT_UNVERIFIED'));
});

test('exact initial-indicator alias remains unique and excluded from unreviewed generic copying', () => {
  assert.equal(isTechnicianFieldLabel('Initial Indicator Value'), true);
  assert.equal(isTechnicianFieldLabel('initial indicator value'), true);
  const duplicate = template(); duplicate.customFields.push(definition('synthetic_old_din', 'DIN'));
  rejects(() => build({}, duplicate), 'TECHNICIAN_FIELD_AMBIGUOUS');
  const nearMatch = template(); nearMatch.customFields[1].label = 'Initial indicator value';
  rejects(() => build({}, nearMatch), 'TECHNICIAN_FIELD_MISSING');
  const w = waiver(); w.customWaiverFields = { old: { displayText: 'Initial Indicator Value', value: '12,00' } };
  const source = { customFields: [definition('old', 'Initial Indicator Value')] };
  assert.equal(buildLiabilityPrefill(w, source, template()).payload.customWaiverFields, undefined);
});
