// api/hidden.js
const HIDDEN_SET_KEY = process.env.HIDDEN_SET_KEY || 'helm:hidden:v1';

// Support both Upstash (recommended) and Vercel KV env names
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  '';
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  '';

function cleanKey(k) {
  return String(k || '').trim().slice(0, 200);
}

async function rpipe(cmds) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('Missing Upstash Redis env (URL/TOKEN)');
  }
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmds),
    cache: 'no-store',
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Upstash ${r.status} ${t.slice(0, 300)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const method = req.method || 'GET';

    // GET -> list hidden keys
    if (method === 'GET') {
      const data = await rpipe([['SMEMBERS', HIDDEN_SET_KEY]]);
      const members = Array.isArray(data?.[0]?.result) ? data[0].result : [];
      return res.status(200).json({ ok: true, hidden: members });
    }

    if (method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    // POST -> toggle/hide/show
    const body = (await req.json().catch(() => ({}))) || {};
    const itemKey = cleanKey(body.key);
    const action = String(body.action || 'toggle').toLowerCase();

    if (!itemKey) {
      return res.status(200).json({ ok: false, error: 'Missing key' });
    }

    if (action === 'hide') {
      await rpipe([['SADD', HIDDEN_SET_KEY, itemKey]]);
    } else if (action === 'show') {
      await rpipe([['SREM', HIDDEN_SET_KEY, itemKey]]);
    } else {
      // toggle
      const out = await rpipe([['SISMEMBER', HIDDEN_SET_KEY, itemKey]]);
      const isHidden = !!out?.[0]?.result;
      if (isHidden) {
        await rpipe([['SREM', HIDDEN_SET_KEY, itemKey]]);
      } else {
        await rpipe([['SADD', HIDDEN_SET_KEY, itemKey]]);
      }
    }

    // Optional: bump version & publish tick so dashboards refresh quickly
    let ver = 0;
    try {
      const inc = await rpipe([['INCR', 'helm:version']]);
      ver = inc?.[0]?.result || 0;
      await rpipe([['PUBLISH', 'helm:tick', String(ver)]]);
    } catch {
      // Non-fatal
    }

    const st = await rpipe([['SISMEMBER', HIDDEN_SET_KEY, itemKey]]);
    const hidden = !!st?.[0]?.result;
    return res.status(200).json({ ok: true, key: itemKey, hidden, version: ver });
  } catch (e) {
    // Return 200 with an error payload so the UI shows a friendly message
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
