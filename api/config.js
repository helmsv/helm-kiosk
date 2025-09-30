// /api/config.js
export default async function handler(req, res) {
  const cfg = {
    has_sw_key: !!process.env.SW_API_KEY,
    intake_waiver_id: process.env.INTAKE_WAIVER_ID || "",
    liability_waiver_id: process.env.LIABILITY_WAIVER_ID || "",
    has_intake_id: !!process.env.INTAKE_WAIVER_ID,
    has_liability_id: !!process.env.LIABILITY_WAIVER_ID,
    sw_base_url: process.env.SW_BASE_URL || "https://api.smartwaiver.com/v4",
  };
  res.status(200).json(cfg);
}
