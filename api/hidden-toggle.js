// api/hidden-toggle.js
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const HIDDEN_KEY = process.env.REDIS_HIDDEN_SET_KEY || "tech:hidden:v1";
const TICK_KEY = process.env.REDIS_TICK_KEY || "tech:version";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  res.setHeader("Cache-Control", "no-store");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const key = String(body?.key || "").trim();
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

    // Nudge your SSE to “tick” so all clients refresh promptly
    try { await redis.incr(TICK_KEY); } catch {}

    return res.status(200).json({ ok: true, hidden: hide, key, changed });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
