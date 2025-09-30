// api/today-intakes.js
const SW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com/v4';

function cleanKey(v) {
  if (!v) return '';
  const t = String(v).trim();
  const m = t.match(/^"(.*)"$/); // strip accidental wrapping quotes
  return m ? m[1] : t;
}

function utcRangeToday() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const from = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
  const to   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
  return {
    from,
    to,
    fromDts: from.toISOString(),
    toDts: to.toISOString()
  };
}

async function swFetch(path, init = {}) {
  const key = cleanKey(process.env.SW_API_KEY);
  if (!key) throw new Error('Missing SW_API_KEY');
  const r = await fetch(`${SW_BASE}${path}`, {
    ...init,
    headers: {
      'x-api-key': key,
      'X-SW-API-KEY': key,
      'Accept': 'application/json',
      ...(init.headers || {})
    },
    cache: 'no-store'
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`SW ${path} ${r.status} ${text}`);
  }
  return r.json();
}

// Map Smartwaiver v4 list item to a simple row (adult-only; full participant expansion happens elsewhere)
function mapWaiverToRows(item) {
  const rows = [];
  const w = item || {};
  // v4 list payload commonly includes signer + maybe participants summary; many fields are only in /waivers/{id}
  rows.push({
    waiver_id: w.waiverId || w.id || '',
    signed_on: w.createdOn || w.created || w.timestamp || '',
    intake_pdf_url: w.pdf || '',
    lightspeed_id: (w.autoTag || '').startsWith('ls_') ? (w.autoTag || '').slice(3) : '',
    email: w.email || '',
    first_name: w.firstName || '',
    last_name: w.lastName || '',
    // participant expansion is handled by /api/intake-details when you open the DIN modal
    participant_index: 0,
    age: null,
    weight_lb: null,
    height_in: null,
    skier_type: ''
  });
  return rows;
}

module.exports = async (req, res) => {
  try {
    const intakeId = process.env.INTAKE_WAIVER_ID;
    const liabId   = process.env.LIABILITY_WAIVER_ID;

    if (!intakeId || !liabId || !process.env.SW_API_KEY) {
      return res.status(200).json({
        rows: [],
        error: 'Missing Smartwaiver env (SW_API_KEY / INTAKE_WAIVER_ID / LIABILITY_WAIVER_ID)'
      });
    }

    const { fromDts, toDts } = utcRangeToday();
    // list signed & verified waivers for the intake template today
    const qs = new URLSearchParams({
      templateId: intakeId,
      fromDts,
      toDts,
      verified: 'true'
    });

    const list = await swFetch(`/waivers?${qs.toString()}`);
    // list.items is the usual container; fall back to empty
    const items = Array.isArray(list.items) ? list.items : (Array.isArray(list) ? list : []);
    const rows = items.flatMap(mapWaiverToRows);

    res.status(200).json({
      rows,
      from: fromDts,
      to: toDts,
      count: rows.length
    });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
};
