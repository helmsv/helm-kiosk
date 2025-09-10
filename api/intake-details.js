// api/intake-details.js
// GET /api/intake-details?waiverId=XXXXX
// Returns { first_name, last_name, email, age, weight_lb, height_in, raw } for the Intake waiver

const FETCH_TIMEOUT_MS = 15000;

async function fetchTO(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function getAnswer(waiver, labelMatchers) {
  // Pull from Smartwaiver custom questions by matching the label text (case-insensitive)
  const answers = waiver?.participants?.[0]?.custom?.questions || waiver?.custom || [];
  if (!Array.isArray(answers)) return "";
  const find = (labels) => {
    const m = answers.find(q => {
      const text = (q?.question || q?.label || "").toLowerCase();
      return labels.some(l => text.includes(l));
    });
    return (m?.answer ?? m?.value ?? "").toString().trim();
  };
  return find(labelMatchers);
}

function toNumberSafe(s) {
  const n = Number(String(s).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : "";
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.SW_API_KEY;
  const waiverId = String(req.query?.waiverId || "").trim();
  if (!key || !waiverId) return res.status(400).json({ error: "Missing SW_API_KEY or waiverId" });

  try {
    const url = `https://api.smartwaiver.com/v4/waivers/${encodeURIComponent(waiverId)}`;
    const r = await fetchTO(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }, 20000);
    if (!r.ok) {
      const peek = await r.text();
      return res.status(r.status).send(peek);
    }
    const j = await r.json();
    const w = j?.waiver || j;

    const p = w?.participants?.[0] || {};
    const first_name = p?.firstName || p?.firstname || "";
    const last_name  = p?.lastName  || p?.lastname  || "";
    const email      = p?.email || w?.email || "";

    // Try to pull these by label keywords you used on Intake
    const ageRaw    = getAnswer(w, ["age"]);
    const weightRaw = getAnswer(w, ["weight", "lbs", "pounds", "lb"]);
    const heightRaw = getAnswer(w, ["height", "inches", "in"]);

    const out = {
      first_name, last_name, email,
      age: toNumberSafe(ageRaw),
      weight_lb: toNumberSafe(weightRaw),
      height_in: toNumberSafe(heightRaw),
      raw: { ageRaw, weightRaw, heightRaw } // useful for debugging
    };

    return res.status(200).json(out);
  } catch (e) {
    console.error("intake-details fatal:", e?.message || e);
    return res.status(500).json({ error: "Failed to fetch intake details" });
  }
};