// api/intake-details.js
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
  const headers = { Accept: 'application/json', 'sw-api-key': key };
  let r = await fetch(url, { headers, cache: 'no-store' });
  if (r.status === 401) {
    r = await fetch(url, { headers: { ...headers, 'x-api-key': key }, cache: 'no-store' });
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${path} ${r.status} ${text.slice(0, 400)}`);
  }
  return r.json();
}

function inchesFromFeetInches(feet, inches) {
  const f = Number(feet); const i = Number(inches);
  if (!Number.isFinite(f) && !Number.isFinite(i)) return null;
  return (Number.isFinite(f) ? f : 0) * 12 + (Number.isFinite(i) ? i : 0);
}

function mapParticipant(p, idx) {
  // Try common custom fields ids/labels you showed earlier
  const customs = p?.customParticipantFields || {};

  // Try to find weight/height/type by value/label scanning
  function findValByText(keys) {
    for (const k of Object.keys(customs)) {
      const o = customs[k];
      const label = (o?.displayText || '').toLowerCase();
      if (keys.some(txt => label.includes(txt))) return o?.value ?? null;
    }
    return null;
  }

  const weightLb = Number(findValByText(['weight'])) || null;
  const heightFt = Number(findValByText(['height (feet)'])) || null;
  const heightIn = Number(findValByText(['height (inches)'])) || 0;
  const skierType = (findValByText(['skier type','ii','type i','type ii','type iii']) || '').toString().toUpperCase();

  return {
    participant_index: Number.isFinite(idx) ? idx : 0,
    first_name: p?.firstName || '',
    last_name:  p?.lastName || '',
    email: p?.email || '',
    age: p?.age != null ? Number(p.age) : null,
    weight_lb: weightLb,
    height_in: inchesFromFeetInches(heightFt, heightIn),
    skier_type: skierType
  };
}

module.exports = async (req, res) => {
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const waiverId = req.query.waiverId || req.query.id;
    if (!key) return res.status(200).json({ error: 'Missing SW_API_KEY' });
    if (!waiverId) return res.status(200).json({ error: 'Missing waiverId' });

    // v4 detail (assumes /v4/waivers/{id})
    const payload = await swGet(`/waivers/${encodeURIComponent(waiverId)}`, key);

    // v4 detail shape: { type:"waiver", waiver:{ ... } } (defensive parsing)
    const w = payload?.waiver || payload || {};

    const out = {
      waiver_id: w.waiverId || waiverId,
      first_name: w.firstName || '',
      last_name:  w.lastName || '',
      email: w.email || '',
      participants: Array.isArray(w.participants)
        ? w.participants.map((p, i) => mapParticipant(p, p?.participant_index ?? i))
        : []
    };

    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ error: String(e) });
  }
};
