// api/stream.js
// Simple SSE that emits: ping (keepalive) and tick (when sw:version changes in Redis)

export const config = {
  runtime: 'nodejs', // keep it on Node to avoid Edge timeouts for long SSE
};

const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN;
const VERSION_KEY = 'sw:version';

async function redisGetVersion() {
  if (!RURL || !RTOK) return 0;
  const url = `${RURL}/GET/${encodeURIComponent(VERSION_KEY)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${RTOK}` }, cache: 'no-store' });
  if (!r.ok) return 0;
  const j = await r.json().catch(() => ({}));
  const v = Number(j?.result ?? j?.value ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (event, data = '') => {
    res.write(`event: ${event}\n`);
    if (data) res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n`);
    res.write('\n');
  };

  // Initial state
  let last = await redisGetVersion().catch(() => 0);
  send('ping', 'hello'); // lets clients flip UI to "SSE: ok"

  // Emit a tick immediately on connect so pages refresh once
  send('tick', JSON.stringify({ version: last, reason: 'connect' }));

  const pingIv = setInterval(() => send('ping', Date.now().toString()), 15000);
  const pollIv = setInterval(async () => {
    try {
      const v = await redisGetVersion();
      if (v > last) {
        last = v;
        send('tick', JSON.stringify({ version: v, reason: 'bump' }));
      }
    } catch {
      // on error, do nothing; next tick will try again
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(pingIv);
    clearInterval(pollIv);
    try { res.end(); } catch {}
  });
}
