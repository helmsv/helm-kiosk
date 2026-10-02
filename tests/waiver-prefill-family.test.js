const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiabilityPrefill } = require('../lib/waiver-prefill');

test('an explicit guardian plus an adult renter fails closed instead of silently dropping the adult', () => {
  const waiver = {
    waiverId: 'synthetic_intake_conflicting_family',
    participants: [
      { firstName: 'Adult Renter', lastName: 'Example', dob: '1985-01-01', isMinor: false },
      { firstName: 'Minor Renter', lastName: 'Example', dob: '2015-01-01', isMinor: true },
    ],
    guardian: { firstName: 'Separate Guardian', lastName: 'Example', dob: '1980-01-01' },
  };
  const before = JSON.stringify(waiver);
  for (const selected of [0, 1]) {
    assert.throws(() => buildLiabilityPrefill(waiver, {}, {}, selected), error => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /guardian and adult participant records are inconsistent/);
      return true;
    });
  }
  assert.equal(JSON.stringify(waiver), before, 'signed source identities must remain untouched');
});
