import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { first_name, last_name, email } = await req.json?.() || req.body || {};
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const base = process.env.LS_BASE_URL;
    const token = process.env.LS_TOKEN;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Just return sample object for now
    const out = {
      match_quality: 'new',
      first_name, last_name, email,
      lightspeed_id: 'demo123',
    };

    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(200).json({ match_quality: 'new', first_name: req.body?.first_name, last_name: req.body?.last_name, email: req.body?.email });
  }
}