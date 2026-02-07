// api/_db.js
const { Pool } = require("pg");

// Reuse pool across invocations where possible
let _pool;

function getPool() {
  if (_pool) return _pool;

  const connectionString =
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "Missing Postgres connection string. Set POSTGRES_URL (or DATABASE_URL) in Vercel env."
    );
  }

  _pool = new Pool({
    connectionString,
    // SSL is commonly required on hosted Postgres; keep flexible.
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
  });

  return _pool;
}

module.exports = { getPool };
