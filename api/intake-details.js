const { request } = require('../lib/smartwaiver');
const { requireStaff } = require('../lib/staff-auth');
const { normalizeIntake } = require('../lib/intake-normalize');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });
  try { await requireStaff(req); } catch (error) { return res.status(error.status || 503).json({ error:error.message, participants:[] }); }
  const id = req.query?.waiverId ?? req.query?.waiverID ?? req.query?.id ?? req.query?.swid;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return res.status(400).json({ error: 'A valid intake waiver ID is required.', participants: [] });
  const templateId = process.env.INTAKE_WAIVER_ID || process.env.INTAKE_TEMPLATE_ID;
  if (!templateId) return res.status(503).json({ error: 'Intake template is not configured.', participants: [] });
  try {
    const data = await request(`/waivers/${encodeURIComponent(id)}`);
    const waiver = data?.waiver;
    if (!waiver || waiver.waiverId !== id || waiver.templateId !== templateId) return res.status(502).json({ error: 'The returned waiver does not match the selected intake.', participants: [] });
    const normalized = normalizeIntake(waiver);
    // The technician calculator needs age, not a public raw birth-date response.
    const participants = normalized.participants.map(({ date_of_birth, ...person }) => person);
    return res.status(200).json({ ...normalized, participants });
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.message || 'Unable to load the intake.', participants: [] });
  }
};
