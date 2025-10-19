// pages/api/intake-details.js
// Robust Smartwaiver intake normalizer for DIN calculation.
// Explicitly supports labels: "Age", "Weight", "Height", "Skier Type"

const SW_BASE = "https://api.smartwaiver.com/v4";

async function swGet(path, apiKey) {
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: { "sw-api-key": apiKey, accept: "application/json" },
    redirect: "follow",
  });
  try { return await r.json(); } catch { return {}; }
}

const toInt = (x) => {
  if (x == null) return null;
  const m = String(x).match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
};

function inchesFromFeetInches(ft, inch) {
  const f = toInt(ft), i = toInt(inch);
  if (f == null && i == null) return null;
  const total = (f || 0) * 12 + (i || 0);
  return total > 0 ? total : null;
}

function inchesFromAnyHeight(val) {
  if (!val && val !== 0) return null;
  const s = String(val).trim().toLowerCase();

  // 5'11", 5 ft 11 in, 5-11
  let m = s.match(/(\d+)\s*(?:'|ft|feet|-)\s*(\d+)?\s*(?:"|in|inches)?/i);
  if (m) return inchesFromFeetInches(m[1], m[2] || 0);

  // 71 in / inches
  m = s.match(/(\d+(?:\.\d+)?)\s*(?:in|inches)\b/);
  if (m) return Math.round(parseFloat(m[1]));

  // 5.9 ft
  m = s.match(/(\d+(?:\.\d+)?)\s*(?:ft|feet)\b/);
  if (m) return Math.round(parseFloat(m[1]) * 12);

  // Bare number: assume inches if 45–90; feet if 4–7.5
  const num = parseFloat(s);
  if (Number.isFinite(num)) {
    if (num >= 45 && num <= 90) return Math.round(num);
    if (num >= 4 && num <= 7.5) return Math.round(num * 12);
  }
  return null;
}

function poundsFromAnyWeight(val) {
  if (!val && val !== 0) return null;
  const m = String(val).toLowerCase().match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[1]));
  return Number.isFinite(n) ? n : null;
}

function normalizeSkierType(val) {
  if (!val) return "";
  const s = String(val).trim().toUpperCase();

  // Map common phrases to I/II/III
  if (/(TYPE\s*)?III\b|(^|\b)3\b|AGGRESSIVE/.test(s)) return "III";
  if (/(TYPE\s*)?II\b|(^|\b)2\b|AVERAGE|MODERATE/.test(s)) return "II";
  if (/(TYPE\s*)?I(\b|$)|(^|\b)1\b|CAUTIOUS/.test(s)) return "I";

  // Fallback (e.g., "TYPE I – Cautious")
  return s.replace(/^TYPE\s*/, "");
}

function computeAgeFromDob(dobIso) {
  if (!dobIso) return null;
  const dob = new Date(dobIso);
  if (isNaN(dob)) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

// Make a flat list of {label, value} from any node
function collectLabelValuePairs(node) {
  const out = [];
  const push = (label, value) => {
    if (label == null && value == null) return;
    out.push({ label: String(label || "").trim(), value });
  };
  const dig = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(dig); return; }
    if (typeof n === "object") {
      const label = n.label ?? n.title ?? n.text ?? n.name ?? n.l ?? n.t ?? n.n;
      const value = n.value ?? n.v ?? n.answer ?? n.response ?? n.defaultValue ?? n.selected ?? n.s;
      if (label != null || value != null) push(label, value);
      dig(n.values);
      dig(n.elements);
      dig(n.fields);
      dig(n.customParticipantFields);
      dig(n.children);
    }
  };
  dig(node);
  return out;
}

function findValueByLabel(pairs, ...needles) {
  const N = needles.map((x) => String(x).toLowerCase());
  for (const { label, value } of pairs) {
    const L = String(label || "").toLowerCase();
    if (N.some((n) => L.includes(n))) return value;
  }
  return null;
}

function mapParticipant(p, index, waiverPairs) {
  const pairs = collectLabelValuePairs(p);

  // Basic names/dob (fallback to waiver-level if missing)
  const first =
    p.firstName ||
    findValueByLabel(pairs, "first name", "firstname") ||
    findValueByLabel(waiverPairs, "first name", "firstname") ||
    "";
  const last =
    p.lastName ||
    findValueByLabel(pairs, "last name", "lastname") ||
    findValueByLabel(waiverPairs, "last name", "lastname") ||
    "";
  const dob =
    p.dateOfBirth ||
    findValueByLabel(pairs, "date of birth", "dob", "birth") ||
    findValueByLabel(waiverPairs, "date of birth", "dob", "birth") ||
    "";

  // Age — EXACT label “Age”, fallback to DOB-derived
  let age =
    toInt(findValueByLabel(pairs, "age")) ??
    toInt(findValueByLabel(waiverPairs, "age")) ??
    computeAgeFromDob(dob);

  // Height — EXACT label “Height” (but also support common variants)
  let heightRaw =
    findValueByLabel(pairs, "height") ??
    findValueByLabel(waiverPairs, "height");
  const hFt = findValueByLabel(pairs, "height (ft)", "height feet");
  const hIn = findValueByLabel(pairs, "height (in)", "height inches");
  let height_in =
    inchesFromFeetInches(hFt, hIn) ??
    inchesFromAnyHeight(heightRaw);

  // Weight — EXACT label “Weight”
  let weightRaw =
    findValueByLabel(pairs, "weight") ??
    findValueByLabel(waiverPairs, "weight");
  let weight_lb = poundsFromAnyWeight(weightRaw);

  // Skier Type — EXACT label “Skier Type”
  let skierRaw =
    findValueByLabel(pairs, "skier type") ??
    findValueByLabel(waiverPairs, "skier type");
  let skier_type = normalizeSkierType(skierRaw);

  return {
    participant_index: index,
    first_name: first,
    last_name: last,
    date_of_birth: dob || "",
    age: age ?? null,
    height_in: height_in ?? null,
    weight_lb: weight_lb ?? null,
    skier_type: skier_type || "",
    // (Optional) raw hints for debugging – harmless to the UI:
    _raw: {
      age: age ?? null,
      height: heightRaw ?? null,
      weight: weightRaw ?? null,
      skierType: skierRaw ?? null,
    },
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.SW_API_KEY || "";
  const waiverId =
    (req.query.waiverId ||
      req.query.waiverID ||
      req.query.id ||
      req.query.swid ||
      "").toString().trim();

  if (!apiKey) {
    return res.status(200).json({ error: "Missing SW_API_KEY", participants: [] });
  }
  if (!waiverId) {
    return res.status(200).json({ error: "Missing waiverId", participants: [] });
  }

  try {
    const data = await swGet(`/waivers/${encodeURIComponent(waiverId)}`, apiKey);
    const w = data?.waiver || data || {};

    // Build waiver-level pairs for fallback lookups of Age/Height/Weight/Skier Type
    const waiverPairs = collectLabelValuePairs(w);

    const participants = Array.isArray(w.participants)
      ? w.participants.map((p, i) => mapParticipant(p, p?.participant_index ?? i, waiverPairs))
      : [
          // Single-participant waivers sometimes flatten fields on the waiver object
          mapParticipant({}, 0, waiverPairs),
        ];

    const out = {
      waiver_id: w.waiverId || waiverId,
      email: w.email || w.contactEmail || "",
      participants,
    };

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ error: String(e), participants: [] });
  }
}
