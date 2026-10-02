const { requireStaff } = require('../lib/staff-auth');
// api/rentals-latest.js
const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  try { await requireStaff(req); } catch (error) { return res.status(error.status || 503).json({ error:error.message }); }

  try {
    await ensureSchema();
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT id, waiver_id, template_id, signer_first, signer_last, signed_at, status
      FROM rental_agreements
      ORDER BY signed_at DESC
      LIMIT 20;
    `);
    res.status(200).json({ rentals: rows });
  } catch (e) {
    res.status(500).json({ error: e.message || "error" });
  }
}
