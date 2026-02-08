// api/rentals-note.js
const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error("Invalid JSON body")); }
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
    const note = body.note == null ? "" : String(body.note);

    if (!Number.isFinite(agreementId) || agreementId <= 0) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "agreementId must be a positive number" }));
      return;
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `
      UPDATE rental_agreements
      SET note = $2
      WHERE id = $1
      RETURNING id, note;
      `,
      [agreementId, note]
    );

    if (!rows.length) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Agreement not found" }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ agreement: rows[0] }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message || "Server error" }));
  }
};
