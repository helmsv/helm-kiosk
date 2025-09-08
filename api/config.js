// api/config.js
// Provides liability waiver ID (so frontend doesn’t hardcode it)

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    return res.status(200).json({
      liability_waiver_id: process.env.LIABILITY_WAIVER_ID || ""
    });
  } catch (e) {
    console.error("config fatal:", e?.message || e);
    return res.status(200).json({ liability_waiver_id: "" });
  }
};