// Next.js API route: /api/liability-latest
// Returns the most-recent signed liability for a given email.
// Always 200 so front-end fetchJSONOrThrow() doesn’t throw.

const SW_BASE = "https://api.smartwaiver.com/v4";

async function swGet(path, apiKey) {
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: { "sw-api-key": apiKey, "accept": "application/json" },
    redirect: "follow"
  });
  // Return JSON or a safe fallback
  try { return await r.json(); } catch { return {}; }
}

export default async function handler(req, res) {
  const apiKey = process.env.SW_API_KEY || "";
  const email = (req.query.email || "").toString().trim();
  const templateId =
    process.env.LIABILITY_WAIVER_ID ||
    process.env.SW_TEMPLATE_LIABILITY || // optional alias
    "";

  if (!apiKey) {
    return res.status(200).json({ error: "Missing SW_API_KEY", rows: [], row: null, count: 0 });
  }
  if (!email) {
    return res.status(200).json({ error: "Missing email", rows: [], row: null, count: 0 });
  }

  try {
    // Query Smartwaiver by email (optionally filter by templateId if provided)
    const q = new URLSearchParams();
    q.set("search[email]", email);
    if (templateId) q.set("templateId", templateId);

    // Pull a reasonably-sized page; we’ll sort locally by createdOn
    q.set("limit", "50");

    const data = await swGet(`/waivers?${q.toString()}`, apiKey);
    const waivers = Array.isArray(data?.waivers) ? data.waivers : [];

    // Choose the most recent by createdOn
    waivers.sort((a, b) => {
      const da = Date.parse(a?.createdOn || 0);
      const db = Date.parse(b?.createdOn || 0);
      return db - da;
    });

    const latest = waivers[0] || null;

    // Normalize a compact row (compatible with /api/open-liabilities style)
    const row = latest
      ? {
          waiverId: latest.waiverId,
          templateId: latest.templateId || null,
          email: latest.email || null,
          firstName: latest.firstName || null,
          lastName: latest.lastName || null,
          createdOn: latest.createdOn || null,
        }
      : null;

    return res.status(200).json({
      row,
      rows: row ? [row] : [],
      count: row ? 1 : 0,
      error: row ? undefined : "No prior liability found",
    });
  } catch (e) {
    // Still 200; front-end will not throw
    return res.status(200).json({ error: String(e), rows: [], row: null, count: 0 });
  }
}
