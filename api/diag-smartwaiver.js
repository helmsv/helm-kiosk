// api/diag-smartwaiver.js
const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

function cleanKey(v) {
  if (!v) return '';
  const t = String(v).trim();
  // remove accidental wrapping quotes some dashboards paste in
  const m = t.match(/^"(.*)"$/);
  return m ? m[1] : t;
}

async function sw(path) {
  const key = cleanKey(process.env.SW_API_KEY);
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: {
      // v4 uses API Gateway key header; send both just in case
      'x-api-key': key,
      'X-SW-API-KEY': key,
      'Accept': 'application/json'
    },
    cache: 'no-store'
  });
  const text = await r.text();
  return { status: r.status, body: text };
}

module.exports = async (req, res) => {
  try {
    const hasKey = !!process.env.SW_API_KEY;
    const keyTail = cleanKey(process.env.SW_API_KEY).slice(-6);

    // Lightweight list probe (works when key is good)
    const probe = await sw('/waivers?limit=1');

    res.status(200).json({
      has_key: hasKey,
      key_tail: keyTail || null,
      base: SW_BASE,
      probe_list_waivers: probe
    });
  } catch (e) {
    res.status(200).json({ error: String(e) });
  }
};
