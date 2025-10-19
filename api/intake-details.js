// Next.js API route: /api/intake-details
// Accepts waiverId | waiverID | id | swid and returns normalized participant data.
// More robust parsing for Height, Weight, Skier Type.

const SW_BASE = "https://api.smartwaiver.com/v4";

async function swGet(path, apiKey) {
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: { "sw-api-key": apiKey, "accept": "application/json" },
    redirect: "follow"
  });
  // Return JSON or a safe fallback
  try { return await r.json(); } catch { return {}; }
}

function toInt(x) {
  const n = parseInt(String(x).replace(/[^\d\-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function inchesFromFeetInches(ft, inch) {
  const f = toInt(ft), i = toInt(inch);
  if (f == null && i == null) return null;
  const total = (f || 0) * 12 + (i || 0);
  return total > 0 ? total : null;
}

function inchesFromAnyHeight(val) {
  if (!val) return null;
  const s = String(val).toLowerCase().trim();

  // Patterns like 5'11", 5 ft 11 in, 5-11, 5.11 (not ideal but common)
  let m = s.match(/(\d+)\s*(?:'|ft|feet|-)\s*(\d+)?\s*(?:"|in|inches)?/i);
  if (m) return inchesFromFeetInches(m[1], m[2] || 0);

  // "71 in" or "71 inches"
  m = s.match(/(\d+)\s*(?:in|inches)\b/);
  if (m) return toInt(m[1]);

  // "5.9 ft" etc.
  m = s.match(/(\d+(?:\.\d+)?)\s*(?:ft|feet)\b/);
  if (m) return Math.round(parseFloat(m[1]) * 12);

  // Plain number: assume inches if 45–90, assume feet if 4–7.x
  const num = parseFloat(s);
  if (Number.isFinite(num)) {
    if (num >= 45 && num <= 90) return Math.round(num); // inches
    if (num >= 4 && num <= 7.5) return Math.round(num * 12); // feet
  }
  return null;
}

function poundsFromAnyWeight(val) {
  if (!val) return null;
  const s = String(val).toLowerCase();
  // "180 lb", "180lbs", "180 pounds"
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[1]));
  return Number.isFinite(n) ? n : null;
}

function normalizeSkierType(val) {
  if (!val) return "";
  const s = String(val).trim().toUpperCase();
  // Common inputs: "I", "II", "III", "TYPE I", "1", "2", "3", radio/checkbox text, etc.
  if (/III\b|TYPE\s*III\b|\b3\b/.test(s)) return "III";
  if (/II\b|TYPE\s*II\b|\b2\b/.test(s)) return "II";
  if (/I\b(?!I)|TYPE\s*I\b|\b1\b/.test(s)) return "I";
  return s.replace(/^TYPE\s*/, ""); // fallback
}

// Build a searchable list of {label, value} from Smartwaiver participant structures
function collectLabelValuePairs(p) {
  const out = [];

  const push = (label, value) => {
    if (label == null && value == null) return;
    out.push({ label: String(label || "").trim(), value });
  };

  const dig = (node) => {
    if (!node) return;
    if (Array.isArray(node)) node.forEach(dig);
    else if (typeof node === "object") {
      const label = node.label ?? node.title ?? node.text ?? node.name ?? node.l ?? node.t ?? node.n;
      const value = node.value ?? node.v ?? node.answer ?? node.response ?? node.defaultValue ?? node.selected ?? node.s;
      if (label != null || value != null) push(label, value);
      // Recurse into common containers
      dig(node.values);
      dig(node.elements);
      dig(node.fields);
      dig(node.customParticipantFields);
    }
  };

  dig(p);
  return out;
}

function findByLabel(pairs, ...needles) {
  const N = needles.map(n => String(n).toLowerCase());
  return pairs.find(({ label }) => {
    const L = String(label || "").toLowerCase();
    return N.some(n => L.includes(n));
  })?.value ?? null;
}

function mapParticipant(p, index = 0) {
  const pairs = collectLabelValuePairs(p);

  const first = findByLabel(pairs, "first name", "firstname", "participant first");
  const last  = findByLabel(pairs, "last name", "lastname", "participant last");
  const dob   = findByLabel(pairs, "birth", "date of birth", "dob");

  // Height
  let height_in = null;
  const hMixed  = findByLabel(pairs, "height", "height (ft)", "height (feet)", "height (in)", "inches", "ft");
  const hFt     = findByLabel(pairs, "height (ft)", "height (feet)", "ft (height)");
  const hIn     = findByLabel(pairs, "height (in)", "height (inches)", "in (height)");
  if (hFt || hIn) height_in = inchesFromFeetInches(hFt, hIn);
  if (height_in == null) height_in = inchesFromAnyHeight(hMixed);

  // Weight
  let weight_lb = null;
  const wAny = findByLabel(pairs, "weight", "lbs", "pounds", "body weight");
  weight_lb = poundsFromAnyWeight(wAny);

  // Skier Type
  let skier_type = "";
  const stAny = findByLabel(pairs, "skier type", "skier ability", "type i", "type ii", "type iii", "type");
  skier_type = normalizeSkierType(stAny);

  return {
    participant_index: index,
    first_name: p.firstName || first || "",
    last_name:  p.lastName  || last  || "",
    date_of_birth: p.dateOfBirth || dob || "",
    height_in,
    weight_lb,
    skier_type
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.SW_API_KEY || "";
  const waiverId =
    (req.query.waiverId || req.query.waiverID || req.query.id || req.query.swid || "").toString().trim();

  if (!apiKey) {
    // Keep status 200 so the front-end doesn’t throw
    return res.status(200).json({ error: "Missing SW_API_KEY", participants: [] });
  }
  if (!waiverId) {
    return res.status(200).json({ error: "Missing waiverId", participants: [] });
  }

  try {
    const data = await swGet(`/waivers/${encodeURIComponent(waiverId)}`, apiKey);
    const w = data?.waiver || data || {};

    const out = {
      waiver_id: w.waiverId || waiverId,
      first_name: w.firstName || "",
      last_name:  w.lastName  || "",
      email: w.email || w.contactEmail || "",
      participants: Array.isArray(w.participants)
        ? w.participants.map((p, i) => mapParticipant(p, p?.participant_index ?? i))
        : []
    };

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ error: String(e), participants: [] });
  }
}
