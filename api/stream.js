// api/stream.js
// Stable SSE for Vercel Node runtime. Heartbeats every 10s.
// Also polls Upstash Redis list "sw:events" for new items pushed by sw-webhook.

export const config = { runtime: "nodejs" };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// Minimal Upstash REST helper
async function redis(command, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error("Upstash env not set");
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  if (!r.ok) throw new Error(`Upstash ${command} ${r.status}`);
  const json = await r.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let isClosed = false;
  req.on("close", () => { isClosed = true; });

  // Send initial ping quickly so the client flips to "ok"
  writeEvent(res, "ping", { t: Date.now() });

  // Start at the current tail so we only stream *new* events
  let cursor = 0;
  try {
    const len = await redis("LLEN", "sw:events");
    cursor = Number(len) || 0;
  } catch {
    // ignore; we'll still heartbeat
  }

  // Heartbeat every 10s + poll events every 1s
  const heartbeat = setInterval(() => {
    if (isClosed) return;
    writeEvent(res, "ping", { t: Date.now() });
  }, 10000);

  const poll = setInterval(async () => {
    if (isClosed) return;

    try {
      // Read everything from cursor to end (LRANGE start..-1)
      const len = Number(await redis("LLEN", "sw:events")) || 0;
      if (len > cursor) {
        const items = await redis("LRANGE", "sw:events", String(cursor), String(len - 1));
        for (const raw of items) {
          try {
            const evt = JSON.parse(raw);
            if (evt?.type === "intake") writeEvent(res, "intake", evt);
            else if (evt?.type === "liability") writeEvent(res, "liability", evt);
          } catch { /* bad payload ignored */ }
        }
        cursor = len;
      }
    } catch {
      // If Redis is unavailable, keep heartbeating — client will still show rows via poll fallback
    }
  }, 1000);

  // Safety: end timers when client disconnects
  const cleanup = () => { clearInterval(heartbeat); clearInterval(poll); };
  req.on("close", cleanup);
  req.on("end", cleanup);
}
