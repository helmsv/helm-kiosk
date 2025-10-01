// api/today-intakes.js
const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  t = t.replace(/[^\x20-\x7E]+/g, '');
  return t;
}

function utcRangeToday() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const from = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
  const to   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
  return { fromDts: from.toISOString(), toDts: to.toISOString() };
}

async function swFetch(path) {
  const key = cleanKey(process.env.SW_API_KEY);
  if (!key) throw new Error('Missing SW_API_KEY');
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      'x-api-key': key, // canonical
    },
    cache: 'no-store',
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const tail = key ? key.slice(-6) : '';
    throw new Error(`SW ${path} ${r.status} [key_tail:${tail}] ${text}`);
  }
  return r.json();
}

function mapWaiverToRows(item) {
  const w = item || {};
  return [{
    waiver_id: w.waiverId || w.id || '',
    signed_on: w.createdOn || w.created || w.timestamp || '',
    intake_pdf_url: w.pdf || '',
    lightspeed_id: (w.autoTag || '').startsWith('ls_') ? (w.autoTag || '').slice(3) : '',
    email: w.email || '',
    first_name: w.firstName || '',
    last_name: w.lastName || '',
    participant_index: 0,
    age: null,
    weight_lb: null,
    height_in: null,
    skier_type: ''
  }];
}

module.exports = async (req, res) => {
  try {
    const intakeId = process.env.INTAKE_WAIVER_ID;
    const liabId   = process.env.LIABILITY_WAIVER_ID;
    const key = cleanKey(process.env.SW_API_KEY);

    if (!key || !intakeId || !liabId) {
      return res.status(200).json({
        rows: [],
        error: 'Missing Smartwaiver env (SW_API_KEY / INTAKE_WAIVER_ID / LIABILITY_WAIVER_ID)'
      });
    }

    const { fromDts, toDts } = utcRangeToday();
    const qs = new URLSearchParams({
      templateId: intakeId,
      fromDts,
      toDts,
      verified: 'true',
      limit: '200'
    });

    const list = await swFetch(`/waivers?${qs.toString()}`);
    const items = Array.isArray(list.items) ? list.items : (Array.isArray(list) ? list : []);
    const rows = items.flatMap(mapWaiverToRows);

    res.status(200).json({ rows, from: fromDts, to: toDts, count: rows.length });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
};
