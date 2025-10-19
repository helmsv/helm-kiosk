// api/intake-details.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;
const cleanKey = v => String(v || '').trim().replace(/[^\x20-\x7E]+/g, '');

async function swGetJSON(path, key){
  const url = `${API_BASE}${path}`;
  let r = await fetch(url, { headers: { Accept: 'application/json', 'sw-api-key': key }, cache: 'no-store' });
  if (r.status === 401) r = await fetch(url, { headers: { Accept: 'application/json', 'x-api-key': key }, cache: 'no-store' });
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`${path} ${r.status} ${t.slice(0,200)}`);
  }
  return r.json();
}

// -------- helpers for tolerant parsing --------
function toNumber(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function normalizeSkierType(s){
  const t = String(s||'').trim().toUpperCase().replace(/\bTYPE\s*/,'');
  return (t==='I'||t==='II'||t==='III') ? t : '';
}
function ageFromDob(dob){
  if (!dob) return null;
  const m = String(dob).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [ , y, mo, d ] = m.map(Number);
  const now = new Date(); const b = new Date(y, mo-1, d);
  let a = now.getFullYear() - y;
  const beforeBDay = (now.getMonth() < b.getMonth()) || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate());
  return beforeBDay ? a-1 : a;
}

// Best-effort labeled extraction from any object shape
function firstMatchValueByLabel(obj, re){
  if (!obj || typeof obj !== 'object') return '';
  const stack=[obj], seen=new Set([obj]);
  while (stack.length){
    const cur = stack.pop();
    for (const [k,v] of Object.entries(cur)){
      const label = String(k||'') + ' ' + String(cur?.displayText || cur?.label || '');
      if (re.test(label)) {
        if (typeof v === 'string' || typeof v === 'number') return String(v);
        if (v && typeof v === 'object') {
          if (typeof v.value === 'string' || typeof v.value === 'number') return String(v.value);
          if (typeof v.answer === 'string' || typeof v.answer === 'number') return String(v.answer);
          if (typeof v.displayText === 'string') return v.displayText;
        }
      }
      if (v && typeof v === 'object' && !seen.has(v)) { seen.add(v); stack.push(v); }
    }
  }
  return '';
}
function parseMaybeLbs(raw){
  const s = String(raw||'').toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(lb|lbs|pounds?)?/);
  return m ? Number(m[1]) : null;
}
function parseMaybeInches(raw){
  const s = String(raw||'').toLowerCase();
  // handles "5' 6\"", "5 ft 6 in", "66 in", "168 cm"
  let m = s.match(/(\d+)\s*(?:ft|')\s*(\d+)?\s*(?:in|")?/);
  if (m) return Number(m[1])*12 + (Number(m[2]||0));
  m = s.match(/(\d+(?:\.\d+)?)\s*(?:in|")\b/);
  if (m) return Number(m[1]);
  m = s.match(/(\d+(?:\.\d+)?)\s*cm\b/);
  if (m) return Math.round(Number(m[1]) / 2.54);
  return null;
}
function extractMetricsFromSource(src){
  const weightRaw = firstMatchValueByLabel(src, /\b(weight|wt)\b/i);
  const heightRaw = firstMatchValueByLabel(src, /\b(height|ht|inches|feet|cm)\b/i);
  const skierRaw  = firstMatchValueByLabel(src, /(skier).*?(type)|(^|\b)type($|\b)/i);
  const weight_lb = parseMaybeLbs(weightRaw);
  const height_in = parseMaybeInches(heightRaw);
  const skier_type = normalizeSkierType(skierRaw);
  return { weight_lb, height_in, skier_type };
}
function mergeParticipant(base, srcs) {
  let weight_lb = toNumber(base.weight_lb);
  let height_in = toNumber(base.height_in);
  let skier_type = normalizeSkierType(base.skier_type);
  for (const s of srcs) {
    if (weight_lb == null) weight_lb = toNumber(s?.weight_lb) ?? parseMaybeLbs(s);
    if (height_in == null) height_in = toNumber(s?.height_in) ?? parseMaybeInches(s);
    if (!skier_type)       skier_type = normalizeSkierType(s?.skier_type ?? s);
  }
  for (const s of srcs) {
    if (!s || typeof s !== 'object') continue;
    const m = extractMetricsFromSource(s);
    if (weight_lb == null && m.weight_lb != null) weight_lb = m.weight_lb;
    if (height_in == null && m.height_in != null) height_in = m.height_in;
    if (!skier_type && m.skier_type) skier_type = m.skier_type;
  }
  return { ...base, weight_lb, height_in, skier_type };
}

export default async function handler(req, res){
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const waiverId = String((req.query.waiverId || req.query.waiverID || '')).trim();
    if (!key || !waiverId) return res.status(400).json({ error: 'Missing SW_API_KEY or waiverId' });

    // 1) Base waiver (names, dob, maybe key-values)
    const base = await swGetJSON(`/waivers/${encodeURIComponent(waiverId)}`, key);
    const w = base.waiver || base || {};
    const topEmail = w.email || firstMatchValueByLabel(w, /email/i) || '';
    const baseParticipants = Array.isArray(w.participants) ? w.participants : [];

    // 2) Optional: richer participant endpoint (may not be available on all plans)
    let pExt = [];
    try {
      const ext = await swGetJSON(`/waivers/${encodeURIComponent(waiverId)}/participants`, key);
      pExt = Array.isArray(ext?.participants) ? ext.participants : (Array.isArray(ext) ? ext : []);
    } catch { /* ignore if not available */ }

    // Map by index or name
    const out = baseParticipants.map((p, idx) => {
      const baseP = {
        participant_index: p.participant_index ?? idx,
        first_name: p.first_name || p.firstName || '',
        last_name : p.last_name  || p.lastName  || '',
        email     : p.email || topEmail || '',
        dob       : p.dob || '',
        age       : toNumber(p.age) ?? ageFromDob(p.dob)
      };

      // Try to find matching ext participant by index or name
      let extP = pExt[idx];
      if (!extP) {
        const keyName = (x) => `${(x.first_name||x.firstName||'').trim().toLowerCase()}_${(x.last_name||x.lastName||'').trim().toLowerCase()}`;
        const k = keyName(p);
        extP = pExt.find(q => keyName(q) === k);
      }

      const merged = mergeParticipant(baseP, [p, extP, w]);
      return {
        participant_index: merged.participant_index,
        first_name: merged.first_name,
        last_name : merged.last_name,
        email     : merged.email,
        dob       : merged.dob || '',
        age       : merged.age ?? null,
        weight_lb : merged.weight_lb ?? null,
        height_in : merged.height_in ?? null,
        skier_type: merged.skier_type || ''
      };
    });

    res.status(200).json({ waiver_id: waiverId, email: topEmail, participants: out });
  } catch (e) {
    res.status(200).json({ error: String(e) });
  }
}
