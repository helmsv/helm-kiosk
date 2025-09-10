// api/intake-details.js
// GET /api/intake-details?waiverId=XXXXX[&debug=1]
// Returns { first_name, last_name, email, age, weight_lb, height_in, raw } for an Intake waiver.
//
// ENV (optional to lock exact matches):
//   SW_API_KEY  (required)
//   SW_AGE_QID / SW_AGE_LABEL
//   SW_WEIGHT_QID / SW_WEIGHT_LABEL
//   SW_HEIGHT_QID / SW_HEIGHT_LABEL

const FETCH_TIMEOUT_MS = 15000;

async function fetchTO(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// ---------- unit helpers ----------
function toNumberSafe(s) {
  if (s === null || s === undefined) return "";
  const t = String(s).trim();
  if (!t) return "";
  const n = Number(t.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : "";
}

function parseWeightToLb(input) {
  if (input === null || input === undefined || input === "") return "";
  const s = String(input).trim().toLowerCase();
  if (!s) return "";

  if (s.includes("kg")) {
    const n = Number(s.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 2.20462) : "";
  }
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : "";
}

function parseHeightToInches(input) {
  if (input === null || input === undefined || input === "") return "";
  const s0 = String(input).trim().toLowerCase();
  if (!s0) return "";

  // 5'10" / 5' 10"
  let m = s0.match(/^(\d{1,2})\s*'\s*(\d{1,2})\s*(?:\"|in|inches)?$/);
  if (m) return Number(m[1]) * 12 + Number(m[2]);

  // 5 ft 10 in / 5 feet 10 inches
  m = s0.match(/^(\d{1,2})\s*(?:ft|feet)\s*(\d{1,2})\s*(?:in|inch|inches)?$/);
  if (m) return Number(m[1]) * 12 + Number(m[2]);

  // 5-10 or 5 10
  m = s0.match(/^(\d{1,2})[-\s](\d{1,2})$/);
  if (m) return Number(m[1]) * 12 + Number(m[2]);

  // 70 in / 70 inches
  m = s0.match(/^(\d{2,3})\s*(?:in|inch|inches)$/);
  if (m) return Number(m[1]);

  // 178 cm
  m = s0.match(/^(\d{2,3})\s*cm$/);
  if (m) return Math.round(Number(m[1]) / 2.54);

  // bare number: infer inches (45..90) or cm (120..230)
  const n = Number(s0.replace(/[^0-9.]/g, ""));
  if (Number.isFinite(n)) {
    if (n >= 45 && n <= 90) return Math.round(n);
    if (n >= 120 && n <= 230) return Math.round(n / 2.54);
  }
  return "";
}

// ---------- answer extraction ----------
function extractAllAnswers(waiver) {
  const out = [];
  const candidates = [
    waiver?.participants?.[0]?.custom?.questions,
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
      for (const [k, v] of Object.entries(arr)) {
        out.push({ id: k, label: k, value: (v ?? "").toString() });
      }
    }
  }
  return out;
}

function pickAnswer(all, { qid, label, regexes }) {
  if (qid) {
    const hit = all.find(a => a.id && String(a.id) === String(qid));
    if (hit && hit.value) return hit.value;
  }
  if (label) {
    const norm = String(label).trim().toLowerCase();
    const hit = all.find(a => String(a.label || "").trim().toLowerCase() === norm);
    if (hit && hit.value) return hit.value;
  }
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
  if (!key || !waiverId) return res.status(400).json({ error: "Missing SW_API_KEY or waiverId" });

  try {
    const url = `https://api.smartwaiver.com/v4/waivers/${encodeURIComponent(waiverId)}`;
    const r = await fetchTO(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }, 20000);
    if (!r.ok) return res.status(r.status).send(await r.text());

    const j = await r.json();
    const w = j?.waiver || j;

    const p = w?.participants?.[0] || {};
    const first_name = p?.firstName || p?.firstname || "";
    const last_name  = p?.lastName  || p?.lastname  || "";
    const email      = p?.email || w?.email || "";

    const all = extractAllAnswers(w);
    if (debug) {
      return res.status(200).json({ first_name, last_name, email, answers_preview: all.slice(0, 60) });
    }

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

    const ageRaw    = pickAnswer(all, cfg.age);
    const weightRaw = pickAnswer(all, cfg.weight);
    const heightRaw = pickAnswer(all, cfg.height);

    const out = {
      first_name, last_name, email,
      age: toNumberSafe(ageRaw) || "",
      weight_lb: parseWeightToLb(weightRaw) || "",
      height_in: parseHeightToInches(heightRaw) || "",
      raw: { ageRaw, weightRaw, heightRaw }
    };

    return res.status(200).json(out);
  } catch (e) {
    console.error("intake-details fatal:", e?.message || e);
    return res.status(500).json({ error: "Failed to fetch intake details" });
  }
};