// api/sw-webhook.js
// Smartwaiver v4 webhook receiver -> bumps a Redis "version" so clients refresh instantly.
// Works on Vercel (Edge not required). Supports both sw-api-key/x-api-key when we need to enrich.

const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const SW_V4 = `${SW_BASE}/v4`;

// Upstash Redis REST (required): UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
const RURL  = process.env.UPSTASH_REDIS_REST_URL;
const RTOK  = process.env.UPSTASH_REDIS_REST_TOKEN;

// Optional: if you also want to include a tiny payload (latest waiverId/type)
// it stores a few fields in Redis as plaintext JSON.
const LAST_EVENT_KEY = 'sw:last_event';
const VERSION_KEY    = 'sw:version';

function ok(res, body = 'ok') {
  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send(body);
}

async function redisCmd(cmd, ...args) {
  if (!RURL || !RTOK) return null;
  const url = `${RURL}/${cmd}/${args.map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${RTOK}` }, cache: 'no-store' });
  if (!r.ok) throw new Error(`Redis ${cmd} ${r.status}`);
  return r.json().catch(() => ({}));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    // Webhook body (Smartwaiver v4 sends JSON including waiverId & templateId)
    const bodyText = req.body && typeof req.body === 'string' ? req.body : null;
    const json = bodyText ? JSON.parse(bodyText) : (typeof req.body === 'object' ? req.body : await req.json().catch(() => ({})));

    // We don’t block on enrichment — the goal is to be FAST
    const waiverId    = json?.waiverId || json?.waiver?.waiverId || json?.id || '';
    const templateId  = json?.templateId || json?.waiver?.templateId || '';
    const eventType   = (json?.type || json?.event || 'waiver').toString();

    // Store a tiny “last event” crumb (optional, helps with debugging)
    if (RURL && RTOK) {
      const payload = JSON.stringify({
        ts: new Date().toISOString(),
        eventType,
        waiverId,
        templateId,
      });
      await redisCmd('SET', LAST_EVENT_KEY, payload);
      await redisCmd('INCR', VERSION_KEY); // <<< bump version so SSE tick fires
    }

    return ok(res);
  } catch (e) {
    console.error('sw-webhook error', e);
    return res.status(200).send('ok'); // Always 200 so Smartwaiver doesn’t retry storm
  }
}
