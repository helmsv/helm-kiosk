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

// ---------- recursive scan ----------
// Walk the entire waiver JSON and collect candidate Q&A entries.
// We consider any object that looks like {question/label/name, answer/value/response}
// AND also any primitive under keys that hint at age/weight/height.
function collectCandidates(root) {
  const out = [];

  function visit(node, pathArr) {
    if (node === null || node === undefined) return;
    const t = typeof node;

    if (t === "string" || t === "number" || t === "boolean") {
      const key = pathArr[pathArr.length - 1] || "";
      out.push({
        path: pathArr.join("."),
        label: key,
        value: String(node)
      });
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, pathArr.concat(String(i))));
      return;
    }

    if (t === "object") {
      // shape like { question|label|name, answer|value|response }
      const label = String(node.question ?? node.label ?? node.name ?? node.title ?? node.key ?? "").trim();
      const value = node.answer ?? node.value ?? node.response ?? node.val;
      if (label && (value !== undefined && value !== null && String(value).trim() !== "")) {
        out.push({
          path: pathArr.join("."),
          label,
          value: String(value)
        });
      }
      // traverse children
      for (const [k, v] of Object.entries(node)) {
        visit(v, pathArr.concat(k));
      }
    }
  }

  visit(root, []);
  return out;
}

function bestByRegex(cands, regexes) {
  // Prefer items whose LABEL matches; if none, allow PATH match
  for (const rx of regexes) {
    const hit = cands.find(c => rx.test((c.label || "")));
    if (hit) return hit.value;
  }
  for (const rx of regexes) {
    const hit = cands.find(c => rx.test((c.path || "")));
    if (hit) return hit.value;
  }
  return "";
}

function pickWithOverrides(cands, { qid, label, regexes }) {
  // exact label (case-insensitive)
  if (label) {
    const norm = String(label).trim().toLowerCase();
    const hit = cands.find(c => String(c.label || "").trim().toLowerCase() === norm);
    if (hit && hit.value) return hit.value;
  }
  // exact ID (some shapes include questionId in the path)
  if (qid) {
    const hit = cands.find(c => c.path && c.path.toLowerCase().includes(String(qid).toLowerCase()));
    if (hit && hit.value) return hit.value;
  }
  // regex fallback
  return bestByRegex(cands, regexes);
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

    // Identity (participants array varies—try a few common fields)
    const p0 = Array.isArray(w?.participants) && w.participants.length ? w.participants[0] : {};
    const first_name =
      p0?.firstName || p0?.firstname || w?.firstName || w?.firstname || "";
    const last_name  =
      p0?.lastName  || p0?.lastname  || w?.lastName  || w?.lastname  || "";
    const email      =
      p0?.email || w?.email || "";

    // Collect ALL candidates from the payload
    const candidates = collectCandidates(w);

    if (debug) {
      // Send a compact map to help you see where fields live.
      // Limit to 120 entries and trim long values.
      const preview = candidates.slice(0, 120).map(c => ({
        path: c.path,
        label: c.label,
        value: c.value.length > 80 ? (c.value.slice(0, 80) + "…") : c.value
      }));
      return res.status(200).json({ first_name, last_name, email, candidates: preview });
    }

    // ENV-based pins + regex matchers
    const cfg = {
      age: {
        qid: process.env.SW_AGE_QID || "",
        label: process.env.SW_AGE_LABEL || "",
        regexes: [
          /^age\b/i,
          /participant.*age/i
        ]
      },
      weight: {
        qid: process.env.SW_WEIGHT_QID || "",
        label: process.env.SW_WEIGHT_LABEL || "",
        regexes: [
          /weight/i,
          /\b(lb|lbs|pounds)\b/i,
          /\bkg\b/i
        ]
      },
      height: {
        qid: process.env.SW_HEIGHT_QID || "",
        label: process.env.SW_HEIGHT_LABEL || "",
        regexes: [
          /height/i,
          /\bin(ch|ches)?\b/i,
          /\bcm\b/i,
          /\bft\b|\bfeet\b/i
        ]
      }
    };

    const ageRaw    = pickWithOverrides(candidates, cfg.age);
    const weightRaw = pickWithOverrides(candidates, cfg.weight);
    const heightRaw = pickWithOverrides(candidates, cfg.height);

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