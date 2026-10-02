// This builder does not authorize access; the caller must verify a staff session.
// It only prepares explicit, reviewed values for an EDITABLE, UNSIGNED prefill.
// Smartwaiver v4: https://api.smartwaiver.com/api/docs#prefill
const { normalizeIntake } = require('./intake-normalize');
const { missingDinInputs } = require('../rental-data');

// Exact labels verified in the final form. No aliases or inferred GUIDs are used
// for destination resolution. GUIDs must come from that template's metadata.
const FIELDS = Object.freeze([
  { key: 'skierCode', label: 'Skier Code', pairs: ['textbox:string', 'optionlist:enum'] },
  { key: 'din', label: 'DIN', pairs: ['optionlist:enum'] },
  { key: 'bootSoleLengthMm', label: 'Boot Sole Length (mm)', pairs: ['textbox:string', 'numerictextbox:number'] },
  { key: 'leftToe', label: 'Final Indicator Setting: Left Toe', final: true, pairs: ['textbox:string', 'numerictextbox:number', 'optionlist:enum'] },
  { key: 'leftHeel', label: 'Final Indicator Setting: Left Heel', final: true, pairs: ['textbox:string', 'numerictextbox:number', 'optionlist:enum'] },
  { key: 'rightToe', label: 'Final Indicator Setting: Right Toe', final: true, pairs: ['textbox:string', 'numerictextbox:number', 'optionlist:enum'] },
  { key: 'rightHeel', label: 'Final Indicator Setting: Right Heel', final: true, pairs: ['textbox:string', 'numerictextbox:number', 'optionlist:enum'] },
]);
const FINAL_KEYS = FIELDS.filter(f => f.final).map(f => f.key);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const reservedLabelKey = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const RESERVED_LABELS = new Set(FIELDS.map(f => reservedLabelKey(f.label)));

function fail(code, message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  throw error;
}

// A broader exclusion is intentional: ordinary intake mapping must not smuggle
// a stale technician value through a punctuation/case variant of these labels.
function isTechnicianFieldLabel(label) { return RESERVED_LABELS.has(reservedLabelKey(label)); }

function fieldsAt(template, keys, scope) {
  const lists = [];
  for (const key of keys) {
    if (template?.[key] == null) continue;
    const raw = template[key];
    if (!Array.isArray(raw) && !plainObject(raw)) fail('TECHNICIAN_METADATA_INVALID', 'Final waiver field metadata is not valid. Review the template before continuing.');
    const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([guid, field]) => {
      if (!plainObject(field) || (own(field, 'guid') && field.guid !== guid)) fail('TECHNICIAN_METADATA_INVALID', 'Final waiver field metadata contains conflicting field IDs.');
      return { ...field, guid };
    });
    for (const field of entries) {
      if (!plainObject(field)) fail('TECHNICIAN_METADATA_INVALID', 'Final waiver field metadata is not valid.');
      lists.push({ ...field, scope });
    }
  }
  return lists;
}

function templateFields(template) {
  return [
    ...fieldsAt(template, ['customParticipantFields', 'participantCustomFields'], 'participant'),
    ...fieldsAt(template, ['customFields', 'customWaiverFields'], 'waiver'),
  ];
}

function numericText(value, label) {
  // This is serialization validation, not a DIN standard or binding adjustment
  // recommendation. Preserve reviewed decimal strings, including trailing zeros.
  if (typeof value !== 'number' && typeof value !== 'string') fail('TECHNICIAN_VALUE_INVALID', `${label} must be an explicitly reviewed numeric value.`);
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) fail('TECHNICIAN_VALUE_INVALID', `${label} must be an explicitly reviewed numeric value.`);
  return text;
}

function identityKey(person) {
  return [person.first_name, person.last_name, person.date_of_birth].map(v => typeof v === 'string' ? v.normalize('NFC').trim().toLowerCase() : '').join('\u0000');
}

