// api/open-intakes.js
//
// All-time Intake participants that *might* still need Liability.
// (This endpoint does not attempt to subtract those with a matching Liability;
// the tech page removes lines via SSE when a Liability is signed.)
//
// Query: ?since=all (default). In the future you can add cursors/paging.
//
// REQUIRES env:
//   SW_API_KEY
//   INTAKE_WAIVER_ID

const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

function err(res, code, msg) {
  return res.status(code).json({ rows: [], error: msg });
}

async function swFetch(path, init = {}) {
  const key = process.env.SW_API_KEY;
  if (!key) throw new Error('Missing SW_API_KEY');
  const r = await fetch(`${SW_BASE}${path}`, {
    ...init,
    headers: {
      // Send both header names; API Gateway cares about x-api-key
      'x-api-key': key,
      'X-SW-API-KEY': key,
      'Accept': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`SW ${path} ${r.status} ${text}`);
  }
  return r.json();
}

function numOrNull(v) {
  if (v == null) return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function extractHeightIn(p) {
  const cf = p?.customParticipantFields || {};
  const ft = numOrNull(cf?.HWiSfrUi2BNDf?.value ?? cf?.height_feet?.value);
  const inch = numOrNull(cf?.dnmPAXmd8wprP?.value ?? cf?.height_inches?.value);
  const totalFromFeet = (ft != null || inch != null) ? ((ft || 0) * 12 + (inch || 0)) : null;
  const totalInches = numOrNull(cf?.height_total_in?.value);
  const cm = numOrNull(cf?.height_cm?.value);
  if (totalInches != null) return totalInches;
  if (totalFromFeet != null) return totalFromFeet;
  if (cm != null) return cm / 2.54;
  return null;
}

function extractWeightLb(p) {
  const cf = p?.customParticipantFields || {};
  return numOrNull(cf?.ktxbHqRFfWLTe?.value ?? cf?.weight_lb?.value ?? p?.weight);
}
function extractSkierType(p) {
  const cf = p?.customParticipantFields || {};
  const raw = (cf?.AKWgkHaSYKKsi?.value ?? cf?.skier_type?.value ?? p?.skierType ?? '').toString().toUpperCase();
  if (raw.includes('III')) return 'III';
  if (raw.includes('II'))  return 'II';
  if (raw.includes('I'))   return 'I';
  return '';
}
function extractAge(p) {
  const dob = p?.dob;
  if (!dob) return null;
  const dt = new Date(dob);
  if (isNaN(dt.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dt.getUTCFullYear();
  const m = now.getUTCMonth() - dt.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dt.getUTCDate())) age--;
  return age;
}

async function expandWaiver(waiverId) {
  const data = await swFetch(`/waivers/${encodeURIComponent(waiverId)}`);
  const w = data.waiver || data;
  const participants = Array.isArray(w?.participants) ? w.participants : [];
  const tags = Array.isArray(w?.tags) ? w.tags : [];
  const email = w?.email || '';
  const pdf = w?.pdf || w?.waiverPDF?.url || '';
  const autoTag = (w?.autoTag || '').toString();
  const signedOn = w?.createdOn || w?.signedOn || w?.verifiedOn || w?.date || new Date().toISOString();
  const lsTag = (tags.find(t => /^ls_/.test(t)) || autoTag);
  const lightspeed_id = lsTag && lsTag.startsWith('ls_') ? lsTag.slice(3) : '';

  return participants.map((p, idx) => ({
    waiver_id: w?.waiverId || waiverId,
    signed_on: signedOn,
    intake_pdf_url: pdf || '',
    lightspeed_id,
    email: p?.email || email || '',
    first_name: p?.firstName || p?.first_name || '',
    last_name:  p?.lastName || p?.last_name || '',
    age: extractAge(p),
    weight_lb: extractWeightLb(p),
    height_in: extractHeightIn(p),
    skier_type: extractSkierType(p),
    participant_index: Number.isFinite(p?.participant_index) ? p.participant_index : idx
  }));
}

module.exports = async (req, res) => {
  const intakeTemplateId = process.env.INTAKE_WAIVER_ID || process.env.INTAKE_TEMPLATE_ID;
  if (!process.env.SW_API_KEY || !intakeTemplateId) {
    return err(res, 200, 'Missing SW env (SW_API_KEY / INTAKE_WAIVER_ID)');
  }

  try {
    // Start very far back. You can add paging later if volume is high.
    const from = '1970-01-01T00:00:00Z';
    const list = await swFetch(`/waivers?templateId=${encodeURIComponent(intakeTemplateId)}&fromDts=${encodeURIComponent(from)}&verified=true`);
    const items = Array.isArray(list.waivers) ? list.waivers : [];

    const rows = [];
    for (const w of items) {
      const wid = w.waiverId || w.id || w.waiver_id;
      if (!wid) continue;
      const expanded = await expandWaiver(wid);
      rows.push(...expanded);
    }

    return res.status(200).json({ rows });
  } catch (e) {
    console.error('open-intakes error:', e);
    return err(res, 200, String(e?.message || e));
  }
};
