// api/hidden.js
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const SET_KEY = "helm:hidden:set";

async function upstash(path) {
  const u = `${REDIS_URL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, cache: 'no-store' });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
}
const enc = s => encodeURIComponent(String(s));

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  try {
    if (!REDIS_URL || !REDIS_TOKEN) {
      return res.status(200).json({ ok: true, keys: [] });
    }

    if (req.method === 'GET') {
      const j = await upstash(`smembers/${enc(SET_KEY)}`);
      return res.status(200).json({ ok: true, keys: Array.isArray(j.result) ? j.result : [] });
    }

    if (req.method === 'POST') {
      const { key, hide, value } = req.body || {};
      if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
      const doHide = typeof hide === 'boolean' ? hide : (String(value).toLowerCase() === '1' || String(value).toLowerCase() === 'true');

      if (doHide) {
        await upstash(`sadd/${enc(SET_KEY)}/${enc(key)}`);
      } else {
        await upstash(`srem/${enc(SET_KEY)}/${enc(key)}`);
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
