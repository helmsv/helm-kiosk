// api/rentals-outstanding.js
const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");

function parseISODateOnly(s) {
  // Expect YYYY-MM-DD
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

module.exports = async (req, res) => {
  try {
    await ensureSchema();

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const name = (req.query.name || "").toString().trim();
    const date = parseISODateOnly((req.query.date || "").toString().trim());

    const pool = getPool();

    const where = ["status = 'OUT'"];
    const params = [];
    let p = 1;

    if (date) {
      // signed_at within the local date (treat date as UTC day to keep consistent; adjust later if you prefer store timezone)
      where.push(`signed_at >= $${p}::timestamptz AND signed_at < ($${p}::timestamptz + interval '1 day')`);
      params.push(`${date}T00:00:00Z`);
      p += 1;
    }

    if (name) {
      // Match first, last, or full name (case-insensitive)
      const n = `%${name.replace(/\s+/g, " ").toLowerCase()}%`;
      where.push(`(
        LOWER(signer_first) LIKE $${p}
        OR LOWER(signer_last) LIKE $${p}
        OR LOWER(signer_first || ' ' || signer_last) LIKE $${p}
      )`);
      params.push(n);
      p += 1;
    }

    const sql = `
      SELECT id, signer_first, signer_last, signed_at, status
      FROM rental_agreements
      WHERE ${where.join(" AND ")}
      ORDER BY signed_at DESC
      LIMIT 200;
    `;

    const { rows } = await pool.query(sql, params);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rentals: rows }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message || "Server error" }));
  }
};
