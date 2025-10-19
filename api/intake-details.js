// api/intake-details.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;
const cleanKey = v => String(v || '').trim().replace(/[^\x20-\x7E]+/g, '');

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

const toNumber = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

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
    return Math.round(n / 2.54);
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

// -------- deep answer scanners (handle many Smartwaiver shapes) ----------
function* objectEntriesDeep(obj, maxDepth = 6) {
  if (!obj || typeof obj !== 'object') return;
  const stack = [[obj, 0]];
  while (stack.length) {
    const [cur, depth] = stack.pop();
    if (depth > maxDepth) continue;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push([v, depth+1]);
      continue;
    }
    for (const [k, v] of Object.entries(cur)) {
      yield [k, v, cur];
      if (v && typeof v === 'object') stack.push([v, depth+1]);
    }
  }
}

function firstMatchValueByLabel(root, labelRe) {
  // look for objects like {label/question/name/key/title: "...", value/text/answer: "..."}
  for (const [, node] of objectEntriesDeep(root)) {
    if (!node || typeof node !== 'object') continue;
    const label = node.label || node.question || node.name || node.key || node.title || node.id;
    if (label && labelRe.test(String(label))) {
      const val = node.value ?? node.text ?? node.answer ?? node.response ?? node.selected ?? null;
      if (val != null && val !== '') return val;
    }
  }
  // look for keyValues / key-values arrays: [{key:"...", value:"..."}]
  const kvs = root.keyValues || root['key-values'];
  if (Array.isArray(kvs)) {
    for (const kv of kvs) {
      const k = kv.key || kv.name || '';
      if (labelRe.test(String(k))) return kv.value ?? kv.val ?? null;
    }
  }
  return null;
}

function extractParticipantMetrics(p, waiver) {
  const weightRaw =
    p.weight_lb ??
    firstMatchValueByLabel(p, /(weight|wt)\b/i) ??
    firstMatchValueByLabel(waiver, /(weight|wt)\b/i);

  const heightRaw =
    p.height_in ??
    firstMatchValueByLabel(p, /\b(height|ht|inches|feet|cm)\b/i) ??
    firstMatchValueByLabel(waiver, /\b(height|ht|inches|feet|cm)\b/i);

  const skierRaw =
    p.skier_type ?? p.skierType ?? p.skier ??
    firstMatchValueByLabel(p, /(skier).*?(type)|(^|\b)type($|\b)/i) ??
    firstMatchValueByLabel(waiver, /(skier).*?(type)|(^|\b)type($|\b)/i);

  const weight_lb = toNumber(p.weight_lb) ?? parseMaybeLbs(weightRaw);
  const height_in = toNumber(p.height_in) ?? parseMaybeInches(heightRaw);
  const skier_type = normalizeSkierType(skierRaw);

  let age = toNumber(p.age);
  if (age == null) age = ageFromDob(p.dob);

  return { weight_lb, height_in, skier_type, age };
}

export default async function handler(req, res){
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const waiverId = String(req.query.waiverId || '').trim();
    if (!key || !waiverId) return res.status(400).json({ error: 'Missing SW_API_KEY or waiverId' });

    const data = await swGet(`/waivers/${encodeURIComponent(waiverId)}`, key);
    const w = data.waiver || data || {};
    const topEmail = w.email || firstMatchValueByLabel(w, /email/i) || '';
    const participants = Array.isArray(w.participants) ? w.participants : [];

    const mapped = participants.map((p, idx) => {
      const base = {
        participant_index: p.participant_index ?? idx,
        first_name: p.first_name || p.firstName || '',
        last_name : p.last_name  || p.lastName  || '',
        email     : p.email || topEmail || '',
        dob       : p.dob || ''
      };
      const m = extractParticipantMetrics(p, w);
      return { ...base, ...m };
    });

    res.status(200).json({ waiver_id: waiverId, email: topEmail, participants: mapped });
  } catch (e) {
    res.status(200).json({ error: String(e) });
  }
}
