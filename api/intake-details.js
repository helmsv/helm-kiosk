// pages/api/intake-details.js
//
// Drop-in replacement.
// - Fills PARTICIPANT height_in (inches) and skier_type (“I” | “II” | “III”)
//   by robustly parsing common Smartwaiver custom field labels/values.
// - Still returns the same shape you’ve been using.
//
// Env used:
//   SW_API_KEY      (required)
//   SW_BASE         (optional; defaults to Smartwaiver v4)
//

const SW_BASE = (process.env.SW_BASE || 'https://api.smartwaiver.com/v4').replace(/\/+$/, '');
const SW_KEY  = (process.env.SW_API_KEY || '').trim();

function bad(res, code, msg) {
  return res.status(code).json({ error: msg });
}

function cleanNum(s) {
  if (s == null) return null;
  const m = String(s).replace(/[^\d.\-]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function toInt(n) {
  if (n == null || Number.isNaN(n)) return null;
  const x = Math.round(Number(n));
  return Number.isFinite(x) ? x : null;
}

function parseHeightToInches(valueMap) {
  // Accepts a bag of possible height-related values (strings/numbers),
  // returns total inches or null.

  // 1) Explicit inches
  const inchAliases = [
    'height_in', 'height_inches', 'height (in)', 'height (inches)', 'inches'
  ];
  for (const k of inchAliases) {
    const v = valueMap[k];
    const n = cleanNum(v);
    if (n != null) return toInt(n);
  }

  // 2) Feet + inches split
  const feetAliases = ['height_ft', 'height_feet', 'feet', 'ft'];
  const inchesAliases = ['in', 'inch', 'inches_part'];
  let ft = null, inch = null;
  for (const k of feetAliases) if (ft == null)  ft   = cleanNum(valueMap[k]);
  for (const k of inchesAliases) if (inch == null) inch = cleanNum(valueMap[k]);
  if (ft != null || inch != null) {
    ft   = ft   != null ? ft   : 0;
    inch = inch != null ? inch : 0;
    return toInt(ft * 12 + inch);
  }

  // 3) Combined string “5' 6"”, “5 ft 6 in”, etc.
  const combinedAliases = ['height', 'stature', 'body height'];
  for (const k of combinedAliases) {
    const raw = valueMap[k];
    if (!raw) continue;
    const s = String(raw).toLowerCase();

    // Looks like “5' 6"”
    let m = s.match(/(\d+)\s*(?:ft|foot|feet|')\s*(\d{1,2})?\s*(?:in|inch|inches|")?/);
    if (m) {
      const ft2 = cleanNum(m[1]) || 0;
      const in2 = cleanNum(m[2]) || 0;
      return toInt(ft2 * 12 + in2);
    }

    // Looks like “66 in”
    m = s.match(/(\d+)\s*(?:in|inch|inches)/);
    if (m) return toInt(cleanNum(m[1]));

    // Looks like “167 cm”
    m = s.match(/(\d+(\.\d+)?)\s*cm/);
    if (m) return toInt(cleanNum(m[1]) * 0.393701);
  }

  // 4) Plain number with guess: 48–84 => inches, 120–230 => cm
  for (const k of [...inchAliases, ...combinedAliases]) {
    const n = cleanNum(valueMap[k]);
    if (n == null) continue;
    if (n >= 48 && n <= 84) return toInt(n);                 // plausibly inches
    if (n >= 120 && n <= 230) return toInt(n * 0.393701);    // plausibly cm
  }

  return null;
}

function parseWeightToLb(valueMap) {
  // weight_lb, weight (lb), kg -> lb
  const lbAliases = ['weight_lb', 'weight (lb)', 'weight (lbs)', 'lbs', 'pounds', 'weight'];
  for (const k of lbAliases) {
    const n = cleanNum(valueMap[k]);
    if (n != null) return toInt(n);
  }
  const kgAliases = ['weight_kg', 'kg', 'kilograms'];
  for (const k of kgAliases) {
    const n = cleanNum(valueMap[k]);
    if (n != null) return toInt(n * 2.20462);
  }
  // Final guess if a plain number is stored under “weight”
  const guess = cleanNum(valueMap['weight']);
  if (guess != null) {
    if (guess >= 30 && guess <= 400) return toInt(guess);       // assume lb
    if (guess >= 15 && guess <= 180) return toInt(guess * 2.20462); // assume kg
  }
  return null;
}

function parseSkierType(valueMap) {
  // Normalize to "I" | "II" | "III"
  const aliases = ['skier_type', 'skier type', 'skier ability', 'ability', 'type'];
  let raw = null;
  for (const k of aliases) {
    if (valueMap[k]) { raw = String(valueMap[k]); break; }
  }
  if (!raw) return null;

  const s = raw.trim().toUpperCase();
  if (s === 'I' || s === 'TYPE I') return 'I';
  if (s === 'II' || s === 'TYPE II') return 'II';
  if (s === 'III' || s === 'TYPE III') return 'III';

  if (s.includes('CAUTIOUS') || s.includes('BEGINNER')) return 'I';
  if (s.includes('MODERATE') || s.includes('INTERMEDIATE')) return 'II';
  if (s.includes('AGGRESSIVE') || s.includes('EXPERT') || s.includes('ADVANCED')) return 'III';

  // Sometimes “1/2/3”
  if (s === '1') return 'I';
  if (s === '2') return 'II';
  if (s === '3') return 'III';

  return null;
}

function parseDOB(valueMap) {
  const aliases = ['dob', 'date_of_birth', 'date of birth', 'birthdate', 'birth date'];
  for (const k of aliases) {
    const v = valueMap[k];
    if (!v) continue;
    const s = String(v).trim();
    // Try to normalize common formats to YYYY-MM-DD
    const iso = s.match(/^\d{4}-\d{2}-\d{2}$/) ? s : null;
    if (iso) return iso;
    // Try M/D/YYYY or MM/DD/YYYY
    const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (mdy) {
      const mm = String(mdy[1]).padStart(2, '0');
      const dd = String(mdy[2]).padStart(2, '0');
      return `${mdy[3]}-${mm}-${dd}`;
    }
  }
  return null;
}

function computeAgeFromDOB(dob) {
  if (!dob) return null;
  const d = new Date(dob + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  let age = today.getUTCFullYear() - d.getUTCFullYear();
  const m = today.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < d.getUTCDate())) age--;
  return age >= 0 && age <= 120 ? age : null;
}

function kvFromParticipant(p) {
  // Build a case-insensitive key/value map from participant object & its custom fields.
  const bag = {};

  // Shallow fields
  for (const [k, v] of Object.entries(p || {})) {
    if (v == null) continue;
    bag[k.toLowerCase()] = v;
  }

  // Custom fields (Smartwaiver often: [{label, value}] or similar)
  const customs = p?.custom || p?.customFields || p?.fields || [];
  (Array.isArray(customs) ? customs : []).forEach(f => {
    const k = (f?.label || f?.name || f?.display || f?.id || '').toString().toLowerCase();
    const v = f?.value ?? f?.answer ?? f?.val ?? null;
    if (k && v != null) bag[k] = v;
  });

  return bag;
}

async function swGetJSON(path) {
  if (!SW_KEY) throw new Error('Missing SW_API_KEY');
  const url = `${SW_BASE.replace(/\/+$/, '')}${path}`;
  const r = await fetch(url, {
    headers: {
      'sw-api-key': SW_KEY,
      'accept': 'application/json'
    },
    cache: 'no-store'
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Smartwaiver GET ${path} failed: ${r.status} ${r.statusText} ${body?.slice(0, 200)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const waiverId = (req.query.waiverID || req.query.waiverId || req.query.id || '').toString().trim();
    const emailParam = (req.query.email || '').toString().trim() || null;

    if (!waiverId) return bad(res, 400, 'Missing waiverID');

    // Fetch one waiver (v4: /waivers/{id})
    const payload = await swGetJSON(`/waivers/${encodeURIComponent(waiverId)}`);
    const waiver = payload?.waiver || payload || {};

    const emailTop = waiver?.email || waiver?.contactEmail || emailParam || null;

    // Smartwaiver can be multi-participant; normalize:
    const parts = Array.isArray(waiver?.participants)
      ? waiver.participants
      : [waiver?.participant || waiver].filter(Boolean);

    const participants = parts.map((p, idx) => {
      const bag = kvFromParticipant(p);

      const first_name = p?.firstName || p?.firstname || bag['first_name'] || '';
      const last_name  = p?.lastName  || p?.lastname  || bag['last_name']  || '';
      const email      = p?.email || bag['email'] || emailTop || null;

      const dob  = parseDOB(bag) || p?.dob || null;
      const age  = p?.age ?? computeAgeFromDOB(dob);

      const height_in = parseHeightToInches(bag);
      const weight_lb = parseWeightToLb(bag);
      const skier_type = parseSkierType(bag);

      return {
        participant_index: idx,
        first_name,
        last_name,
        email,
        dob: dob || null,
        weight_lb: weight_lb ?? null,
        height_in: height_in ?? null,
        skier_type: skier_type ?? null,
        age: age ?? null
      };
    });

    res.status(200).json({
      waiver_id: waiverId,
      email: emailTop,
      participants
    });
  } catch (err) {
    res.status(200).json({ error: String(err) });
  }
}
