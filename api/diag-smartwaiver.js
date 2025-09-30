// api/diag-smartwaiver.js
// GET /api/diag-smartwaiver?template=intake|liability&limit=5
// Shows the last N waivers and the exact list shape your account returns.

const SW_API = 'https://api.smartwaiver.com/v4';

module.exports = async (req, res) => {
  try {
    const key = process.env.SW_API_KEY;
    const intakeId = process.env.INTAKE_TEMPLATE_ID || '';
    const liabId   = process.env.LIABILITY_TEMPLATE_ID || '';
    if (!key || !intakeId || !liabId) return res.status(500).json({ error: 'Missing envs' });

    const which = (req.query.template || 'intake').toString();
    const templateId = which === 'liability' ? liabId : intakeId;
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '5',10)));

    const qs = new URLSearchParams({ templateId, limit: String(limit), offset: '0' });
    const url = `${SW_API}/waivers?${qs.toString()}`;
    const r = await fetch(url, { headers: { 'X-SW-API-KEY': key, 'Accept': 'application/json' } });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch {}

    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      url,
      shapeKeys: json ? Object.keys(json) : ['<non-JSON>'],
      sample: json || txt.slice(0, 2000)
    });
  } catch (e) {
    console.error('diag-smartwaiver error:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
