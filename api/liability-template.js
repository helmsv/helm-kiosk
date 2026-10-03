// Staff-authorized manual recovery. No Smartwaiver API or signed record reads.
const { requireStaff } = require('../lib/staff-auth');
const VERIFIED_TEMPLATE = 'a2njtmnzxs7icea9mdxff6';
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST.' }); }
  const headers = req.headers || {};
  if (headers.origin) {
    try { if (new URL(headers.origin).host !== headers.host) return res.status(403).json({ error: 'Invalid origin.' }); }
    catch { return res.status(403).json({ error: 'Invalid origin.' }); }
  }
  try {
    await requireStaff(req);
    const configured = process.env.LIABILITY_WAIVER_ID || process.env.LIABILITY_TEMPLATE_ID || process.env.SW_TEMPLATE_LIABILITY;
    if (configured !== VERIFIED_TEMPLATE) return res.status(503).json({ error: 'The blank liability template has not been verified for this configuration.' });
    // Intentionally no customer identity, source tag, query string, or DIN values.
    return res.status(200).json({ url: `https://www.smartwaiver.com/w/${VERIFIED_TEMPLATE}/kiosk/`, blank: true });
  } catch (error) {
    const status = [401, 403, 503].includes(error.status) ? error.status : 503;
    return res.status(status).json({ error: [401, 403, 503].includes(error.status) ? error.message : 'Staff sign-in could not be verified.' });
  }
};
