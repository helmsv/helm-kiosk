// api/today-intakes.js
//
// Lists signed waivers for the Intake template and returns one row per participant
// for "today" (UTC day) by default. Uses Smartwaiver v4 API directly.
//
// REQUIRES env:
//   SW_API_KEY             (Smartwaiver API key)
//   INTAKE_WAIVER_ID       (your Intake templateId)
//   LIABILITY_WAIVER_ID    (only echoed back; not required for this list)

const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

function err(res, code, msg) {
  return res.status(code).json({ rows: [], error: msg });
}

function getUtcDayRange() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const from = new Date(Date.UTC(y, m, d, 0, 0, 0));
  const to   = new Date(Date.UTC(y, m, d, 23, 59, 59));
  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    from, to
  };
}

// Extract a numeric value from Smartwaiver custom fields when the value is mixed with text
function numOrNull(v) {
  if (v == null) return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Attempt to pull height from either:
// - total inches, or
// - feet + inches fields (if present), or
// - centimeters (we convert to inches)
function extractHeightIn(participant) {
  const cf = participant?.customParticipantFields || {};
  // Common keys used earlier in your account (keep fallbacks generic):
  const feet = numOrNull(cf?.HWiSfrUi2BNDf?.value ?? cf?.height_feet?.value);
  const inch = numOrNull(cf?.dnmPAXmd8wprP?.value ?? cf?.height_inches?.value);
  const totalInFromFeet = (feet != null || inch != null)
    ? ((feet || 0) * 12 + (inch || 0))
    : null;

  const totalInches = numOrNull(cf?.height_total_in?.value);
  const cm = numOrNull(cf?.height_cm?.value);

  if (totalInches != null) return totalInches;
  if (totalInFromFeet != null) return totalInFromFeet;
  if (cm != null) return cm / 2.54;
  return null;
}

// Weight from common fields; your earlier key was ktxbHqRFfWLTe
function extractWeightLb(participant) {
  const cf = participant?.customParticipantFields || {};
  const lb = numOrNull(cf?.ktxbHqRFfWLTe?.value ?? cf?.weight_lb?.value ?? participant?.weight);
  return lb;
}

// Skier Type (I/II/III) — you had “AKWgkHaSYKKsi” earlier
function extractSkierType(participant) {
  const cf = participant?.customParticipantFields || {};
  const raw = (cf?.AKWgkHaSYKKsi?.value ?? cf?.skier_type?.value ?? participant?.skierType ?? '').toString().toUpperCase();
  if (raw.includes('III')) return 'III';
  if (raw.includes('II'))  return 'II';
  if (raw.includes('I'))   return 'I';
  return '';
}

// Age from DOB
function extractAge(participant) {
  const dob = participant?.dob;
  if (!dob) return null;
  const dt = new Date(dob);
  if (isNaN(dt.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dt.getUTCFullYear();
  const m = now.getUTCMonth() - dt.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dt.getUTCDate())) age--;
  return age;
}

async function swFetch(path, init = {}) {
  const key = process.env.SW_API_KEY;
  if (!key) throw new Error('Missing SW_API_KEY');
  const r = await fetch(`${SW_BASE}${path}`, {
    ...init,
    headers: {
      'X-SW-API-KEY': key,            // Smartwaiver v4 header
      'Accept': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!r.ok) {
    const text = await r.text().catch(()=> '');
    throw new Error(`SW ${path} ${r.status} ${text}`);
  }
  return r.json();
}

// Expand a single waiver to retrieve participants + tags + pdf link
async function expandWaiver(waiverId) {
  const data = await swFetch(`/waivers/${encodeURIComponent(waiverId)}`);
  // v4 typically returns { waiver: {...} }
  const w = data.waiver || data;
  const participants = Array.isArray(w?.participants) ? w.participants : [];
  const tags = Array.isArray(w?.tags) ? w.tags : [];
  const email = w?.email || '';
  const pdf = w?.pdf || w?.waiverPDF?.url || '';
  const autoTag = (w?.autoTag || '').toString();
  const signedOn = w?.createdOn || w?.signedOn || w?.verifiedOn || w?.date || new Date().toISOString();

  // Attempt to pull out the Lightspeed ID from tags like "ls_<uuid>"
  const lsTag = (tags.find(t => /^ls_/.test(t)) || autoTag);
  const lightspeed_id = lsTag && lsTag.startsWith('ls_') ? lsTag.slice(3) : '';

  // Build per-participant rows
  const rows = participants.map((p, idx) => {
    const height_in = extractHeightIn(p);
    const weight_lb = extractWeightLb(p);
    const skier_type = extractSkierType(p);
    const age = extractAge(p);

    return {
      waiver_id: w?.waiverId || waiverId,
      signed_on: signedOn,
      intake_pdf_url: pdf || '',
      lightspeed_id,
      email: p?.email || email || '',
      first_name: p?.firstName || p?.first_name || '',
      last_name:  p?.lastName || p?.last_name || '',
      age: (age != null ? age : null),
      weight_lb: (weight_lb != null ? weight_lb : null),
      height_in: (height_in != null ? height_in : null),
      skier_type,
      participant_index: Number.isFinite(p?.participant_index) ? p.participant_index : idx
    };
  });

  return rows;
}

module.exports = async (req, res) => {
  // Validate env
  const intakeTemplateId = process.env.INTAKE_WAIVER_ID || process.env.INTAKE_TEMPLATE_ID;
  const swKeyPresent = !!process.env.SW_API_KEY;
  if (!swKeyPresent || !intakeTemplateId) {
    return err(res, 200, 'Missing SW env (SW_API_KEY / INTAKE_WAIVER_ID)');
  }

  try {
    const { fromIso, toIso } = getUtcDayRange();

    // List waivers for **today** for this template
    // Smartwaiver v4 supports ISO8601 "fromDts" and "toDts" (documented as `fromDts`/`toDts`)
    const list = await swFetch(`/waivers?templateId=${encodeURIComponent(intakeTemplateId)}&fromDts=${encodeURIComponent(fromIso)}&toDts=${encodeURIComponent(toIso)}&verified=true`);

    // v4 usually returns { waivers: [ { waiverId, ... } ], count, ... }
    const items = Array.isArray(list.waivers) ? list.waivers : [];

    // Expand each waiver -> per-participant rows
    const allRows = [];
    for (const w of items) {
      const wid = w.waiverId || w.id || w.waiver_id;
      if (!wid) continue;
      const rows = await expandWaiver(wid);
      allRows.push(...rows);
    }

    return res.status(200).json({ rows: allRows });
  } catch (e) {
    console.error('today-intakes error:', e);
    return err(res, 200, String(e?.message || e));
  }
};
