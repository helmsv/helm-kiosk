// api/open-intakes.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;

function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  return t.replace(/[^\x20-\x7E]+/g, '');
}

async function swGet(path, key) {
  const url = `${API_BASE}${path}`;
  const baseHeaders = { Accept: 'application/json' };
  let r = await fetch(url, { headers: { ...baseHeaders, 'sw-api-key': key }, cache: 'no-store' });
  if (r.status === 401) {
    r = await fetch(url, { headers: { ...baseHeaders, 'x-api-key': key }, cache: 'no-store' });
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${path} ${r.status} ${text.slice(0, 500)}`);
  }
  return r.json();
}

function mapWaiverToRow(w) {
  return {
    waiver_id: w.waiverId || w.id || '',
    signed_on: w.createdOn || w.created || '',
    intake_pdf_url: w.pdf || '',
    lightspeed_id: (w.autoTag || '').startsWith('ls_') ? (w.autoTag || '').slice(3) : '',
    email: w.email || '',
    first_name: w.firstName || '',
    last_name: w.lastName || '',
    participant_index: 0,
    age: null,
    weight_lb: null,
    height_in: null,
    skier_type: ''
  };
}

export default async function handler(req, res) {
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const intakeId = process.env.INTAKE_WAIVER_ID;

    if (!key || !intakeId) {
      return res.status(200).json({
        rows: [],
        error: 'Missing Smartwaiver env (SW_API_KEY / INTAKE_WAIVER_ID)',
      });
    }

    // "All time" recent window — no date filters so your list actually fills.
    // You can later add pagination; for now grab a generous page.
    const qs = new URLSearchParams({
      templateId: intakeId,
      verified: 'true',
      limit: '500'
    });

    const payload = await swGet(`/waivers?${qs.toString()}`, key);
    const waivers = Array.isArray(payload?.waivers) ? payload.waivers : [];
    const rows = waivers.map(mapWaiverToRow);

    res.status(200).json({ rows, count: rows.length });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
}
