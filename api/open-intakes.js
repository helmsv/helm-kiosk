// api/open-intakes.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;

/** Clean up keys pasted with extra quotes or odd characters */
function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  return t.replace(/[^\x20-\x7E]+/g, '');
}

/** Smartwaiver GET with v4 + dual header fallback (sw-api-key / x-api-key) */
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

/** Convert Smartwaiver "YYYY-MM-DD HH:mm:ss" to ISO UTC for consistent sorting */
function normalizeSwDateToISO(s) {
  if (!s) return '';
  // Matches "2025-10-18 15:11:00"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(' ', 'T') + 'Z'; // treat as UTC
  }
  // Otherwise let Date try; if valid, toISOString
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return s; // fallback as-is
}

/** Map a waiver list item to the row shape used by tech.html */
function mapWaiverToRow(w) {
  return {
    waiver_id: w.waiverId || w.id || '',
    signed_on: normalizeSwDateToISO(w.createdOn || w.created || ''),
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

/** Date-range helpers: treat `to` as exclusive start-of-next-local-day */
function isDateOnly(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s || ""); }
function startOfLocalDayISO(dStr){
  const d = new Date(dStr);
  d.setHours(0,0,0,0);
  return d.toISOString(); // UTC ISO
}
function nextLocalDayISO(dStr){
  const d = new Date(dStr);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate()+1);
  return d.toISOString(); // UTC ISO
}
function normalizeRange({ from, to }) {
  // If both are plain dates (YYYY-MM-DD), make [from, toNextDay) in local time.
  if (isDateOnly(from) && isDateOnly(to)) {
    return { fromDts: startOfLocalDayISO(from), toDts: nextLocalDayISO(to) };
  }
  // If one/both missing, default to "today" local [start, nextDayStart)
  if (!from && !to) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    const d = `${yyyy}-${mm}-${dd}`;
    return { fromDts: startOfLocalDayISO(d), toDts: nextLocalDayISO(d) };
  }
  // If provided as full ISO timestamps, pass through as-is
  return { fromDts: from, toDts: to };
}

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const key = cleanKey(process.env.SW_API_KEY);
    const intakeId = process.env.INTAKE_WAIVER_ID;
    if (!key || !intakeId) {
      return res.status(200).json({ rows: [], error: 'Missing Smartwaiver env (SW_API_KEY / INTAKE_WAIVER_ID)' });
    }

    const { from, to } = req.query || {};
    const { fromDts, toDts } = normalizeRange({ from, to });

    const qs = new URLSearchParams({
      templateId: intakeId,
      verified: 'true',
      limit: '300' // Smartwaiver max
    });
    if (fromDts) qs.set('fromDts', fromDts);
    if (toDts)   qs.set('toDts', toDts);

    const payload = await swGet(`/waivers?${qs.toString()}`, key);
    const waivers = Array.isArray(payload?.waivers) ? payload.waivers : [];
    const rows = waivers.map(mapWaiverToRow);

    res.status(200).json({ rows, count: rows.length, from: fromDts, to: toDts });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
}
