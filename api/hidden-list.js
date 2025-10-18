// api/hidden-list.js
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const HIDDEN_KEY = process.env.REDIS_HIDDEN_SET_KEY || "tech:hidden:v1";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  res.setHeader("Cache-Control", "no-store");
  try {
    const keys = await redis.smembers(HIDDEN_KEY);
    return res.status(200).json({ keys: Array.isArray(keys) ? keys : [] });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
