// api/open-intakes.js
const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

function cleanKey(v) {
  if (!v) return '';
  const t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  return m ? m[1] : t;
}

async function swFetch(path, init = {}) {
  const key = cleanKey(process.env.SW_API_KEY);
  if (!key) throw new Error('Missing SW_API_KEY');
  const r = await fetch(`${SW_BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': key,
      'X-SW-API-KEY': key,
      'Accept': 'application/json',
      ...(init.headers || {})
    },
    cache: 'no-store'
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`SW ${path} ${r.status} ${text}`);
  }
  return r.json();
}

function mapWaiverToRows(item) {
  const w = item || {};
  return [{
    waiver_id: w.waiverId || w.id || '',
    signed_on: w.createdOn || w.created || w.timestamp || '',
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
  }];
}

module.exports = async (req, res) => {
  try {
    const intakeId = process.env.INTAKE_WAIVER_ID;
    if (!intakeId || !process.env.SW_API_KEY) {
      return res.status(200).json({ rows: [], error: 'Missing env' });
    }

    // Basic page size; you can make this larger or add paging
    const limit = Number(req.query.limit || '200');
    const qs = new URLSearchParams({
      templateId: intakeId,
      verified: 'true',
      limit: String(Math.max(1, Math.min(limit, 500)))
    });

    const list = await swFetch(`/waivers?${qs.toString()}`);
    const items = Array.isArray(list.items) ? list.items : (Array.isArray(list) ? list : []);
    const rows = items.flatMap(mapWaiverToRows);

    res.status(200).json({ rows, count: rows.length });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
};
