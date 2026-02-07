// api/returns-export.js
const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");

function parseISODateOnly(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
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

    const from = parseISODateOnly((req.query.from || "").toString().trim());
    const to = parseISODateOnly((req.query.to || "").toString().trim());

    const where = [];
    const params = [];
    let p = 1;

    if (from) {
      where.push(`e.returned_at >= $${p}::timestamptz`);
      params.push(`${from}T00:00:00Z`);
      p += 1;
    }
    if (to) {
      // inclusive end date: add 1 day exclusive
      where.push(`e.returned_at < ($${p}::timestamptz + interval '1 day')`);
      params.push(`${to}T00:00:00Z`);
      p += 1;
    }

    const pool = getPool();
    const sql = `
      SELECT
        e.id AS return_event_id,
        e.returned_at,
        e.returned_by,
        e.notes,
        e.exported_at,
        a.id AS agreement_id,
        a.signer_first,
        a.signer_last,
        a.signed_at
      FROM return_events e
      JOIN rental_agreements a ON a.id = e.agreement_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.returned_at DESC
      LIMIT 5000;
    `;

    const { rows } = await pool.query(sql, params);

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="returns-export.csv"');

    const header = [
      "return_event_id",
      "returned_at",
      "returned_by",
      "notes",
      "exported_at",
      "agreement_id",
      "signer_first",
      "signer_last",
      "signed_at"
    ];
    res.write(header.join(",") + "\n");

    for (const r of rows) {
      const line = [
        r.return_event_id,
        r.returned_at,
        r.returned_by,
        r.notes,
        r.exported_at,
        r.agreement_id,
        r.signer_first,
        r.signer_last,
        r.signed_at
      ].map(csvEscape);
      res.write(line.join(",") + "\n");
    }
    res.end();
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message || "Server error" }));
  }
};
