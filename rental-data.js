// Shared by the technician UI and offline tests. Never coerce missing data to zero.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RentalData = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function finiteNumber(value) {
    if (value == null || typeof value === 'boolean' || (typeof value === 'string' && value.trim() === '')) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function pickParticipant(details, index, waiverId) {
    if (!details || details.waiver_id !== waiverId) throw new Error('The intake does not match the selected row.');
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid participant selection.');
    const matches = (Array.isArray(details.participants) ? details.participants : []).filter(p => p.participant_index === index);
    if (matches.length !== 1) throw new Error('The selected participant is missing. Please refresh the list.');
    const p = matches[0];
    return { ...p, email: p.email || details.email || '', age: finiteNumber(p.age), weight_lb: finiteNumber(p.weight_lb), height_in: finiteNumber(p.height_in) };
  }
  function missingDinInputs({ weight_lb, height_in, age_years, skierType, bsl_mm }) {
    const missing = [];
    if (!(finiteNumber(weight_lb) > 0)) missing.push('weight');
    if (!(finiteNumber(height_in) > 0)) missing.push('height');
    const age = finiteNumber(age_years);
    if (age == null || !Number.isInteger(age) || age < 0 || age >= 130) missing.push('age');
    if (!['I', 'II', 'III'].includes(skierType)) missing.push('skier type');
    const bsl = finiteNumber(bsl_mm);
    if (bsl == null || !Number.isInteger(bsl) || bsl < 200 || bsl > 420) missing.push('measured boot sole length (200–420 mm)');
    return missing;
  }
  function sourceTag(waiverId, participantIndex) {
    const tag = `intake_${waiverId}_${participantIndex}`;
    if (typeof waiverId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(waiverId) || !Number.isInteger(participantIndex) || participantIndex < 0 || tag.length > 64) throw new Error('Invalid source intake selection.');
    return tag;
  }
  const normalized = value => String(value || '').normalize('NFC').trim().toLowerCase();
  function pendingRows(intakes, liabilities, allowLegacy = false) {
    const samePerson = (row, waiver) => Boolean(normalized(row.first_name) && normalized(row.last_name)) && normalized(row.first_name) === normalized(waiver.firstName) && normalized(row.last_name) === normalized(waiver.lastName);
    const timely = (row, waiver) => Number.isFinite(Date.parse(row.signed_on)) && Number.isFinite(Date.parse(waiver.createdOn)) && Date.parse(waiver.createdOn) >= Date.parse(row.signed_on);
    const legacy = (row, waiver) => samePerson(row, waiver) && timely(row, waiver) && ((normalized(row.email) && normalized(row.email) === normalized(waiver.email)) || (row.lightspeed_id && waiver.autoTag === `ls_${row.lightspeed_id}`));
    return intakes.filter(row => {
      let tag; try { tag = sourceTag(row.waiver_id, row.participant_index); } catch { return true; }
      if (liabilities.some(waiver => (waiver.autoTag === tag || waiver.externalId === tag) && timely(row, waiver))) return false;
      if (!allowLegacy) return true;
      const matches = liabilities.filter(waiver => legacy(row, waiver));
      if (matches.length !== 1) return true;
      return intakes.filter(candidate => legacy(candidate, matches[0])).length !== 1;
    });
  }
  return { finiteNumber, pickParticipant, missingDinInputs, sourceTag, pendingRows };
});
