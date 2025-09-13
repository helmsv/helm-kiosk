// api/sw-webhook.js
import crypto from "crypto";

const SW_API = "https://api.smartwaiver.com/v4";

async function publishIntake(evt) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  const body = { channel: "intakes", message: JSON.stringify(evt) };
  await fetch(`${UPSTASH_REDIS_REST_URL}/pubsub/publish/intakes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: JSON.stringify(evt) }),
  });
}

function verifySignature(raw, sigHeader, secret) {
  // Smartwaiver sends a signature header (name may vary by account setup).
  // If you don’t see it in your requests, skip verification initially.
  if (!sigHeader || !secret) return true;
  const hmac = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  // constant-time compare
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(sigHeader));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const raw = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

    const sig = req.headers["x-sw-signature"] || req.headers["x-smartwaiver-signature"];
    const okSig = verifySignature(raw, String(sig || ""), process.env.SW_WEBHOOK_SECRET);
    if (!okSig) return res.status(401).json({ error: "bad signature" });

    // Acknowledge FAST so Smartwaiver doesn’t retry
    res.status(200).json({ ok: true });

    // Parse webhook: Smartwaiver sends at least a waiverId (name can vary)
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = {}; }
    const waiverId = payload.waiverId || payload.id || payload.waiver_id;
    if (!waiverId) return;

    // Fetch the full waiver (v4)
    const r = await fetch(`${SW_API}/waivers/${encodeURIComponent(waiverId)}`, {
      headers: { "X-SW-API-KEY": process.env.SW_API_KEY, Accept: "application/json" },
    });
    if (!r.ok) return;
    const j = await r.json();

    // Normalize fields to the structure your tech page expects
    const w = j?.waiver || j; // SDK vs raw
    const summary = {
      waiver_id: w.waiverId || waiverId,
      template_id: w.templateId || "",
      signed_on: w.createdOn || w.signedOn || new Date().toISOString(),
      email: w.email || w?.participants?.[0]?.email || "",
      first_name: w.firstName || w?.participants?.[0]?.firstName || "",
      last_name: w.lastName || w?.participants?.[0]?.lastName || "",
      // your intake uses tag "ls_<lightspeed_id>"
      lightspeed_id: (Array.isArray(w.tags) ? w.tags : []).map(String).find(t => t.startsWith("ls_"))?.slice(3) || "",
      intake_pdf_url: w.pdf || "",
      // If you want to filter to “intake” only here, check templateId === INTAKE_TEMPLATE_ID
    };

    // Publish to Redis pub/sub
    await publishIntake({ type: "intake_signed", data: summary });
  } catch (e) {
    // Don’t throw — we already ACK’d the webhook
    console.error("sw-webhook error:", e);
  }
}