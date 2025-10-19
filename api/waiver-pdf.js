// api/waiver-pdf.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;
function cleanKey(v){ return String(v || '').trim().replace(/[^\x20-\x7E]+/g, ''); }

export default async function handler(req, res) {
  try {
    const waiverId = String(req.query.waiverId || '').trim();
    const key = cleanKey(process.env.SW_API_KEY);
    if (!waiverId || !key) {
      return res.status(400).json({ error: 'Missing waiverId or SW_API_KEY' });
    }
    const url = `${API_BASE}/waivers/${encodeURIComponent(waiverId)}/pdf`;
    const baseHeaders = { Accept: 'application/pdf' };

    // try both header names (some accounts expect one vs the other)
    let r = await fetch(url, { headers: { ...baseHeaders, 'sw-api-key': key }, cache: 'no-store' });
    if (r.status === 401) {
      r = await fetch(url, { headers: { ...baseHeaders, 'x-api-key': key }, cache: 'no-store' });
    }
    if (!r.ok) {
      const txt = await r.text().catch(()=> '');
      return res.status(r.status).send(txt || 'PDF fetch failed');
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="waiver-${waiverId}.pdf"`);
    res.status(200).send(buf);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
}
