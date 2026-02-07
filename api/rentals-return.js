// api/rentals-return.js
const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  try {
    await ensureSchema();

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const body = await readJson(req);
    const agreementId = Number(body.agreementId);

    if (!Number.isFinite(agreementId) || agreementId <= 0) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "agreementId must be a positive number" }));
      return;
    }

    const returnedBy = body.returnedBy ? String(body.returnedBy).slice(0, 200) : null;
    const notes = body.notes ? String(body.notes).slice(0, 1000) : null;

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Ensure agreement exists and is still OUT
      const a = await client.query(
        `SELECT id, status FROM rental_agreements WHERE id = $1 FOR UPDATE;`,
        [agreementId]
      );

      if (a.rowCount === 0) {
        await client.query("ROLLBACK");
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Agreement not found" }));
        return;
      }

      if (a.rows[0].status !== "OUT") {
        await client.query("ROLLBACK");
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Agreement is not outstanding" }));
        return;
      }

      // Mark returned
      const updated = await client.query(
        `UPDATE rental_agreements
         SET status = 'RETURNED', returned_at = NOW()
         WHERE id = $1
         RETURNING id, signer_first, signer_last, signed_at, status, returned_at;`,
        [agreementId]
      );

      // Log return event
      const ev = await client.query(
        `INSERT INTO return_events (agreement_id, returned_by, notes)
         VALUES ($1, $2, $3)
         RETURNING id, agreement_id, returned_at, returned_by, notes, exported_at;`,
        [agreementId, returnedBy, notes]
      );

      await client.query("COMMIT");

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ agreement: updated.rows[0], event: ev.rows[0] }));
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message || "Server error" }));
  }
};
