// api/_ensureSchema.js
const { getPool } = require("./_db");

let ensured = false;
let ensuring;

// Check metadata only. Complete databases avoid DDL locks and extra connections
// on cold functions; no rental rows or staff authorization are cached.
const SCHEMA_READY_SQL = `
  SELECT NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('rental_agreements','id'), ('rental_agreements','signer_first'),
      ('rental_agreements','signer_last'), ('rental_agreements','signed_at'),
      ('rental_agreements','status'), ('rental_agreements','returned_at'),
      ('rental_agreements','created_at'), ('rental_agreements','note'),
      ('rental_agreements','phone'), ('rental_agreements','waiver_id'),
      ('rental_agreements','template_id'), ('return_events','id'),
      ('return_events','agreement_id'), ('return_events','returned_at'),
      ('return_events','returned_by'), ('return_events','notes'),
      ('return_events','exported_at')
    ) AS required(relation_name, column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(required.relation_name)
        AND a.attname = required.column_name AND a.attnum > 0 AND NOT a.attisdropped
    )
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rental_agreements_waiver_id_unique'
      AND conrelid = to_regclass('rental_agreements') AND contype = 'u' AND convalidated
  ) AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('rental_agreements','idx_agreements_status'),
      ('rental_agreements','idx_agreements_signed_at'),
      ('return_events','idx_events_returned_at')
    ) AS required(relation_name, index_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_index WHERE indexrelid = to_regclass(required.index_name)
        AND indrelid = to_regclass(required.relation_name) AND indisvalid
    )
  ) AS ready;
`;

async function ensureSchema() {
  if (ensured) return;
  if (!ensuring) ensuring = initializeSchema().then(() => { ensured = true; }).finally(() => { ensuring = undefined; });
  return ensuring;
}

async function initializeSchema() {
  const pool = getPool();
  const { rows } = await pool.query(SCHEMA_READY_SQL);
  if (rows[0]?.ready === true) return;
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

    await client.query(`
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
    await client.query(`
      ALTER TABLE rental_agreements
        ADD COLUMN IF NOT EXISTS waiver_id text,
        ADD COLUMN IF NOT EXISTS template_id text;
    
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'rental_agreements_waiver_id_unique'
            AND conrelid = 'rental_agreements'::regclass
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
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { ensureSchema };
