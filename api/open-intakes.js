// api/open-intakes.js
// Returns "participants needing liability": one row per participant from
// Intake waivers that do not yet have a matching Liability.
// For now this endpoint *aggregates from recent Redis events* as a cache,
// which is instantaneous after the webhook fires.
// If cache is empty, it falls back to today-intakes to avoid blank UI.

export const config = { runtime: "nodejs" };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function redis(command, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error("Upstash env not set");
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Upstash ${command} ${r.status}: ${JSON.stringify(json)}`);
  if (json.error) throw new Error(json.error);
  return json.result;
}

function rowKey(wid, idx) { return `${wid || ""}#${idx ?? 0}`; }

export default async function handler(req, res) {
  try {
    // Build an in-memory set from the last N events:
    const N = 500;
    let rows = new Map();
    const len = Number(await redis("LLEN", "sw:events")) || 0;
    const start = Math.max(0, len - N);
    const items = len ? await redis("LRANGE", "sw:events", String(start), String(len - 1)) : [];

    const liabilities = [];
    for (const raw of items) {
      try {
        const evt = JSON.parse(raw);
        if (evt.type === "intake") {
          const d = evt.data || {};
          const { waiver_id, signed_on, intake_pdf_url, lightspeed_id, email } = d;
          const parts = Array.isArray(d.participants) ? d.participants : [];
          for (const p of parts) {
            const r = {
              waiver_id,
              signed_on,
              intake_pdf_url,
              lightspeed_id,
              email: p.email || email || "",
              first_name: p.first_name || "",
              last_name: p.last_name || "",
              age: p.age ?? null,
              weight_lb: p.weight_lb ?? null,
              height_in: p.height_in ?? null,
              skier_type: p.skier_type || "",
              participant_index: p.participant_index ?? 0
            };
            rows.set(rowKey(waiver_id, r.participant_index), r);
          }
        } else if (evt.type === "liability") {
          liabilities.push(evt.data || {});
        }
      } catch { /* ignore bad item */ }
    }

    // Drop rows that have matching liabilities (by ls tag, email, or name)
    for (const liab of liabilities) {
      const lsid = (liab.lightspeed_id || "").toString();
      const emails = new Set((liab.participants || []).map(p => (p.email || "").toLowerCase()));
      const nameKeys = new Set((liab.participants || []).map(p => `${(p.first_name||"").toLowerCase()}_${(p.last_name||"").toLowerCase()}`));
      for (const [k, r] of rows.entries()) {
        const byTag = lsid && r.lightspeed_id && String(r.lightspeed_id) === lsid;
        const byEmail = r.email && emails.has(String(r.email).toLowerCase());
        const byName = nameKeys.has(`${(r.first_name||"").toLowerCase()}_${(r.last_name||"").toLowerCase()}`);
        if (byTag || byEmail || byName) rows.delete(k);
      }
    }

    // If the cache is empty, defer to today-intakes to avoid blank UI
    const list = Array.from(rows.values()).sort((a,b) => new Date(b.signed_on) - new Date(a.signed_on));
    if (!list.length) {
      // proxy to today-intakes
      const r = await fetch(`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : ""}/api/today-intakes`).catch(() => null);
      if (r && r.ok) {
        const j = await r.json();
        return res.status(200).json({ rows: j.rows || [] });
      }
    }

    return res.status(200).json({ rows: list });
  } catch (e) {
    console.error("open-intakes error:", e);
    return res.status(200).json({ rows: [] }); // never hard-fail UI
  }
}
