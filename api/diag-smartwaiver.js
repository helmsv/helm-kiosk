// api/diag-smartwaiver.js
const RAW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com';

// sanitize key (strip quotes/controls/whitespace)
function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  return t.replace(/[^\x20-\x7E]+/g, '');
}

// build candidate URLs for both styles: /v4/... and /...
function candidates(path) {
  const base = RAW_BASE.replace(/\/+$/, '');
  const withV4 = `${base}/v4${path}`;
  const noV4   = `${base}${path}`;
  // If user already set base that ends with /v4, prefer that first.
  if (/\/v4$/.test(base)) return [`${base}${path}`, noV4];
  return [withV4, noV4];
}

async function tryOnce(url, hdrs) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...hdrs }, cache: 'no-store' });
  const body = await r.text().catch(() => '');
  return { url, status: r.status, body: body.slice(0, 500), headersUsed: Object.keys(hdrs) };
}

module.exports = async (req, res) => {
  try {
    const raw = process.env.SW_API_KEY || '';
    const key = cleanKey(raw);

    const urls = candidates('/waivers?limit=1');
    const headerVariants = [
      { 'x-api-key': key },
      { 'X-API-Key': key },
      { 'sw-api-key': key },
      { 'x-api-key': key, 'X-API-Key': key }, // belt & suspenders
    ];

    const probes = [];
    for (const url of urls) {
      for (const hv of headerVariants) {
        // eslint-disable-next-line no-await-in-loop
        probes.push(await tryOnce(url, hv));
      }
    }

    res.status(200).json({
      base_env: RAW_BASE,
      resolved_base_note: 'We tried both /v4 and non-versioned paths against your SW_BASE_URL.',
      has_env_key: Boolean(raw),
      key_len: key ? key.length : 0,
      key_tail: key ? key.slice(-6) : null,
      probes,
      success_any: probes.some(p => p.status >= 200 && p.status < 300),
    });
  } catch (e) {
    res.status(200).json({ error: String(e) });
  }
};
