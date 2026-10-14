// Published metadata and connected Chrome prefill verified for the text-based
// agreement. Validate exact GUID, label, type and participant scope at runtime.
const TEXT_FIELDS = Object.freeze([
  { key: 'skierCode', label: 'Calculated Skier Code (reference)', guid: '6PxH3icvZdRpLvuN76oVzZ' },
  { key: 'din', label: 'Calculated Initial Indicator Value (single DIN)', guid: 'fQiBCMVsnR6FKaZ3WwKWRt' },
  { key: 'bootSoleLengthMm', label: 'Measured Boot Sole Length (mm)', guid: 'soPjWoAx9poFLyTFXDqtDN' },
  { key: 'bootSoleLengthRange', label: 'Boot Sole Length Range (mm, calculated)', guid: '8TNbfYgNWRxEwm1A8Njkkk' },
  { key: 'leftToe', label: 'Final Indicator Setting: Left Toe', guid: 'byaj6QE3jt8u4FBcs5NQUU', final: true },
  { key: 'leftHeel', label: 'Final Indicator Setting: Left Heel', guid: 'hQBJX42Bf4rTgA2whsjen2', final: true },
  { key: 'rightToe', label: 'Final Indicator Setting: Right Toe', guid: '4iaqE8mr6v1KmHuRtJf2Uu', final: true },
  { key: 'rightHeel', label: 'Final Indicator Setting: Right Heel', guid: '5vcq7mUTY11uT9Bf6wzmeh', final: true },
].map(field => Object.freeze({ ...field, pairs: ['textbox:string'] })));

// Display the existing inclusive BSL chart column in provider-safe text. This
// does not calculate DIN, round measurements, or change the existing chart.
function bootSoleLengthRange(mm) {
  if (mm <= 230) return '230 or less';
  for (let upper = 250; upper <= 350; upper += 20) {
    if (mm <= upper) return `${upper - 19}-${upper}`;
  }
  return '351 or more';
}
module.exports = { TEXT_FIELDS, bootSoleLengthRange };
