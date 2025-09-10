// api/intake-details.js
// GET /api/intake-details?waiverId=XXXXX[&debug=1]
// Returns { first_name, last_name, email, age, weight_lb, height_in, raw } for an Intake waiver.
// - Robustly searches multiple response shapes for answers
// - Matches by regex OR exact env-configured labels/IDs
// - Normalizes units (kg->lb, cm/ft'in"->inches)
//
// ENV (optional but recommended to lock in exact matches):
//   SW_API_KEY                         // required
//   SW_AGE_QID         (e.g. "q_123abc")  OR SW_AGE_LABEL="Age"
//   SW_WEIGHT_QID      (e.g. "q_124def")  OR SW_WEIGHT_LABEL="Weight (lb)"
//   SW_HEIGHT_QID      (e.g. "q_125ghi")  OR SW_HEIGHT_LABEL="Height (in)"

const FETCH_TIMEOUT_MS = 15000;

async function fetchTO(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// -------- Unit parsing helpers --------
function toNumberSafe(s) {
  if (s === null || s === undefined) return "";
  const t = String(s).trim();
  if (!t) return "";
  const n = Number(t.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : "";
}

function parseWeightToLb(input) {
  if (!input && input !== 0) return "";
  const s = String(input).trim().toLowerCase();

  // If contains "kg", convert to lb
  if (s.includes("kg")) {
    const n = Number(s.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 2.20462) : "";
  }
  // If explicitly labeled as lbs or just a number, assume lb
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : "";
}

function parseHeightToInches(input) {
  if (!input && input !== 0) return "";
  let s = String(input).trim().toLowerCase();

  // Patterns:
  // 1) 5'10"  or 5' 10"
  let m = s.match(/^(\d{1,2})\s*'\s*(\d{1,2})\s*(?:\"|in|inches)?$/);
  if (m) {
    const ft = parseInt(m[1], 10), inch = parseInt(m[2], 10);
    if (Number.isFinite(ft) && Number.isFinite(inch)) return ft * 12 + inch;
  }

  // 2) 5 ft 10 in | 5 feet 10 inches
  m = s.match(/^(\d{1,2})\s*(?:ft|feet)\s*(\d{1,2})\s*(?:in|inch|inches)?$/);
  if (m) {
    const ft = parseInt(m[1], 10), inch = parseInt(m[2], 10);
    if (Number.isFinite(ft) && Number.isFinite(inch)) return ft * 12 + inch;
  }

  // 3) 5-10 or 5 10
  m = s.match(/^(\d{1,2})[-\s](\d{1,2})$/);
  if (m) {
    const ft = parseInt(m[1], 10), inch = parseInt(m[2], 10);
    if (Number.isFinite(ft) && Number.isFinite(inch)) return ft * 12 + inch;
  }

  // 4) 70 in / 70 inches
  m = s.match(/^(\d{2,3})\s*(?:in|inch|inches)$/);
  if (m) {
    const ins = parseInt(m[1], 10);
    return Number.isFinite(ins) ? ins : "";
  }

  // 5) 178 cm
  m = s.match(/^(\d{2,3})\s*cm$/);
  if (m) {
    const cm = parseInt(m[1], 10);
    return Number.isFinite(cm) ? Math.round(cm / 2.54) : "";
  }

  // 6) Pure number: assume inches if 45..90, assume cm if 120..230, otherwise empty
  const num = Number(s.replace(/[^0-9.]/g, ""));
  if (Number.isFinite(num)) {
    if (num >= 45 && num <= 90) return Math.round(num);            // inches range
    if (num >= 120 && num <= 230) return Math.round(num / 2.54);   // cm range
  }

  return "";
}

// -------- Answer extraction --------

// Flatten all potential Q&A arrays into a single list of items with the best-guess fields.
function extractAllAnswers(waiver) {
  const out = [];

  // candidate arrays (varies by account/template)
  const candidates = [
    waiver?.participants?.[0]?.custom?.questions,       // common
    waiver?.participants?.[0]?.questions,
    waiver?.custom?.questions,
    waiver?.questions,
    waiver?.formData,
    waiver?.fields
  ];

  for (const arr of candidates) {
    if (!arr) continue;
    if (Array.isArray(arr)) {
      for (const q of arr) {
        const item = {
          id: q?.questionId || q?.id || q?.key || "",
          label: (q?.question || q?.label || q?.name || "").toString(),
          value: (q?.answer ?? q?.value ?? q?.val ?? q?.response ?? "").toString()
        };
        if (item.label || item.value) out.push(item);
      }
    } else if (typeof arr === "object") {
      // object map style: { key: value }
      for (const [k, v] of Object.entries(arr)) {
        out.push({ id: k, label: k, value: (v ?? "").toString() });
      }
    }
  }

  return out;
}

// Try env-pinned ID/label; else regex by keywords
function pickAnswer(all, { qid, label, regexes }) {
  // 1) exact ID
  if (qid) {
    const hit = all.find(a => a.id && String(a.id) === String(qid));
    if (hit && hit.value) return hit.value;
  }
  // 2) exact label (case-insensitive trim)
  if (label) {
    const norm = String(label).trim().toLowerCase();
    const hit = all.find(a => String(a.label || "").trim().toLowerCase() === norm);
    if (hit && hit.value) return hit.value;
  }
  // 3) regex contains match on label
  for (const rx of regexes) {
    const hit = all.find(a => rx.test(String(a.label || "")));
    if (hit && hit.value) return hit.value;
  }
  return "";
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.SW_API_KEY;
  const waiverId = String(req.query?.waiverId || "").trim();
  const debug = String(req.query?.debug || "") === "1";

  if (!key || !waiverId) {
    return res.status(400).json({ error: "Missing SW_API_KEY or waiverId" });
  }

  try {
    const url = `https://api.smartwaiver.com/v4/waivers/${encodeURIComponent(waiverId)}`;
    const r = await fetchTO(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }, 20000);
    if (!r.ok) {
      const peek = await r.text();
      return res.status(r.status).send(peek);
    }
    const j = await r.json();
    const w = j?.waiver || j;

    // Basic identity
    const p = w?.participants?.[0] || {};
    const first_name = p?.firstName || p?.firstname || "";
    const last_name  = p?.lastName  || p?.lastname  || "";
    const email      = p?.email || w?.email || "";

    // Gather all answers we can find
    const all = extractAllAnswers(w);

    if (debug) {
      // Return a trimmed debug view (first ~40 answers) to help align labels/IDs
      return res.status(200).json({
        first_name, last_name, email,
        answers_preview: all.slice(0, 40)
      });
    }

    // Env overrides (exact match wins if provided)
    const cfg = {
      age: {
        qid: process.env.SW_AGE_QID || "",
        label: process.env.SW_AGE_LABEL || "",
        regexes: [/^age\b/i]
      },
      weight: {
        qid: process.env.SW_WEIGHT_QID || "",
        label: process.env.SW_WEIGHT_LABEL || "",
        regexes: [/weight/i, /\b(lb|lbs|pounds)\b/i, /\bkg\b/i]
      },
      height: {
        qid: process.env.SW_HEIGHT_QID || "",
        label: process.env.SW_HEIGHT_LABEL || "",
        regexes: [/height/i, /\bin(ch|ches)?\b/i, /\bcm\b/i, /\bft\b|\bfeet\b/i]
      }
    };

    // Pick raw strings
    const ageRaw    = pickAnswer(all, cfg.age);
    const weightRaw = pickAnswer(all, cfg.weight);
    const heightRaw = pickAnswer(all, cfg.height);

    // Normalize
    const ageNum       = toNumberSafe(ageRaw);           // years (just numeric)
    const weightLbNum  = parseWeightToLb(weightRaw);     // into pounds
    const heightInches = parseHeightToInches(heightRaw); // into inches

    const out = {
      first_name, last_name, email,
      age: ageNum || "",
      weight_lb: weightLbNum || "",
      height_in: heightInches || "",
      raw: { ageRaw, weightRaw, heightRaw } // handy for troubleshooting
    };

    return res.status(200).json(out);
  } catch (e) {
    console.error("intake-details fatal:", e?.message || e);
    return res.status(500).json({ error: "Failed to fetch intake details" });
  }
};