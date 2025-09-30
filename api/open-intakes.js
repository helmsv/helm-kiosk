// api/open-intakes.js
// Returns { rows: [...] } = one row per participant from ALL Intake waivers,
// excluding those that already have a matching Liability (by tag/email).
// WARNING: This can be heavy for large histories. Consider narrowing with ?since=YYYY-MM-DD

export default async function handler(req, res) {
  try {
    const SW_API_KEY = process.env.SW_API_KEY;
    const INTAKE_WAIVER_ID = process.env.INTAKE_WAIVER_ID;
    const LIABILITY_WAIVER_ID = process.env.LIABILITY_WAIVER_ID;
    const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

    const missing = [];
    if (!SW_API_KEY) missing.push('SW_API_KEY');
    if (!INTAKE_WAIVER_ID) missing.push('INTAKE_WAIVER_ID');
    if (!LIABILITY_WAIVER_ID) missing.push('LIABILITY_WAIVER_ID');
    if (missing.length) {
      return res.status(500).json({ rows: [], error: `Missing SW env (${missing.join(' / ')})` });
    }

    // Optional query: since=YYYY-MM-DD to bound the time
    const since = (req.query.since || '').toString().trim();
    let fromDts = '';
    if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
      fromDts = `${since} 00:00:00`;
    }

    // Pull intakes and liabilities (paged in chunks) — naive loop up to 5000
    const intakeList = await listAll({ SW_BASE, SW_API_KEY, templateId: INTAKE_WAIVER_ID, fromDts, max: 5000 });
    const liabList   = await listAll({ SW_BASE, SW_API_KEY, templateId: LIABILITY_WAIVER_ID, fromDts, max: 5000 });

    const liabTagSet = new Set();
    const liabEmailSet = new Set();
    for (const w of liabList) {
      const tagArr = Array.isArray(w.tags) ? w.tags : [];
      for (const t of tagArr) if (typeof t === 'string' && t.startsWith('ls_')) liabTagSet.add(t.toLowerCase());
      const topEmail = (w.email || '').toLowerCase();
      if (topEmail) liabEmailSet.add(topEmail);
      if (Array.isArray(w.participants)) {
        for (const p of w.participants) {
          const pe = (p.email || '').toLowerCase();
          if (pe) liabEmailSet.add(pe);
        }
      }
    }

    const rows = [];
    for (const w of intakeList) {
      const tagArr = Array.isArray(w.tags) ? w.tags.map(s => String(s).toLowerCase()) : [];
      const lsTag = tagArr.find(t => t.startsWith('ls_'));
      const topEmail = (w.email || '').toLowerCase();
      const participants = Array.isArray(w.participants) ? w.participants : [];

      const skip =
        (lsTag && liabTagSet.has(lsTag)) ||
        (topEmail && liabEmailSet.has(topEmail));
      if (skip) continue;

      participants.forEach((p, idx) => {
        const email = (p.email || w.email || '').toLowerCase();
        if (email && liabEmailSet.has(email)) return;

        rows.push({
          waiver_id: w.waiverId || w.waiver_id || '',
          signed_on: w.createdOn || w.signedOn || w.signed_on || '',
          intake_pdf_url: w.pdf || w.intake_pdf_url || '',
          lightspeed_id: extractLsId(tagArr),
          email,
          first_name: p.firstName || p.first_name || w.firstName || '',
          last_name:  p.lastName  || p.last_name  || w.lastName  || '',
          age: numOrNull(p.age ?? w.age),
          weight_lb: numOrNull(extractWeightLb(p)),
          height_in: numOrNull(extractHeightInches(p)),
          skier_type: (extractSkierType(p) || '').toUpperCase(),
          participant_index: numOrZero(p.participant_index ?? idx)
        });
      });
    }

    return res.status(200).json({ rows });
  } catch (err) {
    console.error('open-intakes error:', err);
    return res.status(200).json({ rows: [], error: 'open-intakes failed' });
  }
}

/* -------- shared helpers (same as today-intakes) -------- */

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

async function listAll({ SW_BASE, SW_API_KEY, templateId, fromDts = '', max = 5000 }) {
  const acc = [];
  let offset = 0;
  const page = 200;

  while (acc.length < max) {
    const url = new URL(`${SW_BASE}/waivers`);
    if (templateId) url.searchParams.set('templateId', templateId);
    if (fromDts)    url.searchParams.set('fromDts', fromDts);
    url.searchParams.set('limit', String(page));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('sort', 'createdOn:desc');

    const r = await fetch(url.toString(), { headers: { 'sw-api-key': SW_API_KEY } });
    if (!r.ok) break;
    const j = await r.json();
    const waivers = Array.isArray(j.waivers) ? j.waivers : (Array.isArray(j) ? j : []);
    if (!waivers.length) break;

    acc.push(...waivers);
    offset += waivers.length;
    if (waivers.length < page) break;
  }
  return acc;
}

function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function numOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function extractLsId(tags) {
  if (!Array.isArray(tags)) return '';
  const t = tags.find(s => String(s).toLowerCase().startsWith('ls_'));
  return t ? String(t).slice(3) : '';
}
function extractWeightLb(p) {
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
    const v = String(entry.value || '').toUpperCase();
    if (['I','II','III'].includes(v)) return v;
  }
  return '';
}
