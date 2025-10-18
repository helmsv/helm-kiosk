// api/hidden-toggle.js  (Node / pages API-style)
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const HIDDEN_KEY = process.env.REDIS_HIDDEN_SET_KEY || "tech:hidden:v1";
const TICK_KEY   = process.env.REDIS_TICK_KEY || "tech:version";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  try {
    // In Node functions, req.body can be an object OR a string depending on framework config.
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const key  = String(body?.key || "").trim();
    const hide = Boolean(body?.hide);
    if (!key) return res.status(400).json({ error: "Missing key" });

    let changed = false;
    if (hide) {
      const r = await redis.sadd(HIDDEN_KEY, key);
      changed = r === 1;
    } else {
      const r = await redis.srem(HIDDEN_KEY, key);
      changed = r === 1;
    }

    // nudge everyone via your SSE "tick"
    try { await redis.incr(TICK_KEY); } catch {}

    res.status(200).json({ ok: true, hidden: hide, key, changed });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
