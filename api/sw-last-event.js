// api/sw-last-event.js
const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN;
const LAST_EVENT_KEY = "sw:last_event";

export default async function handler(req, res) {
  try {
    if (!RURL || !RTOK) {
      return res.status(500).json({ error: "Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN" });
    }
    const url = `${RURL}/GET/${encodeURIComponent(LAST_EVENT_KEY)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${RTOK}` }, cache: "no-store" });
    const j = await r.json();
    // Upstash REST returns { result: "<string>" } for GET
    const raw = j?.result || "";
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
    res.status(200).json({ raw, parsed });
  } catch (e) {
    res.status(500).json({ error: e.message || "error" });
  }
}
