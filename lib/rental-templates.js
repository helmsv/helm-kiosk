// Verified rental agreements. The original remains readable for outstanding
// rentals and rollback; only the configured template receives new drafts.
const ORIGINAL_TEMPLATE_ID = 'a2njtmnzxs7icea9mdxff6';
const TEXT_TEMPLATE_ID = 'rrqn8ray3vbl19h2reyxrf';
const RENTAL_TEMPLATE_IDS = Object.freeze([ORIGINAL_TEMPLATE_ID, TEXT_TEMPLATE_ID]);
function isRentalTemplate(id) { return RENTAL_TEMPLATE_IDS.includes(id); }
function liabilityTemplateId(env = process.env) {
  return env.LIABILITY_WAIVER_ID || env.LIABILITY_TEMPLATE_ID || env.SW_TEMPLATE_LIABILITY || '';
}
function liabilityHistoryTemplateIds(id = liabilityTemplateId()) {
  return isRentalTemplate(id) ? [id, ...RENTAL_TEMPLATE_IDS.filter(other => other !== id)] : id ? [id] : [];
}
module.exports = { ORIGINAL_TEMPLATE_ID, TEXT_TEMPLATE_ID, isRentalTemplate, liabilityTemplateId, liabilityHistoryTemplateIds };
