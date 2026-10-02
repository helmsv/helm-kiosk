const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeIntake, height, weight, skierType, ageFromDob } = require('../lib/intake-normalize');
const fixture = require('./fixtures/intake.json');
const now = new Date('2026-10-02T12:00:00Z');
test('actual v4 GUID maps/displayText/dob normalize each participant independently', () => {
  const data = normalizeIntake(fixture, now);
  assert.equal(data.waiver_id, fixture.waiverId);
  const [adult, child] = data.participants;
  assert.equal(adult.age, 40); assert.equal(child.age, 9);
  assert.equal(adult.weight_lb, 180); assert.equal(adult.height_in, 71); assert.equal(adult.skier_type, 'III');
  assert.ok(Math.abs(child.weight_lb - 66.138678654) < 1e-7);
  assert.ok(Math.abs(child.height_in - 130 / 2.54) < 1e-7);
  assert.equal(child.skier_type, 'I'); assert.equal(child.participant_index, 1);
  assert.equal(child.date_of_birth, '2017-10-02');
  assert.equal('_raw' in adult, false);
});
test('missing participant values never borrow from sibling, guardian, or waiver', () => {
  const waiver = structuredClone(fixture);
  waiver.participants[1].customParticipantFields = {};
  waiver.guardian = { dob: '1960-01-01', customParticipantFields: { x: {displayText: 'Weight', value: '200'} } };
  const child = normalizeIntake(waiver, now).participants[1];
  assert.equal(child.weight_lb, null); assert.equal(child.height_in, null); assert.equal(child.skier_type, '');
  assert.equal(child.age, 9);
});
test('legacy waiver-level measurements are allowed only for exactly one participant', () => {
  const waiver = { participants: [{firstName: 'Single', dob: '1990-01-01'}], customWaiverFields: {x: {displayText: 'Weight', value: '150'}} };
  assert.equal(normalizeIntake(waiver, now).participants[0].weight_lb, 150);
  waiver.participants.push({firstName: 'Second'});
  assert.equal(normalizeIntake(waiver, now).participants[0].weight_lb, null);
});
test('units, decimals and split feet/inches stay explicit without numeric guessing', () => {
  assert.equal(height('5.9 ft'), 70.80000000000001);
  assert.equal(height('180 cm'), 180 / 2.54);
  assert.equal(height('1.8 meters'), 180 / 2.54);
  assert.equal(height('1.8 metres'), 180 / 2.54);
  assert.equal(height('1.8', 'height m'), 180 / 2.54);
  assert.equal(height('71 in'), 71);
  assert.equal(height('170'), null);
  assert.equal(height('5-12'), null);
  assert.equal(height('-5 ft'), null);
  assert.equal(weight('80 kg'), 80 * 2.2046226218);
  assert.equal(weight('180.5 lb'), 180.5);
  for (const value of [null, '', 0, '0', '-80', '80-100', 'unknown', {}, true]) assert.equal(weight(value), null);
  const p = normalizeIntake({participants: [{isMinor:false,fields: [{label:'Height (ft)',value:'5'}, {label:'Height (in)',value:'0'}]}]}, now).participants[0];
  assert.equal(p.height_in, 60);
});
test('DOB boundaries and exact Age matching avoid average/range labels and invalid dates', () => {
  assert.equal(ageFromDob('2000-10-03', now), 25);
  assert.equal(ageFromDob('2000-10-02', now), 26);
  assert.equal(ageFromDob('1800-01-01', now), null);
  assert.equal(ageFromDob('2026-02-30', now), null);
  assert.equal(ageFromDob('2027-01-01', now), null);
  const p = normalizeIntake({participants:[{fields:[{label:'Average speed', value:'40'}]}]}, now).participants[0];
  assert.equal(p.age, null);
});
test('unknown or conflicting values remain missing instead of default skier type II', () => {
  assert.equal(skierType('Type II - Moderate'), 'II');
  assert.equal(skierType('I do not know'), '');
  assert.equal(skierType('Not selected'), '');
  const p = normalizeIntake({participants:[{fields:[{label:'Weight',value:'170'},{label:'Weight',value:'180'}]}]}, now).participants[0];
  assert.equal(p.weight_lb, null);
});
test('no participant array produces no fabricated person', () => {
  assert.deepEqual(normalizeIntake({firstName:'Guardian',weight:200}, now).participants, []);
});

test('a minor with a guardian never inherits adult waiver-level measurements', () => {
  const data = normalizeIntake({ participants:[{firstName:'Child',dob:'2017-01-01',isMinor:true}],guardian:{firstName:'Guardian'},customWaiverFields:{w:{displayText:'Weight',value:'180'},h:{displayText:'Height',value:'70'},s:{displayText:'Skier Type',value:'III'}} }, now);
  assert.equal(data.participants[0].weight_lb,null);
  assert.equal(data.participants[0].height_in,null);
  assert.equal(data.participants[0].skier_type,'');
});

test('split height must agree with other supplied height fields', () => {
  const waiver = {participants:[{isMinor:false,fields:[{label:'Height (ft)',value:'5'},{label:'Height (in)',value:'11'},{label:'Height (cm)',value:'100'}]}]};
  assert.equal(normalizeIntake(waiver,now).participants[0].height_in,null);
  waiver.participants[0].fields[2].value='180.34';
  assert.equal(normalizeIntake(waiver,now).participants[0].height_in,71);
});
