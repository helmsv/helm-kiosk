// Read-only normalization of ONE signed intake. Never borrow measurements from
// another participant or a guardian. No DIN chart or release-value logic lives here.
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const labelKey = value => text(value).replace(/<[^>]*>/g, '').toLowerCase().replace(/&nbsp;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function fields(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(fields);
  const label = node.displayText ?? node.label ?? node.title ?? node.name;
  if (label != null && ('value' in node || 'answer' in node || 'response' in node)) {
    return [{ label: labelKey(label), value: node.value ?? node.answer ?? node.response }];
  }
  return Object.values(node).flatMap(value => value && typeof value === 'object' ? fields(value) : []);
}
function find(pairs, aliases) { return pairs.filter(field => aliases.includes(field.label)); }
function positive(value) {
  const s = text(value);
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function uniqueValue(values) {
  if (!values.length || values.some(v => v == null)) return null;
  const first = values[0];
  return values.every(v => typeof v === 'number' ? Math.abs(v - first) < 0.01 : v === first) ? first : null;
}
function height(value, label = '') {
  const s = text(value).toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  let m = s.match(/^(\d+)\s*(?:'|ft|feet|foot|-)\s*(\d+(?:\.\d+)?)?\s*(?:"|in|inch|inches)?$/);
  if (m) {
    const feet = Number(m[1]), inches = Number(m[2] || 0);
    return inches < 12 && feet * 12 + inches > 0 ? feet * 12 + inches : null;
  }
  m = s.match(/^(\d+(?:\.\d+)?)\s*(cm|centimeters?|centimetres?|m|meters?|metres?|in|inch|inches|"|ft|feet|foot)?$/);
  if (!m) return null;
  const n = positive(m[1]); if (n == null) return null;
  const unit = m[2] || (/\b(cm|centimeters?|centimetres?)\b/.test(label) ? 'cm' : /\b(m|meters?|metres?)\b/.test(label) ? 'm' : /\b(ft|feet|foot)\b/.test(label) ? 'ft' : /\b(in|inches?)\b/.test(label) ? 'in' : '');
  if (/^(cm|centimet)/.test(unit)) return n / 2.54;
  if (/^(m|meters?|metres?)$/.test(unit)) return n * 100 / 2.54;
  if (/^(ft|feet|foot)$/.test(unit)) return n * 12;
  if (unit) return n;
  // Legacy bare Height answers were inches; do not guess metric or decimal feet.
  return n >= 45 && n <= 90 ? n : null;
}
function weight(value, label = '') {
  const m = text(value).toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)?$/);
  if (!m) return null;
  const n = positive(m[1]); if (n == null) return null;
  const unit = m[2] || (/\b(kg|kgs|kilograms?)\b/.test(label) ? 'kg' : 'lb');
  return /^(kg|kilogram)/.test(unit) ? n * 2.2046226218 : n;
}
function skierType(value) {
  const s = text(value).toUpperCase();
  const m = s.match(/^(?:TYPE\s*)?(III|II|I|3|2|1)(?:\s*(?:[–—:().-]|$)|\s+(?:CAUTIOUS|MODERATE|AVERAGE|AGGRESSIVE|BEGINNER|INTERMEDIATE|ADVANCED)\b)/);
  if (m) return ({ 1: 'I', 2: 'II', 3: 'III' })[m[1]] || m[1];
  if (/^(CAUTIOUS|BEGINNER)$/.test(s)) return 'I';
  if (/^(MODERATE|AVERAGE|INTERMEDIATE)$/.test(s)) return 'II';
  if (/^(AGGRESSIVE|ADVANCED)$/.test(s)) return 'III';
  return '';
}
function validDob(value) {
  const s = text(value), m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || s === '1800-01-01') return '';
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : '';
}
function ageFromDob(value, now = new Date()) {
  const dob = validDob(value); if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}
const HEIGHT = ['height', 'height in', 'height inches', 'height cm', 'height centimeters', 'height centimetres', 'height m', 'height meters', 'height metres', 'height ft', 'height feet', 'height feet inches', 'height ft in'];
const WEIGHT = ['weight', 'weight lb', 'weight lbs', 'weight pounds', 'weight kg', 'weight kgs', 'weight kilograms'];
function mapParticipant(p, index, waiverFields, single, now) {
  const own = fields(p.customParticipantFields || p.customFields || p.fields || []);
  // Legacy waiver-level measurement fields are safe only for a single participant.
  function matches(aliases) { const hit = find(own, aliases); return hit.length ? hit : single ? find(waiverFields, aliases) : []; }
  const dob = validDob(p.dob || p.dateOfBirth);
  const ages = matches(['age', 'age years']).map(({ value }) => /^\d{1,3}$/.test(text(value)) && Number(value) < 130 ? Number(value) : null);
  const heightFields = matches(HEIGHT);
  const ft = heightFields.filter(f => ['height ft', 'height feet'].includes(f.label));
  const inch = heightFields.filter(f => ['height in', 'height inches'].includes(f.label));
  let heightIn;
  if (ft.length && inch.length) {
    const f = uniqueValue(ft.map(f => positive(f.value))), i = uniqueValue(inch.map(f => /^\d+(?:\.\d+)?$/.test(text(f.value)) ? Number(f.value) : null));
    const split = f != null && i != null && i >= 0 && i < 12 ? f * 12 + i : null;
    const other = heightFields.filter(field => !ft.includes(field) && !inch.includes(field));
    heightIn = uniqueValue([split, ...other.map(field => height(field.value, field.label))]);
  } else { heightIn = uniqueValue(heightFields.map(f => height(f.value, f.label))); }
  const weightLb = uniqueValue(matches(WEIGHT).map(f => weight(f.value, f.label)));
  const type = uniqueValue(matches(['skier type', 'skier classification']).map(f => skierType(f.value) || null)) || '';
  return { participant_index: index, first_name: text(p.firstName), last_name: text(p.lastName), date_of_birth: dob, is_minor: p.isMinor === true, age: ageFromDob(dob, now) ?? uniqueValue(ages), height_in: heightIn, weight_lb: weightLb, skier_type: type };
}
function normalizeIntake(waiver, now = new Date()) {
  const participants = Array.isArray(waiver.participants) ? waiver.participants : [];
  const waiverFields = fields(waiver.customWaiverFields || []);
  return { waiver_id: text(waiver.waiverId), template_id: text(waiver.templateId), email: text(waiver.email || waiver.contactEmail), participants: participants.map((p, index) => mapParticipant(p || {}, index, waiverFields, participants.length === 1 && !waiver.guardian && (p.isMinor === false || (ageFromDob(p.dob || p.dateOfBirth, now) ?? -1) >= 18), now)) };
}
module.exports = { fields, height, weight, skierType, validDob, ageFromDob, normalizeIntake };
