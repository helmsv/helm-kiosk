// api/sw-backfill.js
// Backfill rental_agreements from already-signed Smartwaiver waivers (filtered by LIABILITY_WAIVER_ID).
// Admin-protected: requires BACKFILL_TOKEN header or query param.

const SW_BASE = (process.env.SW_BASE_URL || "https://api.smartwaiver.com").replace(/\/+$/, "");
const SW_V4 = `${SW_BASE}/v4`;

const { getPool } = require("./_db");
const { ensureSchema } = require("./_ensureSchema");

const LIABILITY_WAIVER_ID = (process.env.LIABILITY_WAIVER_ID || "").trim();
const SW_API_KEY = process.env.SW_API_KEY || process.env.SMARTWAIVER_API_KEY || "";
const BACKFILL_TOKEN = (process.env.BACKFILL_TOKEN || "").trim();

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function getAuthToken(req) {
  const h = req.headers["x-backfill-token"] || req.headers["x-admin-token"];
  const q = req.query?.token;
  return (h || q || "").toString().trim();
}

function parseISODateOnly(s) {
  // YYYY-MM-DD
  if (!s) return "";
  const v = String(s).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
}

function parseISO(s) {
  // accept ISO-ish; minimal validation
  if (!s) return "";
  const v = String(s).trim();
  if (v.length < 10) return "";
  return v;
}

async function fetchWaiverSummaries({ templateId, fromDts, toDts, limit, offset }) {
  if (!SW_API_KEY) throw new Error("Missing SW_API_KEY (or SMARTWAIVER_API_KEY)");

  const url = new URL(`${SW_V4}/waivers`);
  // Smartwaiver supports limit (1-100) and template_id/date window style filters in SDKs/docs  [oai_citation:1‡rubydoc.info](https://www.rubydoc.info/gems/smartwaiver-sdk/4.0.0?utm_source=chatgpt.com)
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset)); // treat as record offset (0, 100, 200, ...)
  if (templateId) url.searchParams.set("templateId", templateId);
  if (fromDts) url.searchParams.set("fromDts", fromDts);
  if (toDts) url.searchParams.set("toDts", toDts);

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SW_API_KEY}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Smartwaiver GET /v4/waivers failed (${r.status}): ${t.slice(0, 400)}`);
  }
  return r.json();
}

// Summaries from /v4/waivers do NOT include phone; fetch the full waiver by id to get it.
async function fetchWaiverById(waiverId) {
  if (!SW_API_KEY) return null;
  const url = `${SW_V4}/waivers/${encodeURIComponent(String(waiverId))}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${SW_API_KEY}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const full = await r.json().catch(() => null);
  // Smartwaiver responses may be { waiver: {...} } or {...}
  return full?.waiver && typeof full.waiver === "object" ? full.waiver : full;
}

async function upsertOutstandingAgreementFromWaiverSummary(summary) {
  const waiverId = summary.waiverId ? String(summary.waiverId) : null;
  if (!waiverId) return { ok: false, reason: "missing waiverId" };

  const templateId = summary.templateId ? String(summary.templateId) : null;

  // Filter: only ingest waivers matching LIABILITY_WAIVER_ID (if set)
  if (LIABILITY_WAIVER_ID && templateId && templateId !== LIABILITY_WAIVER_ID) {
    return { ok: false, reason: "template filtered" };
  }

  const signerFirst = (summary.firstName || summary.signerFirstName || "").trim();
  const signerLast = (summary.lastName || summary.signerLastName || "").trim();
  const signedAtRaw = summary.createdOn || summary.createdAt || summary.signedAt || null;

  // If summaries don't include names, caller should enrich; here we just skip
  if (!signerFirst && !signerLast) {
    return { ok: false, reason: "missing signer name" };
  }

  // Phone is only present on the full waiver, not the summary — enrich.
  const full = await fetchWaiverById(waiverId);
  const phone = (full && full.phone ? String(full.phone) : "").trim();

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

  return { ok: true, agreement: rows[0] };
}

