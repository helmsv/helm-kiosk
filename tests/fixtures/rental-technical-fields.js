// Configuration IDs/labels observed on the original public unsigned rental
// template. This fixture does not assert any API publication version, does not
// populate the production option registry, and contains no customer answers.
const dropdowns = [
  { label: 'Skier Code', guid: '5ktkNvPGcPnv4o2ea9jBuv' },
  { label: 'Initial Indicator Value', guid: 'k26zGhNRXqxW4AamXpHUEx' },
  { label: 'Boot Sole Length (mm)', guid: 'cVR22k9ALMuAs6EtVsau14' },
].map(field => ({ ...field, fieldType: 'optionlist', type: 'enum' }));
const finals = [
  { label: 'Final Indicator Setting: Left Toe', guid: 'byaj6QE3jt8u4FBcs5NQUU' },
  { label: 'Final Indicator Setting: Left Heel', guid: 'hQBJX42Bf4rTgA2whsjen2' },
  { label: 'Final Indicator Setting: Right Toe', guid: '4iaqE8mr6v1KmHuRtJf2Uu' },
  { label: 'Final Indicator Setting: Right Heel', guid: '5vcq7mUTY11uT9Bf6wzmeh' },
].map(field => ({ ...field, fieldType: 'textbox', type: 'string' }));
module.exports = { dropdowns, finals };
