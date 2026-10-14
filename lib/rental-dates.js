// Original rental agreement metadata verified against publication 1616022.
// Dates belong to the rental, not to a participant or an earlier signed intake.
const TEMPLATE_ID = 'a2njtmnzxs7icea9mdxff6';
const TIME_ZONE = 'America/Los_Angeles';
const RETURN_DATE = '2027-03-16';
const DATE_FIELDS = Object.freeze([
  Object.freeze({ guid: 'n2PD2g3Zs5A63yF74Wh75s', label: 'Date Out', key: 'dateOut' }),
  Object.freeze({ guid: 'jv9eoZqdVosVmeXyh2p4yZ', label: 'Date Returning', key: 'dateReturning' }),
]);
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function rentalDates(now = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  return { dateOut: `${parts.year}-${parts.month}-${parts.day}`, dateReturning: RETURN_DATE };
}

function isRentalDateField(template, field) {
  return template?.templateId === TEMPLATE_ID && DATE_FIELDS.some(({ guid, label }) => field.guid === guid || field.label === label);
}

function applyRentalDates(payload, template, waiverFields, participantFields, audit, now) {
  if (template?.templateId !== TEMPLATE_ID) return;
  const dates = rentalDates(now);
  for (const { guid, label, key } of DATE_FIELDS) {
    const matches = waiverFields.filter(field => field.guid === guid);
    const field = matches[0];
    // Never send a date to a moved, duplicate or repurposed destination.
    if (matches.length !== 1 || participantFields.some(field => field.guid === guid) ||
        field.label !== label || field.fieldType !== 'datebox' || field.type !== 'date') {
      audit.skippedFields.push(`${label} (complete manually; rental date field could not be verified)`);
      audit.manualFields.push({ label, value: dates[key] });
      continue;
    }
    payload.customWaiverFields = { ...payload.customWaiverFields, [guid]: dates[key] };
    audit.copiedFields.push(`Waiver: ${label}`);
  }
}

module.exports = { TEMPLATE_ID, TIME_ZONE, RETURN_DATE, DATE_FIELDS, rentalDates, isRentalDateField, applyRentalDates };
