// /api/sw-webhook.js
export const config = {
  api: {
    bodyParser: true, // Smartwaiver sends JSON; leave true
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // ---- Robust env resolution (new names first, legacy fallbacks) ----
    const INTAKE_WAIVER_ID =
      process.env.INTAKE_WAIVER_ID ||
      process.env.INTAKE_TEMPLATE_ID ||   // legacy fallback
      process.env.TEMPLATE_ID ||          // very old single-template fallback
      "";

    const LIABILITY_WAIVER_ID =
      process.env.LIABILITY_WAIVER_ID ||
      process.env.LIABILITY_TEMPLATE_ID || // legacy fallback
      "";

    if (!INTAKE_WAIVER_ID && !LIABILITY_WAIVER_ID) {
      // Don’t 500 — just surface clearly so you see it in logs
      console.warn("[sw-webhook] Missing INTAKE_WAIVER_ID / LIABILITY_WAIVER_ID");
    }

    // ---- Parse webhook payload (be defensive) ----
    const body = (typeof req.body === "string")
      ? safeParse(req.body)
      : (req.body || {});
    // Shapes we’ve seen:
    // { templateId, waiverId, createdOn, ... }  OR  { waiver: { templateId, waiverId, ... }, ... }
    const templateId =
      body.templateId ||
      body.template_id ||
      body?.waiver?.templateId ||
      body?.waiver?.template_id ||
      "";
    const waiverId =
      body.waiverId ||
      body.waiver_id ||
      body?.waiver?.waiverId ||
      body?.waiver?.waiver_id ||
      "";

    // Classify event
    const isIntake = !!INTAKE_WAIVER_ID && templateId === INTAKE_WAIVER_ID;
    const isLiability = !!LIABILITY_WAIVER_ID && templateId === LIABILITY_WAIVER_ID;

    if (!isIntake && !isLiability) {
      // Not a template we care about; don’t error
      return res.status(200).json({ ok: true, ignored: true, reason: "unmatched templateId", templateId });
    }

    // ---- Build a minimal envelope to hand off to your existing publisher logic ----
    const eventType = isIntake ? "intake" : "liability";
    const envelope = {
      type: eventType,
      data: {
        templateId,
        waiver_id: waiverId,
        // pass-through some timestamps/fields if provided
        created_on: body.createdOn || body.created_on || body?.waiver?.createdOn || null,
        signed_on: body.signedOn || body.signed_on || body?.waiver?.signedOn || null,
        email: body.email || body?.waiver?.email || null,
        // Raw body included for downstream enrichment if you already do a follow-up fetch
        raw: body
      }
    };

    // -------------------------------------------------------------------
    // If you already publish to Redis/SSE here, KEEP those lines.
    // For example (illustrative only — keep your existing code/keys):
    //
    // await publishToRedis("sse:events", JSON.stringify(envelope));
    //
    // -------------------------------------------------------------------

    // Always 200 so Smartwaiver doesn’t retry excessively
    return res.status(200).json({ ok: true, handled: eventType, waiverId, templateId });
  } catch (e) {
    console.error("[sw-webhook] error:", e);
    // Return 200 to avoid webhook retry storms; include flag for your logs
    return res.status(200).json({ ok: false, error: "webhook handler threw", soft: true });
  }
}

// Safe JSON.parse
function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
