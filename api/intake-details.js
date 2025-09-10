// api/intake-details.js
// GET /api/intake-details?waiverId=XXXXX[&debug=1]
// Returns { first_name, last_name, email, age, weight_lb, height_in, skier_type, raw } for an Intake waiver.
//
// Reads Smartwaiver customParticipantFields directly (your debug showed keys like ktxbHqRFfWLTe, etc).
// Computes age from DOB; height_in from feet+inches fields.
// Adds skier_type detection (I / II / III) from displayText/value.
// 
// ENV (optional to lock exact matches if your field IDs ever change):
//   SW_API_KEY  (required)
//   SW_WEIGHT_FIELD_KEY="ktxbHqRFfWLTe"
//   SW_HEIGHT_FEET_FIELD_KEY="HWiSfrUi2BNDf"
//   SW_HEIGHT_INCH_FIELD_KEY="dnmPAXmd8wprP"
//   SW_SKIER_TYPE_FIELD_KEY="<fieldKey holding skier type option>"

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

    // ---- Preferred: read customParticipantFields ----
    const cpf = p0?.customParticipantFields && typeof p0.customParticipantFields === "object"
      ? p0.customParticipantFields : null;

    let weight_lb = "";
    let height_in = "";
    let skier_type = ""; // "I" | "II" | "III"

    if (cpf) {
      // Optional exact keys from ENV
      const weightKey = process.env.SW_WEIGHT_FIELD_KEY || "";
      const hFeetKey  = process.env.SW_HEIGHT_FEET_FIELD_KEY || "";
      const hInKey    = process.env.SW_HEIGHT_INCH_FIELD_KEY || "";
      const skierKey  = process.env.SW_SKIER_TYPE_FIELD_KEY || "";

      function valByKey(k) {
        if (!k) return { value: "", displayText: "" };
        const node = cpf[k];
        return {
          value: node && (node.value ?? node.answer ?? "") !== undefined ? String(node.value ?? node.answer ?? "") : "",
          displayText: node && node.displayText ? String(node.displayText) : ""
        };
      }

      // Weight
      let { value: wRaw } = valByKey(weightKey);
      if (!wRaw) {
        for (const v of Object.values(cpf)) {
          const label = String(v?.displayText || "").toLowerCase();
          if (label.includes("weight")) { wRaw = String(v?.value ?? ""); break; }
        }
      }
      weight_lb = parseWeightToLb(wRaw) || "";

      // Height feet/inches
      let { value: hfRaw } = valByKey(hFeetKey);
      let { value: hiRaw } = valByKey(hInKey);
      if (!hfRaw) {
        for (const v of Object.values(cpf)) {
          const label = String(v?.displayText || "").toLowerCase();
          if (label.includes("height") && label.includes("feet")) { hfRaw = String(v?.value ?? ""); break; }
        }
      }
      if (!hiRaw) {
        for (const v of Object.values(cpf)) {
          const label = String(v?.displayText || "").toLowerCase();
          if (label.includes("height") && label.includes("inch")) { hiRaw = String(v?.value ?? ""); break; }
        }
      }
      const hInches = parseHeightToInchesFromFeetIn(hfRaw, hiRaw);
      if (hInches) height_in = hInches;

      // Skier Type (your debug showed entries like displayText: "II", value: "Yes")
      let { value: stVal, displayText: stDisp } = valByKey(skierKey);
      function normType(s) {
        const t = String(s || "").trim().toUpperCase();
        return (t === "I" || t === "II" || t === "III") ? t : "";
      }
      let st = normType(stVal) || normType(stDisp);
      if (!st) {
        for (const v of Object.values(cpf)) {
          const disp = String(v?.displayText || "").trim().toUpperCase();
          const val = String(v?.value || "").trim().toLowerCase();
          // Pattern seen in your data: displayText = "I"/"II"/"III", value = "Yes" for the one selected.
          if ((disp === "I" || disp === "II" || disp === "III") && val === "yes") { st = disp; break; }
          // Fallback: labels like "Skier Type: II"
          if (/skier\s*type/i.test(disp)) {
            const m = disp.match(/\bI{1,3}\b/);
            if (m) { st = m[0]; break; }
          }
        }
      }
      skier_type = st || "";
    }

    // ---- Fallback scan if still empty and not in debug ----
    if (debug) {
      const candidates = collectCandidates(w)
        .slice(0, 200)
        .map(c => ({ path: c.path, label: c.label, value: c.value.length > 80 ? (c.value.slice(0, 80) + "…") : c.value }));
      return res.status(200).json({ first_name, last_name, email, candidates });
    }

    if (!weight_lb || !height_in || !skier_type) {
      const cand = collectCandidates(w);
      if (!weight_lb) {
        const wHit = cand.find(c => /weight/i.test(c.label) || /weight/i.test(c.path));
        if (wHit) weight_lb = parseWeightToLb(wHit.value) || "";
      }
      if (!height_in) {
        const hf = cand.find(c => /height.*feet/i.test(c.label));
        const hi = cand.find(c => /height.*inch/i.test(c.label));
        const hInches = parseHeightToInchesFromFeetIn(hf?.value ?? "", hi?.value ?? "");
        if (hInches) height_in = hInches;
      }
      if (!skier_type) {
        const stHit = cand.find(c =>
          /\b(I|II|III)\b/.test(String(c.value).toUpperCase()) &&
          /skier|type/i.test(c.label + " " + c.path)
        );
        if (stHit) {
          const m = String(stHit.value).toUpperCase().match(/\bI{1,3}\b/);
          if (m) skier_type = m[0];
        }
      }
    }

    const out = {
      first_name, last_name, email,
      age: age || "",
      weight_lb: weight_lb || "",
      height_in: height_in || "",
      skier_type: skier_type || "",
      raw: { dob, used_customParticipantFields: !!cpf }
    };

    return res.status(200).json(out);
  } catch (e) {
    console.error("intake-details fatal:", e?.message || e);
    return res.status(500).json({ error: "Failed to fetch intake details" });
  }
};