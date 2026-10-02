// Smartwaiver v4 editable prefills. Only unsigned draft links are created.
// Official contract: https://api.smartwaiver.com/api/docs#prefill
const { randomUUID } = require('node:crypto');
const { sourceTag } = require('../rental-data');
const { buildTechnicianPrefill, isTechnicianFieldLabel } = require('./technician-prefill');

const STANDARD_PERSON = ['firstName', 'middleName', 'lastName', 'gender'];
const STANDARD_WAIVER = [
  'email', 'addressLineOne', 'addressLineTwo', 'addressCountry', 'addressCity',
  'addressState', 'addressZip', 'emergencyContactName', 'emergencyContactFirstName',
  'emergencyContactLastName', 'emergencyContactRelation', 'emergencyContactPhone',
];
const FORBIDDEN = /signature|initials?|consent|agree|acknowledg|waiver|release|liability|accept|authoriz|permission|opt.?in|marketing|newsletter|read and|understand|confirm|attest|promise|certif|assum.*risk|terms|conditions|policy|license number|social security/i;
const PREFILL_TYPES = new Set(['textbox', 'numerictextbox', 'datebox', 'optionlist', 'radiobuttons']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const cleanText = (v, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const normalizeLabel = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function problem(message) { const e = new Error(message); e.statusCode = 400; return e; }

function validDob(value, now = new Date()) {
  const s = cleanText(value);
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return '';
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number(m[1]) < 1900 || isNaN(d) || d.toISOString().slice(0, 10) !== iso || iso > now.toISOString().slice(0, 10)) return '';
  return iso;
}
function ageAt(dob, now = new Date()) {
  const iso = validDob(dob, now);
  if (!iso) return null;
  const [year, month, day] = iso.split('-').map(Number);
  return now.getUTCFullYear() - year - (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day) ? 1 : 0);
}
function basePayload() {
  return { expiration: 3600, lockdownPrefill: false, kiosk: true, anyoneElseHidden: true };
}
// Smartwaiver rejects display-formatted phone strings. Only remove harmless
// formatting; never infer a country code, discard extension digits, or truncate.
function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 100) return '';
  const text = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) return '';
  const compact = text.replace(/[\s().-]/g, '');
  // Do not infer a country-specific minimum or strip national leading zeroes.
  // E.164 allows at most 15 digits; an explicit country code cannot start at 0.
  return /^(?:\+[1-9]\d{0,14}|\d{1,15})$/.test(compact) ? compact : '';
}
function copyPhone(target, key, value, audit, label) {
  const phone = normalizePhone(value);
  if (phone) {
    target[key] = phone;
    audit?.copiedFields.push(label);
  } else if (value != null && (typeof value !== 'string' || value.trim())) {
    audit?.skippedFields.push(`${label} (please enter this phone number in Smartwaiver)`);
  }
}
function personData(source, audit, scope = 'Participant', participant = true) {
  const out = {};
  for (const key of STANDARD_PERSON) {
    if (key === 'gender' && !participant) {
      if (source?.gender != null && (typeof source.gender !== 'string' || source.gender.trim())) audit?.skippedFields.push(`${scope}: Gender (review in Smartwaiver; participant-only prefill field)`);
      continue;
    }
    const v = cleanText(source?.[key]);
    if (v) out[key] = v;
  }
  // The API supports guardian phone/gender only when guardian.participant=true.
  // Never change the guardian's role just to make an optional field acceptable.
  if (participant) copyPhone(out, 'phone', source?.phone, audit, `${scope}: Phone`);
  else if (source?.phone != null && (typeof source.phone !== 'string' || source.phone.trim())) audit?.skippedFields.push(`${scope}: Phone (please enter this phone number in Smartwaiver if applicable; participant-only prefill field)`);
  const dob = validDob(source?.dob || source?.dateOfBirth || source?.date_of_birth);
  if (dob) out.dob = dob;
  return out;
}
function standardWaiverData(source, audit) {
  const out = {};
  for (const key of STANDARD_WAIVER) {
    const v = cleanText(source?.[key]);
    if (v) out[key] = v;
  }
  // The signed-waiver response groups these; the prefill API uses flat keys.
  const address = source?.address || {};
  const addressKeys = { addressLineOne: 'address1', addressLineTwo: 'address2', addressCountry: 'country', addressCity: 'city', addressState: 'state', addressZip: 'zip' };
  for (const [target, key] of Object.entries(addressKeys)) {
    const v = cleanText(address[key]);
    if (!out[target] && v) out[target] = v;
  }
  const emergency = source?.emergencyContact || {};
  const emergencyKeys = { emergencyContactName: 'name', emergencyContactFirstName: 'firstName', emergencyContactLastName: 'lastName', emergencyContactRelation: 'relation', emergencyContactPhone: 'phone' };
  for (const [target, key] of Object.entries(emergencyKeys)) {
    const v = cleanText(emergency[key]);
    if (!out[target] && v) out[target] = v;
  }
  delete out.emergencyContactPhone;
  copyPhone(out, 'emergencyContactPhone', source?.emergencyContactPhone || emergency.phone, audit, 'Waiver: Emergency contact phone');
  return out;
}

