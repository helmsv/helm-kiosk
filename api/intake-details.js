// api/intake-details.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;
const cleanKey = v => String(v || '').trim().replace(/[^\x20-\x7E]+/g, '');

async function swGetJSON(path, key, accept = 'application/json') {
  const url = `${API_BASE}${path}`;
  let r = await fetch(url, { headers: { Accept: accept, 'sw-api-key': key }, cache: 'no-store' });
  if (r.status === 401) r = await fetch(url, { headers: { Accept: accept, 'x-api-key': key }, cache: 'no-store' });
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`${path} ${r.status} ${t.slice(0, 400)}`);
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

const toNumber = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function parseMaybeLbs(v){
  if (v == null) return null;
  const s = String(v).toLowerCase();
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (s.includes('kg')) n = n * 2.20462;
  // sanity: typical rental weights 25–350 lb
  if (n < 15 || n > 600) return null;
  return Math.round(n);
}
function parseMaybeInches(v){
  if (v == null) return null;
  const s = String(v).toLowerCase().trim();
  // 5'8" or 5' 8
  let m = s.match(/^(\d+)\s*['’]\s*(\d{1,2})/);
  if (m) return (+m[1]*12) + (+m[2]);
  // 5 ft 8 in
  m = s.match(/(\d+)\s*ft\.?\s*(\d+)?\s*in?/);
  if (m) return (+m[1]*12) + (m[2] ? +m[2] : 0);
  // 172 cm
  m = s.match(/(\d+(\.\d+)?)\s*cm/);
  if (m) return Math.round(parseFloat(m[1]) / 2.54);
  // plain number: <=96 → inches, else assume cm
  m = s.match(/(\d+(\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]);
    if (n <= 96) return Math.round(n);
    if (n <= 300) return Math.round(n / 2.54);
  }
  return null;
}
function normalizeSkierType(v){
  const t = String(v || '').trim().toUpperCase().replace(/\s+/g,'');
  if (t==='I' || t==='II' || t==='III') return t;
  if (t==='TYPEI') return 'I';
  if (t==='TYPEII') return 'II';
  if (t==='TYPEIII') return 'III';
  // common noise like Yes/No should NOT set a type
  return '';
}

// Deep scanners
function* deepEntries(o, maxDepth = 7) {
  if (!o || typeof o !== 'object') return;
  const stack = [[o, 0]];
  while (stack.length) {
    const [cur, d] = stack.pop();
    if (d > maxDepth) continue;
    if (Array.isArray(cur)) { for (const v of cur) stack.push([v, d+1]); continue; }
    for (const [k, v] of Object.entries(cur)) {
      yield [k, v, cur];
      if (v && typeof v === 'object') stack.push([v, d+1]);
    }
  }
}
function firstMatchValueByLabel(root, labelRe) {
  // shapes: {label/question/name/key/title: "...", value/text/answer/response: "..."}
  for (const [, node] of deepEntries(root)) {
    if (!node || typeof node !== 'object') continue;
    const label = node.label || node.question || node.name || node.key || node.title || node.id;
    if (label && labelRe.test(String(label))) {
      const val = node.value ?? node.text ?? node.answer ?? node.response ?? node.selected ?? null;
      if (val != null && val !== '') return val;
    }
  }
  // keyValues / key-values: [{key:"...", value:"..."}]
  const kvs = root?.keyValues || root?.['key-values'];
  if (Array.isArray(kvs)) {
    for (const kv of kvs) {
      const k = kv.key || kv.name || '';
      if (labelRe.test(String(k))) return kv.value ?? kv.val ?? null;
    }
  }
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

  // try provided sources in order
  for (const s of srcs) {
    if (weight_lb == null) weight_lb = toNumber(s?.weight_lb) ?? parseMaybeLbs(s);
    if (height_in == null) height_in = toNumber(s?.height_in) ?? parseMaybeInches(s);
    if (!skier_type)       skier_type = normalizeSkierType(s?.skier_type ?? s);
  }

  // last chance: labeled extraction
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

    // 2) Optional, richer participant endpoint (if present for your account)
    let pExt = [];
    try {
      const ext = await swGetJSON(`/waivers/${encodeURIComponent(waiverId)}/participants`, key);
      pExt = Array.isArray(ext?.participants) ? ext.participants : (Array.isArray(ext) ? ext : []);
    } catch { /* endpoint not available on some plans; ignore */ }

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

      // Find a matching ext participant by index or name
      let extP = pExt[idx];
      if (!extP) {
        const keyName = (x) => `${(x.first_name||x.firstName||'').trim().toLowerCase()}_${(x.last_name||x.lastName||'').trim().toLowerCase()}`;
        const k = keyName(p);
        extP = pExt.find(q => keyName(q) === k);
      }

      // Merge metrics from candidate sources: participant, ext participant, whole waiver
      const merged = mergeParticipant(
        baseP,
        [p, extP, w]
      );
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
