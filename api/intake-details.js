// api/intake-details.js
// GET /api/intake-details?waiverId=XXXXX[&debug=1]
// Returns { first_name, last_name, email, age, weight_lb, height_in, raw } for an Intake waiver.
//
// This version reads Smartwaiver's customParticipantFields directly (object keyed by field IDs)
// and also keeps the recursive fallback scanner. It computes age from DOB when present,
// and height_in from feet+inches fields.
//
// ENV (optional to lock exact matches if your field IDs ever change):
//   SW_API_KEY  (required)
//   SW_WEIGHT_FIELD_KEY="ktxbHqRFfWLTe"
//   SW_HEIGHT_FEET_FIELD_KEY="HWiSfrUi2BNDf"
//   SW_HEIGHT_INCH_FIELD_KEY="dnmPAXmd8wprP"
//   // If you rename or swap templates, you can still fall back to displayText matching below.

const FETCH_TIMEOUT_MS = 15000;

async function fetchTO(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// ---------- unit helpers ----------
function toIntSafe(s) {
  const n = Number(String(s ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function parseWeightToLb(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("kg")) {
    const n = Number(s.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 2.20462) : "";
  }
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : "";
}
function parseHeightToInchesFromFeetIn(feet, inches) {
  const f = toIntSafe(feet);
  const i = toIntSafe(inches);
  const total = f * 12 + i;
  return total > 0 ? total : "";
}
function ageFromDobISO(dobIso) {
  if (!dobIso) return "";
  const m = String(dobIso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const [ , yyyy, mm, dd ] = m;
  const dob = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  if (isNaN(dob.getTime())) return "";
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const mDiff = (now.getUTCMonth() + 1) - (+mm);
  const dDiff = now.getUTCDate() - (+dd);
  if (mDiff < 0 || (mDiff === 0 && dDiff < 0)) age--;
  return age >= 0 && age <= 120 ? String(age) : "";
}

// ---------- recursive scan (fallback / debug) ----------
function collectCandidates(root) {
  const out = [];
  function visit(node, pathArr) {
    if (node === null || node === undefined) return;
    const t = typeof node;
    if (t === "string" || t === "number" || t === "boolean") {
      out.push({ path: pathArr.join("."), label: pathArr[pathArr.length - 1] || "", value: String(node) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, pathArr.concat(String(i))));
      return;
    }
    if (t === "object") {
      const label = String(node.question ?? node.label ?? node.name ?? node.title ?? node.key ?? "").trim();
      const value = node.answer ?? node.value ?? node.response ?? node.val;
      if (label && value !== undefined && value !== null && String(value).trim() !== "") {
        out.push({ path: pathArr.join("."), label, value: String(value) });
      }
      for (const [k, v] of Object.entries(node)) visit(v, pathArr.concat(k));
    }
  }
  visit(root, []);
  return out;
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

    // Identity
    const p0 = Array.isArray(w?.participants) && w.participants.length ? w.participants[0] : {};
    const first_name = p0?.firstName || p0?.firstname || w?.firstName || w?.firstname || "";
    const last_name  = p0?.lastName  || p0?.lastname  || w?.lastName  || w?.lastname  || "";
    const email      = p0?.email || w?.email || "";

    // DOB -> Age
    const dob = p0?.dob || w?.dob || "";
    const age = ageFromDobISO(dob);

    // ---- Preferred: read customParticipantFields (object keyed by field IDs) ----
    const cpf = p0?.customParticipantFields && typeof p0.customParticipantFields === "object"
      ? p0.customParticipantFields : null;

    let weight_lb = "";
    let height_in = "";

    if (cpf) {
      // If you set ENV keys, use them first
      const weightKey = process.env.SW_WEIGHT_FIELD_KEY || "";
      const hFeetKey  = process.env.SW_HEIGHT_FEET_FIELD_KEY || "";
      const hInKey    = process.env.SW_HEIGHT_INCH_FIELD_KEY || "";

      function valByKey(k) {
        if (!k) return "";
        const node = cpf[k];
        return node && (node.value ?? node.answer ?? "") !== undefined ? String(node.value ?? node.answer ?? "") : "";
      }

      let wRaw = valByKey(weightKey);
      let hfRaw = valByKey(hFeetKey);
      let hiRaw = valByKey(hInKey);

      // If no ENV or missing, fall back to displayText matching
      if (!wRaw) {
        for (const [k, v] of Object.entries(cpf)) {
          const label = String(v?.displayText || "").toLowerCase();
          if (label.includes("weight")) { wRaw = String(v?.value ?? ""); break; }
        }
      }
      if (!hfRaw) {
        for (const [k, v] of Object.entries(cpf)) {
          const label = String(v?.displayText || "").toLowerCase();
          if (label.includes("height") && label.includes("feet")) { hfRaw = String(v?.value ?? ""); break; }
        }
      }
      if (!hiRaw) {
        for (const [k, v] of Object.entries(cpf)) {
          const label = String(v?.displayText || "").toLowerCase();
          if (label.includes("height") && label.includes("inch")) { hiRaw = String(v?.value ?? ""); break; }
        }
      }

      weight_lb = parseWeightToLb(wRaw) || "";
      const hInches = parseHeightToInchesFromFeetIn(hfRaw, hiRaw);
      if (hInches) height_in = hInches;
    }

    // ---- Fallback: recursive candidates if still empty ----
    if (!weight_lb || !height_in) {
      const candidates = collectCandidates(w);
      if (debug) {
        // In debug mode return the map instead of final values (helps you inspect)
        const preview = candidates.slice(0, 150).map(c => ({
          path: c.path,
          label: c.label,
          value: c.value.length > 80 ? (c.value.slice(0, 80) + "…") : c.value
        }));
        return res.status(200).json({ first_name, last_name, email, candidates: preview });
      }

      if (!weight_lb) {
        const wHit = candidates.find(c =>
          /weight/i.test(c.label) || /weight/i.test(c.path)
        );
        if (wHit) weight_lb = parseWeightToLb(wHit.value) || "";
      }

      if (!height_in) {
        const hf = candidates.find(c =>
          /height/i.test(c.label) && /feet|ft/i.test(c.label)
        );
        const hi = candidates.find(c =>
          /height/i.test(c.label) && /inch/i.test(c.label)
        );
        const hInches = parseHeightToInchesFromFeetIn(hf?.value ?? "", hi?.value ?? "");
        if (hInches) height_in = hInches;
      }
    }

    const out = {
      first_name, last_name, email,
      age: age || "",
      weight_lb: weight_lb || "",
      height_in: height_in || "",
      raw: { dob, used_customParticipantFields: !!cpf }
    };

    return res.status(200).json(out);
  } catch (e) {
    console.error("intake-details fatal:", e?.message || e);
    return res.status(500).json({ error: "Failed to fetch intake details" });
  }
};