// api/today-intakes.js
const RAW_BASE = process.env.SW_BASE_URL || 'https://api.smartwaiver.com';

function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  return t.replace(/[^\x20-\x7E]+/g, '');
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

// Build candidate URLs for both /v4 and non-versioned
function urlCandidates(pathWithLeadingSlash) {
  const base = RAW_BASE.replace(/\/+$/, '');
  const withV4 = `${base}/v4${pathWithLeadingSlash}`;
  const noV4   = `${base}${pathWithLeadingSlash}`;
  if (/\/v4$/.test(base)) return [`${base}${pathWithLeadingSlash}`, noV4];
  return [withV4, noV4];
}

// Try multiple header styles + URL styles until one works
async function swFetch(pathWithLeadingSlash) {
  const key = cleanKey(process.env.SW_API_KEY);
  if (!key) throw new Error('Missing SW_API_KEY');

  const urls = urlCandidates(pathWithLeadingSlash);
  const headerVariants = [
    { 'x-api-key': key },
    { 'X-API-Key': key },
    { 'sw-api-key': key },
  ];

  const errors = [];
  for (const url of urls) {
    for (const hv of headerVariants) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(url, { headers: { Accept: 'application/json', ...hv }, cache: 'no-store' });
        if (r.ok) return r.json();
        // Not ok — capture short error
        const text = await r.text().catch(() => '');
        errors.push({ url, status: r.status, hv: Object.keys(hv), body: text.slice(0, 300) });
      } catch (e) {
        errors.push({ url, hv: Object.keys(hv), error: String(e) });
      }
    }
  }
  const tail = key ? key.slice(-6) : '';
  throw new Error(`All Smartwaiver attempts failed [key_tail:${tail}] ${JSON.stringify(errors)}`);
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
    const key      = cleanKey(process.env.SW_API_KEY);

    if (!key || !intakeId || !liabId) {
      return res.status(200).json({
        rows: [],
        error: 'Missing Smartwaiver env (SW_API_KEY / INTAKE_WAIVER_ID / LIABILITY_WAIVER_ID)',
      });
    }

    const { fromDts, toDts } = utcRangeToday();
    const qs = new URLSearchParams({
      templateId: intakeId,
      fromDts,
      toDts,
      verified: 'true',
      limit: '200',
    });

    // Version-agnostic: will try /v4/waivers?… first, then /waivers?…
    const list = await swFetch(`/waivers?${qs.toString()}`);

    const items = Array.isArray(list?.items) ? list.items
      : Array.isArray(list) ? list
      : [];

    const rows = items.flatMap(mapWaiverToRows);
    res.status(200).json({ rows, from: fromDts, to: toDts, count: rows.length });
  } catch (e) {
    res.status(200).json({ rows: [], error: String(e) });
  }
};
