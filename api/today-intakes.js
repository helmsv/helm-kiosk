// api/today-intakes.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;

function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  return t.replace(/[^\x20-\x7E]+/g, '');
}

function utcRangeToday() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const from = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
  const to   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
  return { fromDts: from.toISOString(), toDts: to.toISOString() };
}

async function swGet(path, key) {
  const url = `${API_BASE}${path}`;
  const headers = { Accept: 'application/json', 'sw-api-key': key };
  let r = await fetch(url, { headers, cache: 'no-store' });
  if (r.status === 401) {
    // rare tenants still accept x-api-key
    r = await fetch(url, { headers: { ...headers, 'x-api-key': key }, cache: 'no-store' });
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${path} ${r.status} ${text.slice(0, 400)}`);
  }
  return r.json();
}

function mapWaiverToRow(w) {
  // v4 list fields from your probe
  return {
    waiver_id: w.waiverId || w.id || '',
    signed_on: w.createdOn || w.created || '',
    intake_pdf_url: w.pdf || '', // may be blank from list; we link via /api/waiver-pdf anyway
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

module.exports = async (req, res) => {
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const intakeId = process.env.INTAKE_WAIVER_ID;
    const liabId   = process.env.LIABILITY_WAIVER_ID;

    if (!key || !intakeId || !liabId) {
      return res.status(200).json({
        rows: [],
        error: 'Missing Smartwaiver env (SW_API_KEY / INTAKE_WAIVER_ID / LIABILITY_WAIVER_ID)',
      });
    }

    const { fromDts, toDts } = utcRangeToday();
    const qs = new URLSearchParams({
      templateId: intakeId,
      fromDts,
      toDts,
      verified: 'true',
      limit: '200'
    });

    // v4: /waivers?...
    const payload = await swGet(`/waivers?${qs.toString()}`, key);

    const list = Array.isArray(payload?.waivers) ? payload.waivers : [];
    const rows = list.map(mapWaiverToRow);

    res.status(200).json({ rows, from: fromDts, to: toDts, count: rows.length });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
};