async function readJson(req) {
  // Vercel Node: req.body may already be parsed; handle both
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

module.exports = async function handler(req, res) {
  try {
    // TEMP inspect: GET ?inspect=1 returns one full waiver record so we can locate the phone field.
    if (req.query && req.query.inspect) {
      const list = await fetchWaiverSummaries({
        templateId: LIABILITY_WAIVER_ID,
        fromDts: "",
        toDts: "",
        limit: 5,
        offset: 0,
      });
      const first = Array.isArray(list.waivers) && list.waivers[0] ? list.waivers[0] : null;
      if (!first) return json(res, 200, { inspect: true, note: "no waivers found", list });
      const full = await fetchWaiverById(first.waiverId);
      return json(res, 200, { inspect: true, fullWaiver: full });
    }

    if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });

    if (!BACKFILL_TOKEN) {
      return json(res, 500, { error: "BACKFILL_TOKEN env var not set (refusing to expose backfill endpoint)" });
    }
    const token = getAuthToken(req);
    if (!token || token !== BACKFILL_TOKEN) {
      return json(res, 401, { error: "Unauthorized" });
    }

    if (!LIABILITY_WAIVER_ID) {
      return json(res, 400, { error: "LIABILITY_WAIVER_ID is empty; set it to your rental waiver templateId." });
    }

    const body = await readJson(req);

    // Support either ISO timestamps or YYYY-MM-DD (converted to UTC midnight)
    const fromDate = parseISODateOnly(body.fromDate || "");
    const toDate = parseISODateOnly(body.toDate || "");
    const fromDts = parseISO(body.fromDts || (fromDate ? `${fromDate}T00:00:00Z` : ""));
    const toDts = parseISO(body.toDts || (toDate ? `${toDate}T00:00:00Z` : ""));

    const dryRun = Boolean(body.dryRun);

    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 100); // Smartwaiver limit max 100 in SDK examples  [oai_citation:2‡GitHub](https://github.com/smartwaivercom/python-sdk?utm_source=chatgpt.com)
    const max = Math.min(Math.max(Number(body.max) || 10000, 1), 200000); // safety cap

    let seen = 0;
    let insertedOrUpdated = 0;
    let skippedTemplate = 0;
    let skippedNoName = 0;

    for (let offset = 0; offset < max; offset += limit) {
      const data = await fetchWaiverSummaries({
        templateId: LIABILITY_WAIVER_ID,
        fromDts,
        toDts,
        limit,
        offset,
      });

      const waivers = Array.isArray(data.waivers) ? data.waivers : [];
      if (!waivers.length) break;

      for (const w of waivers) {
        seen += 1;

        if (dryRun) {
          // Only count what would happen
          const templateId = w.templateId ? String(w.templateId) : null;
          if (LIABILITY_WAIVER_ID && templateId && templateId !== LIABILITY_WAIVER_ID) {
            skippedTemplate += 1;
            continue;
          }
          const signerFirst = (w.firstName || w.signerFirstName || "").trim();
          const signerLast = (w.lastName || w.signerLastName || "").trim();
          if (!signerFirst && !signerLast) {
            skippedNoName += 1;
            continue;
          }
          insertedOrUpdated += 1;
          continue;
        }

        const r = await upsertOutstandingAgreementFromWaiverSummary(w);
        if (r.ok) insertedOrUpdated += 1;
        else if (r.reason === "template filtered") skippedTemplate += 1;
        else if (r.reason === "missing signer name") skippedNoName += 1;
      }

      if (waivers.length < limit) break;
    }

    return json(res, 200, {
      ok: true,
      liabilityWaiverId: LIABILITY_WAIVER_ID,
      fromDts: fromDts || null,
      toDts: toDts || null,
      dryRun,
      limit,
      max,
      seen,
      insertedOrUpdated,
      skippedTemplate,
      skippedNoName,
    });
  } catch (e) {
    return json(res, 500, { error: e.message || "Server error" });
  }
}
