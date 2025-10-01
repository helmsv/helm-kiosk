// api/waiver-pdf.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;

function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  return t.replace(/[^\x20-\x7E]+/g, '');
}

module.exports = async (req, res) => {
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const waiverId = req.query.waiverId || req.query.id;
    if (!key || !waiverId) return res.status(400).send('Missing key or waiverId');

    const url = `${API_BASE}/waivers/${encodeURIComponent(waiverId)}`;
    const headers = { Accept: 'application/json', 'sw-api-key': key };
    let r = await fetch(url, { headers, cache: 'no-store' });
    if (r.status === 401) {
      r = await fetch(url, { headers: { ...headers, 'x-api-key': key }, cache: 'no-store' });
    }
    if (!r.ok) {
      const t = await r.text().catch(()=> '');
      return res.status(502).send(`Smartwaiver error ${r.status}: ${t.slice(0, 400)}`);
    }
    const payload = await r.json();
    const pdf = payload?.waiver?.pdf || payload?.pdf;
    if (!pdf) return res.status(404).send('PDF not available for this waiver');
    // Redirect the browser to Smartwaiver’s PDF URL
    res.writeHead(302, { Location: pdf });
    res.end();
  } catch (e) {
    res.status(500).send(String(e));
  }
};
