// api/config.js
module.exports = async (req, res) => {
  const intake = process.env.INTAKE_WAIVER_ID || process.env.INTAKE_TEMPLATE_ID || '';
  const liability = process.env.LIABILITY_WAIVER_ID || process.env.LIABILITY_TEMPLATE_ID || '';
  res.status(200).json({
    has_sw_key: !!process.env.SW_API_KEY,
    intake_waiver_id: intake,
    liability_waiver_id: liability,
    has_intake_id: !!intake,
    has_liability_id: !!liability,
    sw_base_url: process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4'
  });
};
