// api/open-liabilities.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;

// Clean up keys pasted with quotes or odd characters
function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  return t.replace(/[^\x20-\x7E]+/g, '');
}

// Smartwaiver GET with v4 + dual header fallback (sw-api-key / x-api-key)
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

// Normalize Smartwaiver "YYYY-MM-DD HH:mm:ss" to ISO UTC
function normalizeSwDateToISO(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(' ', 'T') + 'Z'; // treat as UTC
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return s;
}

// Range helpers — treat `to` as exclusive start-of-next-local-day when date-only
function isDateOnly(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s || ""); }
function startOfLocalDayISO(dStr){
  const d = new Date(dStr);
  d.setHours(0,0,0,0);
  return d.toISOString();
}
function nextLocalDayISO(dStr){
  const d = new Date(dStr);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate()+1);
  return d.toISOString();
}
function normalizeRange({ from, to }) {
  if (isDateOnly(from) && isDateOnly(to)) {
    return { fromDts: startOfLocalDayISO(from), toDts: nextLocalDayISO(to) };
  }
  if (!from && !to) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    const d = `${yyyy}-${mm}-${dd}`;
    return { fromDts: startOfLocalDayISO(d), toDts: nextLocalDayISO(d) };
  }
  return { fromDts: from, toDts: to };
}

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const key = cleanKey(process.env.SW_API_KEY);
    const liabilityId = process.env.LIABILITY_WAIVER_ID;
    if (!key || !liabilityId) {
      return res.status(200).json({ rows: [], error: 'Missing Smartwaiver env (SW_API_KEY / LIABILITY_WAIVER_ID)' });
    }

    const { from, to } = req.query || {};
    const { fromDts, toDts } = normalizeRange({ from, to });

    const qs = new URLSearchParams({
      templateId: liabilityId,
      verified: 'true',
      limit: '300'
    });
    if (fromDts) qs.set('fromDts', fromDts);
    if (toDts)   qs.set('toDts', toDts);

    const payload = await swGet(`/waivers?${qs.toString()}`, key);
    const waivers = Array.isArray(payload?.waivers) ? payload.waivers : [];

    // Minimal fields front-end uses for reconciliation + normalized timestamp
    const rows = waivers.map(w => ({
      waiverId:  w.waiverId || w.id || '',
      createdOn: normalizeSwDateToISO(w.createdOn || w.created || ''),
      templateId: w.templateId || '',
      email:     w.email || '',
      firstName: w.firstName || '',
      lastName:  w.lastName || '',
      autoTag:   w.autoTag || ''
    }));

    res.status(200).json({ rows, count: rows.length, from: fromDts, to: toDts });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
}
