// /api/today-intakes.js
export default async function handler(req, res) {
  try {
    const SW_API_KEY = process.env.SW_API_KEY;
    const INTAKE_WAIVER_ID = process.env.INTAKE_WAIVER_ID;
    const LIABILITY_WAIVER_ID = process.env.LIABILITY_WAIVER_ID;
    const SW_BASE = process.env.SW_BASE_URL || "https://api.smartwaiver.com/v4";

    const missing = [];
    if (!SW_API_KEY) missing.push("SW_API_KEY");
    if (!INTAKE_WAIVER_ID) missing.push("INTAKE_WAIVER_ID");
    if (!LIABILITY_WAIVER_ID) missing.push("LIABILITY_WAIVER_ID");
    if (missing.length) {
      return res.status(500).json({ rows: [], error: `Missing SW env (${missing.join(" / ")})` });
    }

    const LOOKBACK_DAYS = 1; // set to 7 temporarily if you want to test more history
    const now = new Date();
    const from = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000);
    const fromStr = fmtDTS(from);
    const toStr = fmtDTS(now);

    const intakeList = await listWaivers({ SW_BASE, SW_API_KEY, templateId: INTAKE_WAIVER_ID, fromDts: fromStr, toDts: toStr, limit: 200 });
    const liabList   = await listWaivers({ SW_BASE, SW_API_KEY, templateId: LIABILITY_WAIVER_ID, fromDts: fromStr, toDts: toStr, limit: 200 });

    const liabTagSet = new Set();
    const liabEmailSet = new Set();
    for (const w of liabList) {
      const tags = Array.isArray(w.tags) ? w.tags : [];
      for (const t of tags) if (typeof t === "string" && t.toLowerCase().startsWith("ls_")) liabTagSet.add(t.toLowerCase());
      const topEmail = (w.email || "").toLowerCase();
      if (topEmail) liabEmailSet.add(topEmail);
      if (Array.isArray(w.participants)) {
        for (const p of w.participants) {
          const pe = (p.email || "").toLowerCase();
          if (pe) liabEmailSet.add(pe);
        }
      }
    }

    const rows = [];
    for (const w of intakeList) {
      const tagArr = Array.isArray(w.tags) ? w.tags.map(s => String(s).toLowerCase()) : [];
      const lsTag = tagArr.find(t => t.startsWith("ls_"));
      const topEmail = (w.email || "").toLowerCase();
      const participants = Array.isArray(w.participants) ? w.participants : [];

      const skipIntake = (lsTag && liabTagSet.has(lsTag)) || (topEmail && liabEmailSet.has(topEmail));
      if (skipIntake) continue;

      participants.forEach((p, idx) => {
        const email = (p.email || w.email || "").toLowerCase();
        if (email && liabEmailSet.has(email)) return;

        rows.push({
          waiver_id: w.waiverId || w.waiver_id || "",
          signed_on: w.createdOn || w.signedOn || w.signed_on || "",
          intake_pdf_url: w.pdf || w.intake_pdf_url || "",
          lightspeed_id: extractLsId(tagArr),
          email,
          first_name: p.firstName || p.first_name || w.firstName || "",
          last_name:  p.lastName  || p.last_name  || w.lastName  || "",
          age: numOrNull(p.age ?? w.age),
          weight_lb: numOrNull(extractWeightLb(p)),
          height_in: numOrNull(extractHeightInches(p)),
          skier_type: (extractSkierType(p) || "").toUpperCase(),
          participant_index: numOrZero(p.participant_index ?? idx),
        });
      });
    }

    return res.status(200).json({ rows });
  } catch (err) {
    console.error("today-intakes error:", err);
    return res.status(200).json({ rows: [], error: "today-intakes failed" });
  }
}

function fmtDTS(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function listWaivers({ SW_BASE, SW_API_KEY, templateId, fromDts, toDts, limit = 200 }) {
  if (!templateId) return [];
  const url = new URL(`${SW_BASE}/waivers`);
  url.searchParams.set("templateId", templateId);
  if (fromDts) url.searchParams.set("fromDts", fromDts);
  if (toDts)   url.searchParams.set("toDts", toDts);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "createdOn:desc");

  const r = await fetch(url.toString(), {
    headers: {
      "X-API-Key": SW_API_KEY,
      "sw-api-key": SW_API_KEY,
    },
  });
  if (!r.ok) {
    console.warn("listWaivers status", r.status);
    return [];
  }
  const j = await r.json();
  return Array.isArray(j?.waivers) ? j.waivers : (Array.isArray(j) ? j : []);
}

function numOrNull(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function numOrZero(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function extractLsId(tags){ if(!Array.isArray(tags)) return ""; const t=tags.find(s=>String(s).toLowerCase().startsWith("ls_")); return t?String(t).slice(3):""; }
function extractWeightLb(p){
  if (p.weight_lb != null) return p.weight_lb;
  const cpf = p.customParticipantFields || {};
  for (const entry of Object.values(cpf)) {
    const label = (entry.displayText || "").toLowerCase();
    if (label.includes("weight")) {
      const n = Number(String(entry.value || "").replace(/[^\d.]/g,""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
function extractHeightInches(p){
  if (p.height_in != null) return p.height_in;
  const cpf = p.customParticipantFields || {};
  let feet = null, inches = 0;
  for (const entry of Object.values(cpf)) {
    const label = (entry.displayText || "").toLowerCase();
    if (label.includes("height (feet")) {
      const n = Number(String(entry.value || "").replace(/[^\d.]/g,""));
      if (Number.isFinite(n)) feet = n;
    }
    if (label.includes("height (inches")) {
      const n = Number(String(entry.value || "").replace(/[^\d.]/g,""));
      if (Number.isFinite(n)) inches = n;
    }
  }
  if (feet != null) return feet * 12 + (inches || 0);
  return null;
}
function extractSkierType(p){
  if (p.skier_type) return p.skier_type;
  const cpf = p.customParticipantFields || {};
  for (const entry of Object.values(cpf)) {
    const v = String(entry.value || "").toUpperCase();
    if (["I","II","III"].includes(v)) return v;
  }
  return "";
}