function fieldList(template, participant) {
  const fields = participant
    ? template?.customParticipantFields || template?.participantCustomFields || []
    : template?.customFields || template?.customWaiverFields || [];
  return (Array.isArray(fields) ? fields : Object.entries(fields).map(([guid, field]) => ({ guid, ...field })))
    .filter(f => f && f.guid && f.label);
}
function isDataField(field) {
  return PREFILL_TYPES.has(String(field.fieldType || '').toLowerCase()) && !FORBIDDEN.test(String(field.label || '')) && !isTechnicianFieldLabel(field.label);
}
function answerList(fields, definitions) {
  const resolveDefinition = guid => {
    const exact = definitions.filter(f => f.guid === guid);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
    // Signed answers may use the final 13 characters of the template GUID.
    const suffix = String(guid || '');
    const matches = suffix.length === 13 ? definitions.filter(f => String(f.guid).slice(-13) === suffix) : [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const entries = Array.isArray(fields)
    ? fields.map(f => [f.guid || f.id, f])
    : Object.entries(fields || {});
  return entries.map(([guid, answer]) => {
    const def = resolveDefinition(guid);
    const obj = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
    return {
      guid,
      label: obj.displayText || obj.label || def?.label || '',
      value: own(obj, 'value') ? obj.value : answer,
      definition: def,
    };
  });
}
function customData(fields, sourceDefs, targetDefs, audit, scope) {
  const answers = answerList(fields, sourceDefs);
  const out = Object.create(null);
  for (const target of targetDefs) {
    if (!isDataField(target)) continue;
    const label = normalizeLabel(target.label);
    if (targetDefs.filter(f => normalizeLabel(f.label) === label).length !== 1) continue;
    const candidates = answers.filter(a => normalizeLabel(a.label) === label && a.definition && isDataField(a.definition));
    if (candidates.length !== 1) continue; // Never guess among duplicate or similar questions.
    const answer = candidates[0];
    if (FORBIDDEN.test(answer.label)) continue;
    const value = answer.value;
    const targetType = String(target.type || '');
    const sourceType = String(answer.definition.type || '');
    if (targetType && sourceType && targetType !== sourceType) { audit.skippedFields.push(`${scope}: ${target.label} (different field types)`); continue; }
    // Nested objects, files, and boolean consent/check fields never pass through.
    if (typeof value !== 'string' && typeof value !== 'number') {
      if (value != null) audit.skippedFields.push(`${scope}: ${target.label} (please enter this answer in Smartwaiver)`);
      continue;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (value === '') continue;
    out[target.guid] = String(value).slice(0, 4000);
    audit.copiedFields.push(`${scope}: ${target.label}`);
  }
  return out;
}
function mergeFields(primary, fallback) { return { ...(fallback || {}), ...(primary || {}) }; }

function buildIntakePrefill(input) {
  const email = cleanText(input.email, 254);
  const dob = validDob(input.dob);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem('Enter a valid email address.');
  if (!dob) throw problem('Enter a valid date of birth.');
  if (typeof input.minors !== 'boolean') throw problem('Select whether minors will use the equipment.');
  if (ageAt(dob) < 18) throw problem('Please enter the date of birth of the adult signing. A parent or guardian must sign for minors.');
  const audit = { copiedFields: ['Email', input.minors ? 'Guardian date of birth' : 'Date of birth'], skippedFields: [] };
  const signer = personData({ firstName: input.first_name, lastName: input.last_name, phone: input.mobile, dob }, audit, input.minors ? 'Guardian' : 'Participant', !input.minors);
  const payload = { ...basePayload(), email, adult: !input.minors };
  if (input.minors) payload.guardian = { ...signer, participant: false };
  else payload.participants = [signer];
  const id = typeof input.lightspeed_id === 'string' ? input.lightspeed_id.trim() : '';
  if (id && (!/^[a-zA-Z0-9_-]+$/.test(id) || id.length > 61)) throw problem('The customer record identifier could not be preserved. Please ask staff to review it.');
  const tag = id && /^[a-zA-Z0-9_-]+$/.test(id) ? `ls_${id}` : `intake_${randomUUID().replaceAll('-', '')}`;
  // auto_tag permits UUID punctuation, but externalId only permits letters,
  // digits and underscores. Keep the original Lightspeed tag without sending
  // an unsupported externalId or changing the customer linkage.
  if (/^[a-zA-Z0-9_]{1,128}$/.test(tag)) payload.externalId = tag;
  return { payload, tag, ...audit };
}

function buildLiabilityPrefill(waiver, intakeTemplate, liabilityTemplate, participantIndex = 0, technicianReview) {
  const people = Array.isArray(waiver?.participants) ? waiver.participants : [];
  if (!people.length) throw problem('This intake has no participant details.');
  if (!Number.isInteger(participantIndex) || participantIndex < 0 || participantIndex >= people.length) throw problem('The selected intake participant no longer matches. Refresh the list.');
  const audit = { copiedFields: [], skippedFields: [] };
  const sourceParticipant = fieldList(intakeTemplate, true), targetParticipant = fieldList(liabilityTemplate, true);
  const sourceWaiver = fieldList(intakeTemplate, false), targetWaiver = fieldList(liabilityTemplate, false);
  const payload = { ...basePayload(), ...standardWaiverData(waiver, audit) };
  const minorStatus = p => typeof p.isMinor === 'boolean' ? p.isMinor : (ageAt(p.dob || p.dateOfBirth) == null ? null : ageAt(p.dob || p.dateOfBirth) < 18);
  const minors = people.filter(p => minorStatus(p) === true);
  const adults = people.filter(p => minorStatus(p) === false);
  if (people.some(p => minorStatus(p) == null)) throw problem('Participant age or minor status is missing. Review the intake before opening liability.');
  if (waiver.guardian && adults.length) throw problem('The guardian and adult participant records are inconsistent. Review the intake before copying it.');
  if (adults.length > 1) throw problem('Multiple adult identities cannot safely be assigned to one guardian. Please review this intake.');
  const mapPerson = (person, scope, participant = true) => {
    const mapped = personData(person, audit, scope, participant);
    const answers = people.length === 1 && !waiver.guardian ? mergeFields(person.customParticipantFields, waiver.customWaiverFields) : person.customParticipantFields;
    const defs = people.length === 1 && !waiver.guardian ? [...sourceParticipant, ...sourceWaiver] : sourceParticipant;
    const custom = customData(answers, defs, targetParticipant, audit, scope);
    if (Object.keys(custom).length) mapped.customFields = custom;
    return mapped;
  };
  payload.adult = !minors.length;
  if (minors.length) {
    const guardian = waiver.guardian || adults[0];
    if (!guardian) throw problem('Guardian information is missing from this minor intake.');
    payload.guardian = { ...mapPerson(guardian, 'Guardian', !waiver.guardian), participant: !waiver.guardian };
    const relationship = cleanText(guardian.relationship);
    if (relationship) payload.guardian.relationship = relationship;
    payload.participants = minors.map((p, i) => mapPerson(p, `Minor ${i + 1}`));
  } else {
    if (waiver.guardian) throw problem('Guardian and participant roles are inconsistent. Please review this intake.');
    payload.participants = people.map((p, i) => mapPerson(p, `Participant ${i + 1}`));
  }
  const waiverAnswers = people.length === 1 && !waiver.guardian ? mergeFields(waiver.customWaiverFields, people[0].customParticipantFields) : waiver.customWaiverFields;
  const waiverDefs = people.length === 1 && !waiver.guardian ? [...sourceWaiver, ...sourceParticipant] : sourceWaiver;
  const customWaiver = customData(waiverAnswers, waiverDefs, targetWaiver, audit, 'Waiver');
  if (Object.keys(customWaiver).length) payload.customWaiverFields = customWaiver;
  if (technicianReview !== undefined) {
    const technician = buildTechnicianPrefill(waiver, liabilityTemplate, participantIndex, technicianReview);
    const selected = people[participantIndex];
    const targetPerson = minors.length
      ? minors.includes(selected) ? payload.participants[minors.indexOf(selected)] : payload.guardian
      : payload.participants[participantIndex];
    if (!targetPerson || (targetPerson === payload.guardian && !payload.guardian.participant)) throw problem('The selected technician participant could not be verified in the final waiver.');
    if (Object.keys(technician.participantFields).length) targetPerson.customFields = { ...targetPerson.customFields, ...technician.participantFields };
    if (Object.keys(technician.waiverFields).length) payload.customWaiverFields = { ...payload.customWaiverFields, ...technician.waiverFields };
    audit.copiedFields.push(...technician.copiedFields);
    audit.skippedFields.push(...technician.skippedFields);
  }
  let tag;
  try { tag = sourceTag(waiver.waiverId, participantIndex); } catch { throw problem('The selected intake cannot be linked safely. Please ask staff to review it.'); }
  if (/^[a-zA-Z0-9_]+$/.test(tag)) payload.externalId = tag;
  return { payload, tag, ...audit };
}

function safePrefillUrl(value, tag, uuid) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Smartwaiver did not return a valid prefill link.'); }
  if (url.protocol !== 'https:' || !['waiver.smartwaiver.com', 'www.smartwaiver.com'].includes(url.hostname) || !/^\/p\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) || url.username || url.password) throw new Error('Smartwaiver returned an unexpected prefill link.');
  if (uuid !== undefined && (typeof uuid !== 'string' || !uuid || url.pathname.replace(/^\/p\//, '').replace(/\/$/, '') !== uuid)) throw new Error('Smartwaiver prefill ID does not match its link.');
  if (url.search || url.hash) throw new Error('Smartwaiver returned unexpected prefill parameters.');
  // An explicit unique auto-tag prevents a previous kiosk customer’s tag persisting.
  url.searchParams.set('auto_tag', tag);
  url.searchParams.set('auto_anyoneelseneedtosign', '0');
  return url.toString();
}
module.exports = { buildIntakePrefill, buildLiabilityPrefill, safePrefillUrl, validDob, fieldList, customData, standardWaiverData, normalizePhone };
