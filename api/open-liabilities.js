// api/open-liabilities.js
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

export default async function handler(req, res) {
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const liabilityId = process.env.LIABILITY_WAIVER_ID;
    if (!key || !liabilityId) {
      return res.status(200).json({ rows: [], error: 'Missing Smartwaiver env (SW_API_KEY / LIABILITY_WAIVER_ID)' });
    }

    const { from, to } = req.query || {};
    const qs = new URLSearchParams({
      templateId: liabilityId,
      verified: 'true',
      limit: '300'
    });
    if (from) qs.set('fromDts', from);
    if (to)   qs.set('toDts', to);

    const payload = await swGet(`/waivers?${qs.toString()}`, key);
    const waivers = Array.isArray(payload?.waivers) ? payload.waivers : [];

    // Return minimal fields for reconciliation
    const rows = waivers.map(w => ({
      waiverId: w.waiverId || w.id || '',
      createdOn: w.createdOn || w.created || '',
      templateId: w.templateId || '',
      email: w.email || '',
      firstName: w.firstName || '',
      lastName: w.lastName || '',
      autoTag: w.autoTag || ''
    }));

    res.status(200).json({ rows, count: rows.length });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
}
