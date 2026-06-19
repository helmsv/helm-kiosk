// api/sw-webhook.js
// Smartwaiver webhook receiver -> bumps Redis version so clients refresh instantly.
// Additionally: fetches full waiver by ID and upserts into Postgres as outstanding rental agreement.
//
// Smartwaiver webhook payload commonly includes only:
// - unique_id (waiver id)
// - event (what happened)
// so we MUST enrich via API to get templateId + signer fields.  [oai_citation:1‡Smartwaiver](https://support.smartwaiver.com/hc/en-us/articles/360057049551-What-are-Webhooks)

const SW_BASE = (process.env.SW_BASE_URL || "https://api.smartwaiver.com").replace(/\/+$/, "");
const SW_V4 = `${SW_BASE}/v4`;

const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");

// Upstash Redis REST (optional but used in your app): UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN;

const LAST_EVENT_KEY = "sw:last_event";
const VERSION_KEY = "sw:version";

// Template ID to treat as “rental/outstanding”
const LIABILITY_WAIVER_ID = (process.env.LIABILITY_WAIVER_ID || "").trim();

// Smartwaiver API key for enrichment (you already used this for backfill)
const SW_API_KEY = process.env.SW_API_KEY || process.env.SMARTWAIVER_API_KEY || "";

function ok(res, body = "ok") {
  res.setHeader("Content-Type", "text/plain");
  return res.status(200).send(body);
}

async function redisCmd(cmd, ...args) {
  if (!RURL || !RTOK) return null;
  const url = `${RURL}/${cmd}/${args.map(encodeURIComponent).join("/")}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${RTOK}` }, cache: "no-store" });
  if (!r.ok) throw new Error(`Redis ${cmd} ${r.status}`);
  return r.json().catch(() => ({}));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const raw = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function fetchWaiverById(waiverId) {
  if (!SW_API_KEY) return null;

  const url = `${SW_V4}/waivers/${encodeURIComponent(String(waiverId))}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${SW_API_KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// Phone lives on a participant (adult signers) or on the guardian (minors), not top-level.
function extractPhone(full) {
  if (!full || typeof full !== "object") return "";
  const participants = Array.isArray(full.participants) ? full.participants : [];
  for (const p of participants) {
    if (p && p.phone && String(p.phone).trim()) return String(p.phone).trim();
  }
  if (full.guardian && full.guardian.phone && String(full.guardian.phone).trim()) {
    return String(full.guardian.phone).trim();
  }
  return "";
}

async function upsertOutstandingAgreementFromWaiver(waiver) {
  const waiverId = waiver.waiverId ? String(waiver.waiverId) : null;
  if (!waiverId) return { upserted: false, reason: "missing waiverId" };

  const templateId = waiver.templateId ? String(waiver.templateId) : null;

  // Only ingest the rental template if configured
  if (LIABILITY_WAIVER_ID && templateId && templateId !== LIABILITY_WAIVER_ID) {
    return { upserted: false, reason: "template filtered" };
  }

  const signerFirst = (waiver.firstName || waiver.signerFirstName || "").trim();
  const signerLast = (waiver.lastName || waiver.signerLastName || "").trim();
  // Phone lives on a participant (adult signers) or the guardian (minors), not top-level.
  const phone = extractPhone(waiver);
  const signedAtRaw = waiver.createdOn || waiver.createdAt || waiver.signedAt || null;

  if (!signerFirst && !signerLast) {
    return { upserted: false, reason: "missing signer name" };
  }

  await ensureSchema();
  const pool = getPool();

  const { rows } = await pool.query(
    `
    INSERT INTO rental_agreements
      (waiver_id, template_id, signer_first, signer_last, phone, signed_at, status)
    VALUES
      ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7)
    ON CONFLICT (waiver_id) DO UPDATE
      SET template_id  = EXCLUDED.template_id,
          signer_first = EXCLUDED.signer_first,
          signer_last  = EXCLUDED.signer_last,
          phone        = EXCLUDED.phone,
          signed_at    = EXCLUDED.signed_at,
          status       = CASE
                        WHEN rental_agreements.status = $8 THEN $8
                        ELSE $7
                      END
    RETURNING id, waiver_id, status;
    `,
    [waiverId, templateId, signerFirst, signerLast, phone || null, signedAtRaw, 'OUT', 'RETURNED']
  );

  return { upserted: true, agreement: rows[0] };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const json = await readJsonBody(req);

    // Smartwaiver webhook commonly sends: unique_id + event  [oai_citation:2‡Smartwaiver](https://support.smartwaiver.com/hc/en-us/articles/360057049551-What-are-Webhooks)
    const waiverId =
      json?.waiverId ||
      json?.waiver?.waiverId ||
      json?.unique_id ||
      json?.uniqueId ||
      json?.id ||
      "";

    const eventType = (json?.event || json?.type || json?.eventType || "waiver").toString();

    // Store richer crumb for debugging (includes raw keys we received)
    if (RURL && RTOK) {
      const payload = JSON.stringify({
        ts: new Date().toISOString(),
        eventType,
        waiverId: String(waiverId || ""),
        keys: Object.keys(json || {}).slice(0, 50),
        // templateId is not typically present in webhook payload
      });
      await redisCmd("SET", LAST_EVENT_KEY, payload);
      await redisCmd("INCR", VERSION_KEY);
    }

    // Best-effort DB population: always enrich if we have an id.
    if (waiverId) {
      const full = await fetchWaiverById(waiverId);

      // Smartwaiver responses may be { waiver: {...} } or {...}
      const fullWaiver = full?.waiver && typeof full.waiver === "object" ? full.waiver : full;

      if (fullWaiver && typeof fullWaiver === "object") {
        await upsertOutstandingAgreementFromWaiver(fullWaiver);
      }
    }

    return ok(res);
  } catch (e) {
    console.error("sw-webhook error", e);
    return res.status(200).send("ok"); // Always 200 so Smartwaiver doesn’t retry storm
  }
}
