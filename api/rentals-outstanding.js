const { requireStaff } = require('../lib/staff-auth');
// api/rentals-outstanding.js
const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");
const { performance } = require('node:perf_hooks');

function parseISODateOnly(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

module.exports = async (req, res) => {
  const started = performance.now();
  res.setHeader('Cache-Control', 'private, no-store');
  try { await requireStaff(req); } catch (error) { return res.status(error.status || 503).json({ error:error.message }); }
  const authorized = performance.now();
  let schemaStarted, schemaFinished, queryStarted;
  function timing() {
    const finished = performance.now();
    res.setHeader('Server-Timing', `staff;dur=${(authorized - started).toFixed(1)}, schema;dur=${(schemaStarted === undefined ? 0 : (schemaFinished ?? finished) - schemaStarted).toFixed(1)}, database;dur=${(queryStarted === undefined ? 0 : finished - queryStarted).toFixed(1)}`);
    // Fixed operation and numeric durations only; never log query/rows/auth/error.
    try { console.info('rental_timing', 'returns', JSON.stringify({
      staff_ms: Math.round((authorized - started) * 10) / 10,
      schema_ms: Math.round((schemaStarted === undefined ? 0 : (schemaFinished ?? finished) - schemaStarted) * 10) / 10,
      database_ms: Math.round((queryStarted === undefined ? 0 : finished - queryStarted) * 10) / 10,
      total_ms: Math.round((finished - started) * 10) / 10,
    })); } catch {}
  }

  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    schemaStarted = performance.now();
    await ensureSchema();
    schemaFinished = performance.now();

    const name = (req.query.name || "").toString().trim();
    const startDate = parseISODateOnly((req.query.startDate || "").toString().trim());
    const endDate = parseISODateOnly((req.query.endDate || "").toString().trim());

    // NEW: status filter
    const statusRaw = (req.query.status || "OUT").toString().trim().toUpperCase();
    const status = (statusRaw === "ALL" || statusRaw === "OUT" || statusRaw === "RETURNED") ? statusRaw : "OUT";

    const pool = getPool();

    const where = [];
    const params = [];
    let p = 1;

    if (status !== "ALL") {
      where.push(`status = $${p}`);
      params.push(status);
      p += 1;
    }

    if (startDate) {
      where.push(`signed_at >= $${p}::timestamptz`);
      params.push(`${startDate}T00:00:00Z`);
      p += 1;
    }

    if (endDate) {
      where.push(`signed_at < ($${p}::timestamptz + interval '1 day')`);
      params.push(`${endDate}T00:00:00Z`);
      p += 1;
    }

    if (name) {
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
      SELECT
        id, waiver_id, template_id,
        signer_first, signer_last,
        signed_at, status, returned_at,
        COALESCE(note, '') AS note,
        COALESCE(phone, '') AS phone
      FROM rental_agreements
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY signed_at DESC
      LIMIT 500;
    `;

    // Always read current rows after authorization and schema readiness.
    queryStarted = performance.now();
    const { rows } = await pool.query(sql, params);
    timing();

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rentals: rows }));
  } catch (err) {
    timing();
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message || "Server error" }));
  }
};
