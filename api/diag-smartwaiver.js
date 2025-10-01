// api/diag-smartwaiver.js
const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  // strip accidental wrapping quotes
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  // strip non-printable/control characters
  t = t.replace(/[^\x20-\x7E]+/g, '');
  return t;
}

async function tryCall(path, hdrs) {
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      ...hdrs,
    },
    cache: 'no-store',
  });
  const text = await r.text().catch(() => '');
  return { status: r.status, body: text.slice(0, 400), headersUsed: Object.keys(hdrs) };
}

module.exports = async (req, res) => {
  try {
    const raw = process.env.SW_API_KEY || '';
    const key = cleanKey(raw);

    const probes = [];

    // Most implementations accept *one* of these; try all and report:
    // A) canonical (lowercase)
    probes.push(await tryCall('/waivers?limit=1', { 'x-api-key': key }));
    // B) canonical (capitalized)
    probes.push(await tryCall('/waivers?limit=1', { 'X-API-Key': key }));
    // C) legacy custom header seen in older examples
    probes.push(await tryCall('/waivers?limit=1', { 'X-SW-API-KEY': key }));
    // D) send BOTH common forms at once (some gateways only read first)
    probes.push(await tryCall('/waivers?limit=1', { 'x-api-key': key, 'X-API-Key': key }));

    res.status(200).json({
      base: SW_BASE,
      has_env_key: Boolean(raw),
      key_len: key ? key.length : 0,
      key_tail: key ? key.slice(-6) : null,
      note: 'At least one probe must return 200/2xx to confirm auth. 401=unauthorized, 403=forbidden.',
      probes,
    });
  } catch (e) {
    res.status(200).json({ error: String(e) });
  }
};
