// Test-only dependency fixture. This never populates the production registry or
// accepts request-supplied choices. Install before importing the prefill builder.
module.exports = function installSyntheticEnumContracts(templateIds) {
  const location = require.resolve('../../lib/technician-enum-contracts.json');
  const values = ['0.75', '1', '1.25', '1.5', '2', '3', '4', '5', '5.75', '6', '6.00', '6.25', '6.5', '7', '8.5'];
  const definitions = [
    { label: 'Skier Code', values: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'] },
    { label: 'DIN', values }, { label: 'Initial Indicator Value', values },
    { label: 'Boot Sole Length (mm)', values: ['300', '315', '320'] },
  ].map(field => ({ ...field, fieldType: 'optionlist', type: 'enum' }));
  const contracts = templateIds.map(templateId => ({ templateId, publishedVersion: 1, fields: structuredClone(definitions) }));
  require.cache[location] = { id: location, filename: location, loaded: true, exports: contracts };
  return contracts;
};
