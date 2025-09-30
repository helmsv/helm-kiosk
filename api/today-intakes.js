// api/today-intakes.js
// Returns { rows: [...] } = one row per participant from Intake waivers in last 24h
// excluding those that already have a matching Liability (by tag ls_<id> or email).

export default async function handler(req, res) {
  try {
    // ---- ENV ----
    const SW_API_KEY = process.env.SW_API_KEY;
    const INTAKE_WAIVER_ID = process.env.INTAKE_WAIVER_ID;       // <-- you updated these
    const LIABILITY_WAIVER_ID = process.env.LIABILITY_WAIVER_ID;
    const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

    const missing = [];
    if (!SW_API_KEY) missing.push('SW_API_KEY');
    if (!INTAKE_WAIVER_ID) missing.push('INTAKE_WAIVER_ID');
    if (!LIABILITY_WAIVER_ID) missing.push('LIABILITY_WAIVER_ID');
    if (missing.length) {
      return res.status(500).json({ rows: [], error: `Missing SW env (${missing.join(' / ')})` });
    }

    // ---- TIME WINDOW (last 24h) ----
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 3600 * 1000);
    const fromStr = fmtDTS(from); // "YYYY-MM-DD HH:mm:ss"
    const toStr   = fmtDTS(now);

    // ---- FETCH intake waivers (window) ----
    const intakeList = await listWaivers({
      SW_BASE, SW_API_KEY,
      templateId: INTAKE_WAIVER_ID,
      fromDts: fromStr, toDts: toStr,
      limit: 200
    });

    // ---- FETCH liability waivers (window) to filter out matches ----
    const liabList = await listWaivers({
      SW_BASE, SW_API_KEY,
      templateId: LIABILITY_WAIVER_ID,
      fromDts: fromStr, toDts: toStr,
      limit: 200
    });

    // Build quick lookup to filter (by tag or email)
    const liabTagSet = new Set();     // holds "ls_<id>" if present on liability
    const liabEmailSet = new Set();

    for (const w of liabList) {
      const tagArr = Array.isArray(w.tags) ? w.tags : [];
      for (const t of tagArr) {
        if (typeof t === 'string' && t.startsWith('ls_')) liabTagSet.add(t.toLowerCase());
      }
      const em = (w.email || '').toLowerCase();
      if (em) liabEmailSet.add(em);
      // include participant emails if present
      if (Array.isArray(w.participants)) {
        for (const p of w.participants) {
          const pe = (p.email || '').toLowerCase();
          if (pe) liabEmailSet.add(pe);
        }
      }
    }

    // ---- Expand intake waivers into participant rows ----
    const rows = [];
    for (const w of intakeList) {
      const tagArr = Array.isArray(w.tags) ? w.tags.map(s => String(s).toLowerCase()) : [];
      const lsTag = tagArr.find(t => t.startsWith('ls_'));
      const topEmail = (w.email || '').toLowerCase();
      const participants = Array.isArray(w.participants) ? w.participants : [];

      // If this intake can be filtered out by tag/email (already has a liability), skip all its participants
      const shouldSkipIntake =
        (lsTag && liabTagSet.has(lsTag)) ||
        (topEmail && liabEmailSet.has(topEmail));

      if (shouldSkipIntake) continue;

      // Otherwise add one row per participant
      participants.forEach((p, idx) => {
        const email = (p.email || w.email || '').toLowerCase();
        // participant-level filter by email
        if (email && liabEmailSet.has(email)) return;

        const r = {
          waiver_id: w.waiverId || w.waiver_id || '',
          signed_on: w.createdOn || w.signedOn || w.signed_on || '',
          intake_pdf_url: w.pdf || w.intake_pdf_url || '',
          lightspeed_id: extractLsId(tagArr),
          email: email || '',
          first_name: p.firstName || p.first_name || w.firstName || '',
          last_name:  p.lastName  || p.last_name  || w.lastName  || '',
          age: numOrNull(p.age ?? w.age),
          weight_lb: numOrNull(extractWeightLb(p)),
          height_in: numOrNull(extractHeightInches(p)),
          skier_type: (extractSkierType(p) || '').toUpperCase(),
          participant_index: numOrZero(p.participant_index ?? idx)
        };
        rows.push(r);
      });
    }

    return res.status(200).json({ rows });
  } catch (err) {
    console.error('today-intakes error:', err);
    return res.status(200).json({ rows: [], error: 'today-intakes failed' });
  }
}

/* ---------------- helpers ---------------- */

function fmtDTS(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const MM = pad(d.getMinutes());
  const SS = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

async function listWaivers({ SW_BASE, SW_API_KEY, templateId, fromDts, toDts, limit = 200 }) {
  // Uses Smartwaiver v4 "List Signed Waivers". If your account requires paging via cursor,
  // you can extend this to loop. For most shops, a single page for last 24h is fine.
  const url = new URL(`${SW_BASE}/waivers`);
  if (templateId) url.searchParams.set('templateId', templateId);
  if (fromDts)    url.searchParams.set('fromDts', fromDts);
  if (toDts)      url.searchParams.set('toDts', toDts);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('sort', 'createdOn:desc');

  const r = await fetch(url.toString(), {
    headers: { 'sw-api-key': SW_API_KEY }
  });
  if (!r.ok) {
    console.warn('listWaivers status', r.status);
    return [];
  }
  const j = await r.json();
  // Expect j.waivers = [] and each waiver may include `participants`, `tags`, etc.
  const waivers = Array.isArray(j.waivers) ? j.waivers : (Array.isArray(j) ? j : []);
  return waivers;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function extractLsId(tags) {
  if (!Array.isArray(tags)) return '';
  const t = tags.find(s => String(s).toLowerCase().startsWith('ls_'));
  return t ? String(t).slice(3) : '';
}
function extractWeightLb(p) {
  // Smartwaiver often stores customParticipantFields.*.value with displayText like "Weight: ... lbs."
  // If your `intake-details` already maps weight_lb, prefer that; otherwise best-effort:
  if (p.weight_lb != null) return p.weight_lb;
  const cpf = p.customParticipantFields || {};
  const vals = Object.values(cpf);
  for (const entry of vals) {
    const label = (entry.displayText || '').toLowerCase();
    if (label.includes('weight')) {
      const n = Number(String(entry.value || '').toString().replace(/[^\d.]/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
function extractHeightInches(p) {
  if (p.height_in != null) return p.height_in;
  const cpf = p.customParticipantFields || {};
  const vals = Object.values(cpf);
  let feet = null, inches = 0;
  for (const entry of vals) {
    const label = (entry.displayText || '').toLowerCase();
    if (label.includes('height (feet')) {
      const n = Number(String(entry.value || '').toString().replace(/[^\d.]/g, ''));
      if (Number.isFinite(n)) feet = n;
    }
    if (label.includes('height (inches')) {
      const n = Number(String(entry.value || '').toString().replace(/[^\d.]/g, ''));
      if (Number.isFinite(n)) inches = n;
    }
  }
  if (feet != null) return feet * 12 + (inches || 0);
  return null;
}
function extractSkierType(p) {
  if (p.skier_type) return p.skier_type;
  const cpf = p.customParticipantFields || {};
  const vals = Object.values(cpf);
  for (const entry of vals) {
    const label = (entry.displayText || '').toLowerCase();
    if (label.includes('skier type') || label === 'ii' || label === 'i' || label === 'iii') {
      const v = String(entry.value || '').toUpperCase();
      if (['I', 'II', 'III'].includes(v)) return v;
    }
  }
  return '';
}
