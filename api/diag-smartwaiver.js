// /api/diag-smartwaiver.js
export default async function handler(req, res) {
  try {
    const SW_API_KEY = process.env.SW_API_KEY;
    const INTAKE_WAIVER_ID = process.env.INTAKE_WAIVER_ID;
    const LIABILITY_WAIVER_ID = process.env.LIABILITY_WAIVER_ID;
    const SW_BASE = process.env.SW_BASE_URL || "https://api.smartwaiver.com/v4";

    if (!SW_API_KEY) {
      return res.status(500).json({ error: "Missing SW_API_KEY" });
    }

    const [intakes, liabilities] = await Promise.all([
      listSome(SW_BASE, SW_API_KEY, INTAKE_WAIVER_ID),
      listSome(SW_BASE, SW_API_KEY, LIABILITY_WAIVER_ID),
    ]);

    res.status(200).json({
      env: {
        has_sw_key: !!SW_API_KEY,
        intake_waiver_id: INTAKE_WAIVER_ID || "",
        liability_waiver_id: LIABILITY_WAIVER_ID || "",
      },
      samples: {
        intake_count: intakes.length,
        liability_count: liabilities.length,
        intake_first: intakes[0] || null,
        liability_first: liabilities[0] || null,
      },
    });
  } catch (e) {
    console.error("diag-smartwaiver error:", e);
    res.status(500).json({ error: "diag failed" });
  }
}

async function listSome(base, key, templateId) {
  if (!templateId) return [];
  const url = new URL(`${base}/waivers`);
  url.searchParams.set("templateId", templateId);
  url.searchParams.set("limit", "5");
  url.searchParams.set("sort", "createdOn:desc");

  const r = await fetch(url.toString(), {
    headers: {
      "X-API-Key": key,       // Smartwaiver v4 header
      "sw-api-key": key,      // be liberal in what we send
    },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j?.waivers) ? j.waivers : (Array.isArray(j) ? j : []);
}
