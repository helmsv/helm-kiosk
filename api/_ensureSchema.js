// api/_ensureSchema.js
const { getPool } = require("./_db");

let ensured = false;

async function ensureSchema() {
  if (ensured) return;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Agreements table (signed rentals)
    await client.query(`
      CREATE TABLE IF NOT EXISTS rental_agreements (
        id BIGSERIAL PRIMARY KEY,
        signer_first TEXT NOT NULL,
        signer_last  TEXT NOT NULL,
        signed_at    TIMESTAMPTZ NOT NULL,
        status       TEXT NOT NULL DEFAULT 'OUT', -- OUT or RETURNED
        returned_at  TIMESTAMPTZ NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
    ALTER TABLE rental_agreements
       ADD COLUMN IF NOT EXISTS note text,
       ADD COLUMN IF NOT EXISTS phone text;
  `);
    
    // Return log (events)
    await client.query(`
      CREATE TABLE IF NOT EXISTS return_events (
        id BIGSERIAL PRIMARY KEY,
        agreement_id BIGINT NOT NULL REFERENCES rental_agreements(id) ON DELETE CASCADE,
        returned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        returned_by  TEXT NULL,
        notes        TEXT NULL,
        exported_at  TIMESTAMPTZ NULL
      );
    `);

    // inside ensureSchema(), after your table creation:
    await pool.query(`
      ALTER TABLE rental_agreements
        ADD COLUMN IF NOT EXISTS waiver_id text,
        ADD COLUMN IF NOT EXISTS template_id text;
    
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'rental_agreements_waiver_id_unique'
        ) THEN
          ALTER TABLE rental_agreements
            ADD CONSTRAINT rental_agreements_waiver_id_unique UNIQUE (waiver_id);
        END IF;
      END$$;
    `);
    
    // Helpful indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agreements_status ON rental_agreements(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agreements_signed_at ON rental_agreements(signed_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_returned_at ON return_events(returned_at);`);

    await client.query("COMMIT");
    ensured = true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { ensureSchema };