function validateReview(waiver, participantIndex, review, now) {
  if (!plainObject(review) || review.reviewed !== true) fail('TECHNICIAN_REVIEW_REQUIRED', 'Review the current participant, measured boot, skier code and calculated DIN before transferring technician values.');
  if (typeof waiver?.waiverId !== 'string' || !waiver.waiverId || review.waiverId !== waiver.waiverId || review.participantIndex !== participantIndex || !Number.isInteger(participantIndex)) fail('TECHNICIAN_SELECTION_STALE', 'The reviewed intake or participant no longer matches. Reopen and review the selected participant.');
  const intake = normalizeIntake(waiver, now);
  const selected = intake.participants[participantIndex];
  if (!selected || participantIndex < 0) fail('TECHNICIAN_SELECTION_STALE', 'The selected participant is missing. Refresh the intake.');
  // The browser only needs the already-displayed names, selection IDs and
  // measurement snapshot. Never require exposing a raw DOB just for this check.
  if (!plainObject(review.participant) || !selected.first_name || !selected.last_name || ['first_name', 'last_name'].some(key => review.participant[key] !== selected[key]) || (own(review.participant, 'date_of_birth') && review.participant.date_of_birth !== selected.date_of_birth)) fail('TECHNICIAN_IDENTITY_UNVERIFIED', 'The reviewed identity must match the selected intake participant.');
  if (intake.participants.filter(person => identityKey(person) === identityKey(selected)).length !== 1) fail('TECHNICIAN_IDENTITY_AMBIGUOUS', 'This intake contains duplicate participant identities. Technician values cannot be assigned safely.');
  if (!plainObject(review.source) || ['weight_lb', 'height_in', 'age', 'skier_type'].some(key => !own(review.source, key) || review.source[key] !== selected[key])) fail('TECHNICIAN_SOURCE_STALE', 'The intake measurements have changed since review. Reopen the calculator and review them again.');
  if (!plainObject(review.calculated)) fail('TECHNICIAN_VALUE_INVALID', 'Reviewed calculator results are missing.');
  const { skierCode, din, bootSoleLengthMm } = review.calculated;
  if (typeof skierCode !== 'string' || !/^[A-P]$/.test(skierCode)) fail('TECHNICIAN_VALUE_INVALID', 'A reviewed skier code from the current calculator is required.');
  const values = { skierCode, din: numericText(din, 'Calculated DIN'), bootSoleLengthMm: numericText(bootSoleLengthMm, 'Measured boot sole length') };
  if (!Number.isInteger(Number(values.bootSoleLengthMm))) fail('TECHNICIAN_VALUE_INVALID', 'Measured boot sole length must be a whole number of millimeters.');
  if (Number(values.din) <= 0 || missingDinInputs({ ...selected, age_years:selected.age, skierType:selected.skier_type, bsl_mm:Number(values.bootSoleLengthMm) }).length) fail('TECHNICIAN_VALUE_INVALID', 'Complete and review the intake measurements and measured boot sole length before transferring DIN.');
  // Never fill indicator settings with calculated DIN. The technician may omit
  // this group completely; supplying it requires four independent values.
  if (own(review, 'finalSettings')) {
    if (!plainObject(review.finalSettings) || FINAL_KEYS.some(key => !own(review.finalSettings, key)) || Object.keys(review.finalSettings).some(key => !FINAL_KEYS.includes(key))) fail('TECHNICIAN_FINAL_SETTINGS_INCOMPLETE', 'Enter and review all four final indicator settings, or leave all four blank.');
    for (const spec of FIELDS.filter(f => f.final)) values[spec.key] = numericText(review.finalSettings[spec.key], spec.label);
  }
  return { values, participantCount: intake.participants.length };
}

/**
 * This is a payload builder, not an authentication or attestation boundary.
 * The caller must independently verify a staff session before fetching source
 * customer records or creating any prefill. The API verifies staff access before reading source data and before creating a draft.
 */
function buildTechnicianPrefill(waiver, template, participantIndex, review, { now = new Date() } = {}) {
  const { values, participantCount } = validateReview(waiver, participantIndex, review, now);
  const definitions = templateFields(template);
  const participantFields = Object.create(null), waiverFields = Object.create(null);
  const copiedFields = [];
  const requested = FIELDS.filter(spec => own(values, spec.key));
  const resolved = [];
  for (const spec of requested) {
    const matches = definitions.filter(field => field.label === spec.label);
    if (!matches.length) fail('TECHNICIAN_FIELD_MISSING', `Final waiver field "${spec.label}" is missing. Enter technician values manually after reviewing the template.`);
    if (matches.length !== 1) fail('TECHNICIAN_FIELD_AMBIGUOUS', `Final waiver field "${spec.label}" is ambiguous. Technician values were not transferred.`);
    const field = matches[0];
    if (typeof field.guid !== 'string' || !field.guid || field.guid !== field.guid.trim() || ['__proto__', 'constructor', 'prototype'].includes(field.guid) || definitions.filter(f => f.guid === field.guid).length !== 1) fail('TECHNICIAN_GUID_INVALID', `Final waiver field "${spec.label}" has an invalid or conflicting field ID.`);
    if (!spec.pairs.includes(`${field.fieldType}:${field.type}`)) fail('TECHNICIAN_FIELD_TYPE_UNSUPPORTED', `Final waiver field "${spec.label}" has an unsupported field type. Review the template before transferring it.`);
    if (field.scope === 'waiver' && participantCount !== 1) fail('TECHNICIAN_FAMILY_SCOPE_UNSUPPORTED', `Final waiver field "${spec.label}" is shared across multiple participants. Use separate participant fields or enter technician values manually.`);
    resolved.push({ spec, field });
  }
  // Resolve every destination before producing a map; no partial success.
  for (const { spec, field } of resolved) {
    const out = field.scope === 'participant' ? participantFields : waiverFields;
    out[field.guid] = values[spec.key];
    copiedFields.push(`${field.scope === 'participant' ? 'Selected participant' : 'Waiver'}: ${spec.label} (technician reviewed)`);
  }
  return { participantFields, waiverFields, copiedFields, skippedFields: [] };
}

module.exports = { buildTechnicianPrefill, isTechnicianFieldLabel };
