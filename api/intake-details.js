// api/intake-details.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;
function cleanKey(v){ return String(v || '').trim().replace(/[^\x20-\x7E]+/g, ''); }

async function swGet(path, key) {
  const url = `${API_BASE}${path}`;
  const baseHeaders = { Accept: 'application/json' };
  let r = await fetch(url, { headers: { ...baseHeaders, 'sw-api-key': key }, cache: 'no-store' });
  if (r.status === 401) r = await fetch(url, { headers: { ...baseHeaders, 'x-api-key': key }, cache: 'no-store' });
  if (!r.ok) {
    const text = await r.text().catch(()=> '');
    throw new Error(`${path} ${r.status} ${text.slice(0, 400)}`);
  }
  return r.json();
}

function ageFromDob(dob){
  if (!dob) return null;
  const m = String(dob).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const now = new Date(); const b = new Date(y, mo-1, d);
  let a = now.getFullYear() - y;
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
  return a;
}

function toNumber(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
function parseMaybeLbs(v){
  if (v == null) return null;
  const s = String(v).toLowerCase();
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (s.includes('kg')) n = n * 2.20462;
  return Math.round(n);
}
function parseMaybeInches(v){
  if (v == null) return null;
  const s = String(v).toLowerCase().trim();
  // 5'8", 5 ft 8 in, 68, 172 cm
  let m = s.match(/^(\d+)[' ]\s*(\d{1,2})/); // 5'8
  if (m) return (+m[1]*12) + (+m[2]);
  m = s.match(/(\d+)\s*ft\.?\s*(\d+)?\s*in?/);
  if (m) return (+m[1]*12) + (m[2] ? +m[2] : 0);
  m = s.match(/(\d+(\.\d+)?)\s*cm/);
  if (m) return Math.round(parseFloat(m[1]) / 2.54);
  m = s.match(/(\d+(\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]);
    // if clearly inches-like range
    if (n <= 96) return Math.round(n);
    // if large, assume cm
    if (n > 96) return Math.round(n / 2.54);
  }
  return null;
}
function normalizeSkierType(v){
  const t = String(v || '').trim().toUpperCase().replace(/\s+/g,'');
  if (t==='I' || t==='II' || t==='III') return t;
  if (t==='TYPEI') return 'I';
  if (t==='TYPEII') return 'II';
  if (t==='TYPEIII') return 'III';
  return '';
}

// Walk an object and try to find likely answers by key name
function findValueByKeyRegex(obj, re){
  if (!obj || typeof obj !== 'object') return null;
  for (const [k,v] of Object.entries(obj)){
    if (re.test(String(k))) return v;
    if (v && typeof v === 'object'){
      const sub = findValueByKeyRegex(v, re);
      if (sub != null) return sub;
    }
  }
  return null;
}

export default async function handler(req, res){
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const waiverId = String(req.query.waiverId || '').trim();
    if (!key || !waiverId) {
      return res.status(400).json({ error: 'Missing SW_API_KEY or waiverId' });
    }

    const data = await swGet(`/waivers/${encodeURIComponent(waiverId)}`, key);
    // Smartwaiver v4 returns { type: "waiver", waiver: {...} }
    const w = data.waiver || data || {};

    const topEmail = w.email || findValueByKeyRegex(w, /email/i) || '';
    const participants = Array.isArray(w.participants) ? w.participants : [];

    const mapped = participants.map((p, idx) => {
      // try to find common custom fields
      const weightRaw = findValueByKeyRegex(p, /(weight|wt)\b/i);
      const heightRaw = findValueByKeyRegex(p, /(height|ht|inches|feet|cm)\b/i);
      const skierRaw  = findValueByKeyRegex(p, /(skier).*?(type)|^type$/i) || p.skierType || p.skier || '';

      const weight_lb = toNumber(p.weight_lb) ?? parseMaybeLbs(weightRaw);
      const height_in = toNumber(p.height_in) ?? parseMaybeInches(heightRaw);
      const skier_type = normalizeSkierType(p.skier_type || skierRaw);

      let age = toNumber(p.age);
      if (age == null) age = ageFromDob(p.dob);

      return {
        participant_index: p.participant_index ?? idx,
        first_name: p.first_name || p.firstName || '',
        last_name : p.last_name  || p.lastName  || '',
        email     : p.email || topEmail || '',
        dob       : p.dob || '',
        age,
        weight_lb,
        height_in,
        skier_type
      };
    });

    res.status(200).json({ waiver_id: waiverId, email: topEmail, participants: mapped });
  } catch (e) {
    res.status(200).json({ error: String(e) });
  }
}
