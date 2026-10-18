const test = require('node:test');
const assert = require('node:assert/strict');
const { pendingRows, sourceTag } = require('../rental-data');
const row = (index = 0) => ({
  waiver_id: 'synthetic_family', participant_index: index,
  first_name: index ? `Sibling ${index}` : 'Child', last_name: 'Example',
  email: 'family@example.invalid', lightspeed_id: 'family',
  signed_on: '2026-10-02T10:00:00Z'
});
const liability = {
  waiverId: 'signed_final', signed: true, firstName: 'Child', lastName: 'Example',
  email: 'family@example.invalid', autoTag: 'ls_family', createdOn: '2026-10-02T11:00:00Z'
};
const linked = { ...liability, autoTag: sourceTag('synthetic_family', 0) };

test('three minors sharing the linked intake and LS ID leave the pending queue after one final signature', () => {
  const family = [row(), row(1), row(2)];
  const original = structuredClone(family);
  assert.deepEqual(pendingRows(family, [linked]), []);
  assert.deepEqual(family, original, 'source participant records remain unchanged');
});

test('different LS IDs and another rental for the same reusable customer ID stay pending', () => {
  const otherId = { ...row(3), lightspeed_id: 'different' };
  const anotherRental = { ...row(), waiver_id: 'another_intake' };
  assert.deepEqual(pendingRows([row(), row(1), otherId, anotherRental], [linked]), [otherId, anotherRental]);
});

test('blank, missing, malformed and case-different IDs never collapse together', () => {
  for (const id of ['', undefined, null, ' ', 'family ', 'family/invalid']) {
    const rows = [row(), row(1), row(2)].map(item => ({ ...item, lightspeed_id: id }));
    assert.deepEqual(pendingRows(rows, [linked]), rows.slice(1), 'only the exact participant link completes without a valid group ID');
  }
  const caseDifferent = { ...row(1), lightspeed_id: 'Family' };
  assert.deepEqual(pendingRows([row(), caseDifferent], [linked]), [caseDifferent]);
});

test('unsigned and unverified evidence never completes a participant or a group', () => {
  const rows = [row(), row(1), row(2)];
  for (const evidence of [{ ...linked, signed: false }, { ...linked, signed: undefined }, { ...linked, waiverId: '' }]) {
    assert.deepEqual(pendingRows(rows, [evidence], true), rows);
  }
});

test('repeated signed events and repeated page loads are idempotent', () => {
  const rows = [row(), row(1), row(2)];
  for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(pendingRows(rows, [linked, linked]), []);
  assert.deepEqual(pendingRows([], [linked]), []);
});

test('source external ID also completes the exact intake and does not require matching edited names', () => {
  const final = { ...linked, firstName: 'Corrected', autoTag: '', externalId: linked.autoTag };
  assert.deepEqual(pendingRows([row(), row(1), row(2)], [final]), []);
});

test('an older, invalid-time, or unrelated-source final cannot complete the group', () => {
  const rows = [row(), row(1), row(2)];
  for (const evidence of [{ ...linked, createdOn: 'invalid' }, { ...linked, createdOn: '2026-10-01T11:00:00Z' }, { ...linked, autoTag: sourceTag('another_intake', 0) }]) {
    assert.deepEqual(pendingRows(rows, [evidence]), rows);
  }
});

test('family contact/customer ID alone never suppresses siblings or a whole rental', () => {
  assert.deepEqual(pendingRows([row(), row(1)], [liability], true), [row(1)]);
  assert.equal(pendingRows([row(), row(1)], [{ ...liability, firstName: 'Guardian' }], true).length, 2);
});

test('legacy matching requires complete hydration and an unambiguous chronological identity', () => {
  assert.equal(pendingRows([row()], [liability], false).length, 1);
  assert.equal(pendingRows([row(), { ...row(), waiver_id: 'another_intake' }], [liability], true).length, 2);
  assert.equal(pendingRows([row()], [{ ...liability, createdOn: 'invalid' }], true).length, 1);
  assert.equal(pendingRows([row()], [{ ...liability, createdOn: '2026-10-01T11:00:00Z' }], true).length, 1);
});
