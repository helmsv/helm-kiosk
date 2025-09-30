// api/sw-webhook.js
// Accepts Smartwaiver webhook posts for Intake and Liability.
// Pushes normalized events into Upstash Redis list "sw:events" for the SSE to pick up.
//
// IMPORTANT: Configure Smartwaiver Webhooks to send the full waiver payload.
// Set your secret in SMARTWAIVER_WEBHOOK_SECRET (optional, if you verify).

export const config = { runtime: "nodejs" };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const WEBHOOK_SECRET = process.env.SMARTWAIVER_WEBHOOK_SECRET || "";

async function redis(command, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error("Upstash env not set");
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Upstash ${command} ${r.status}: ${JSON.stringify(json)}`);
  if (json.error) throw new Error(json.error);
  return json.result;
}

// util: safe get
const g = (o, p, d = undefined) => p.split(".").reduce((a, k) => (a && a[k] !== undefined ? a[k] : d), o);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (WEBHOOK_SECRET) {
      const auth = req.headers["x-webhook-secret"] || req.headers.authorization || "";
      if (!String(auth).includes(WEBHOOK_SECRET)) return res.status(401).json({ error: "Unauthorized" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // Smartwaiver formats vary; try to normalize from common fields
    // Expecting fields like: templateId, waiverId, title, signedOn, participants[], tags[], email, autoTag, etc.
    const templateId = g(body, "templateId") || g(body, "waiver.templateId");
    const waiverId = g(body, "waiverId") || g(body, "waiver.waiverId");
    const title = (g(body, "title") || "").toLowerCase();

    // Basic classify
    const isIntake = /intake/.test(title) || g(body, "isIntake") === true;
    const isLiability = /liability/.test(title) || g(body, "isLiability") === true;

    const signed_on = g(body, "signedOn") || g(body, "waiver.signedOn") || new Date().toISOString();

    // Collect tag + top-level email (if present)
    const autoTag = (g(body, "autoTag") || g(body, "waiver.autoTag") || "").toString();
    const tags = Array.from(new Set([autoTag, ...(g(body, "tags") || []), ...(g(body, "waiver.tags") || [])])).filter(Boolean);
    const lsTag = tags.find(t => /^ls_/.test(t));
    const lightspeed_id = lsTag ? lsTag.replace(/^ls_/, "") : "";

    const emailTop = (g(body, "email") || g(body, "waiver.email") || "").toString();

    // Participants
    const srcParticipants = g(body, "participants") || g(body, "waiver.participants") || [];
    const participants = srcParticipants.map((p, idx) => ({
      participant_index: Number(g(p, "participant_index", idx)),
      first_name: g(p, "firstName") || g(p, "first_name") || "",
      last_name:  g(p, "lastName") || g(p, "last_name") || "",
      email:      g(p, "email") || emailTop || "",
      age:        g(p, "age") != null ? Number(g(p, "age")) : null,
      weight_lb:  g(p, "weight_lb") != null ? Number(g(p, "weight_lb")) : null,
      height_in:  g(p, "height_in") != null ? Number(g(p, "height_in")) : null,
      skier_type: (g(p, "skier_type") || "").toString(),
    }));

    const intake_pdf_url = g(body, "pdf") || g(body, "waiver.pdf") || "";

    // Build event payload
    const eventBase = {
      data: {
        template_id: templateId || "",
        waiver_id: waiverId || "",
        signed_on,
        lightspeed_id,
        email: emailTop,
        intake_pdf_url,
        participants
      }
    };

    let toPush = null;
    if (isIntake) {
      toPush = { type: "intake", ...eventBase };
    } else if (isLiability) {
      // For liability we only need enough to match rows on client
      toPush = {
        type: "liability",
        data: {
          lightspeed_id,
          participants: participants.map(p => ({
            first_name: p.first_name, last_name: p.last_name, email: p.email
          }))
        }
      };
    } else {
      // Unknown type — do nothing (but 200 OK so SW doesn’t retry)
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Push to Redis list; keep only latest N to avoid unbounded growth
    await redis("RPUSH", "sw:events", JSON.stringify(toPush));
    await redis("LTRIM", "sw:events", "-500", "-1"); // keep last 500 events

    return res.status(200).json({ ok: true });
  } catch (e) {
    // Always 200 to prevent Smartwaiver retry storms; include error text for logs
    console.error("sw-webhook error:", e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
