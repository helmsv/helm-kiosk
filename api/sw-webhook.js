// api/sw-webhook.js
// Smartwaiver v4 webhook receiver -> bumps a Redis "version" so clients refresh instantly.
// Additionally: upserts signed waivers into Postgres as outstanding rental agreements.

const SW_BASE = (process.env.SW_BASE_URL || "https://api.smartwaiver.com").replace(/\/+$/, "");
const SW_V4 = `${SW_BASE}/v4`;

const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");

// Upstash Redis REST (required): UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN;

const LAST_EVENT_KEY = "sw:last_event";
const VERSION_KEY = "sw:version";

// Optional filters / auth
const RENTAL_TEMPLATE_ID = process.env.SMARTWAIVER_RENTAL_TEMPLATE_ID || ""; // recommended
const SW_API_KEY = process.env.SW_API_KEY || process.env.SMARTWAIVER_API_KEY || ""; // for enrichment

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
  // Vercel Node serverless: req.body may be object or string; req.json() is not always available.
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }

  // Fallback to raw stream
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
    headers: {
      Authorization: `Bearer ${SW_API_KEY}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!r.ok) return null;
  return r.json().catch(() => null);
}

async function upsertOutstandingAgreementFromWaiver(waiver) {
  const waiverId = waiver.waiverId ? String(waiver.waiverId) : null;
  if (!waiverId) return { upserted: false, reason: "missing waiverId" };

  const templateId = waiver.templateId ? String(waiver.templateId) : null;

  // Optional: filter to rental template only
  if (RENTAL_TEMPLATE_ID && templateId && String(templateId) !== String(RENTAL_TEMPLATE_ID)) {
    return { upserted: false, reason: "template filtered" };
  }

  const signerFirst = (waiver.firstName || waiver.signerFirstName || "").trim();
  const signerLast = (waiver.lastName || waiver.signerLastName || "").trim();
  const signedAtRaw = waiver.createdOn || waiver.createdAt || waiver.signedAt || null;

  if (!signerFirst && !signerLast) {
    return { upserted: false, reason: "missing signer name" };
  }

  await ensureSchema();
  const pool = getPool();

  const { rows } = await pool.query(
    `
    INSERT INTO rental_agreements
      (waiver_id, template_id, signer_first, signer_last, signed_at, status)
    VALUES
      ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), 'OUT')
    ON CONFLICT (waiver_id) DO UPDATE
      SET template_id  = EXCLUDED.template_id,
          signer_first = EXCLUDED.signer_first,
          signer_last  = EXCLUDED.signer_last,
          signed_at    = EXCLUDED.signed_at,
          status       = CASE
                        WHEN rental_agreements.status = 'RETURNED' THEN 'RETURNED'
                        ELSE 'OUT'
                      END
    RETURNING id, waiver_id, status;
    `,
    [waiverId, templateId, signerFirst, signerLast, signedAtRaw]
  );

  return { upserted: true, agreement: rows[0] };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const json = await readJsonBody(req);

    // Smartwaiver v4 payloads vary; these cover common shapes
    const waiverId = json?.waiverId || json?.waiver?.waiverId || json?.id || "";
    const templateId = json?.templateId || json?.waiver?.templateId || "";
    const eventType = (json?.type || json?.event || "waiver").toString();

    // Redis crumb + version bump (keep existing behavior)
    if (RURL && RTOK) {
      const payload = JSON.stringify({
        ts: new Date().toISOString(),
        eventType,
        waiverId,
        templateId,
      });
      await redisCmd("SET", LAST_EVENT_KEY, payload);
      await redisCmd("INCR", VERSION_KEY);
    }

    // Populate Postgres (best-effort; never block webhook success)
    if (waiverId) {
      // First try: upsert directly from payload (if it contains names/createdOn)
      let waiverObj =
        json?.waiver && typeof json.waiver === "object"
          ? { ...json.waiver, waiverId: json.waiver.waiverId || waiverId, templateId: json.waiver.templateId || templateId }
          : { ...json, waiverId, templateId };

      let result = await upsertOutstandingAgreementFromWaiver(waiverObj);

      // If missing signer details, optionally enrich by fetching full waiver
      if (!result.upserted && result.reason === "missing signer name") {
        const full = await fetchWaiverById(waiverId);
        if (full) {
          // Smartwaiver may return { waiver: {...} } or the waiver object itself
          const fullWaiver = full.waiver && typeof full.waiver === "object" ? full.waiver : full;
          result = await upsertOutstandingAgreementFromWaiver(fullWaiver);
        }
      }

      // Do not throw if DB insert fails; webhook must still return 200
      // If you want debugging, log only:
      // console.log("sw-webhook upsert:", result);
    }

    return ok(res);
  } catch (e) {
    console.error("sw-webhook error", e);
    return res.status(200).send("ok"); // Always 200 so Smartwaiver doesn’t retry storm
  }
}
