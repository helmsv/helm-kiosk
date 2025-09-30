// api/open-intakes.js (CommonJS, tolerant list + no verified filter)
// Env: SW_API_KEY, INTAKE_TEMPLATE_ID, LIABILITY_TEMPLATE_ID
const SW_API = 'https://api.smartwaiver.com/v4';

async function swGetJSON(path, params = {}) {
  const key = process.env.SW_API_KEY;
  if (!key) throw new Error('Missing SW_API_KEY');
  const qs = new URLSearchParams(params);
  const url = `${SW_API}${path}${qs.toString() ? `?${qs}` : ''}`;
  const r = await fetch(url, { headers: { 'X-SW-API-KEY': key, 'Accept': 'application/json' } });
  if (!r.ok) {
    const t = await r.text().catch(()=>'');
    throw new Error(`SW GET ${path} ${r.status}: ${t}`);
  }
  return await r.json();
}
async function swGetDetail(waiverId) {
  const key = process.env.SW_API_KEY;
  const url = `${SW_API}/waivers/${encodeURIComponent(waiverId)}`;
  const r = await fetch(url, { headers: { 'X-SW-API-KEY': key, 'Accept': 'application/json' } });
  if (!r.ok) {
    const t = await r.text().catch(()=>'');
    throw new Error(`SW detail ${waiverId} ${r.status}: ${t}`);
  }
  return await r.json();
}
function extractLightspeedTag(tags) {
  if (!Array.isArray(tags)) return '';
  const t = tags.find(x => /^ls_/i.test(String(x || '')));
  return t || '';
}
function toISO(d) { try { return new Date(d).toISOString(); } catch { return null; } }

function waiversFromList(json) {
  // Different accounts return different shapes
  return json?.waivers || json?.waiverSummaries || json?.data || [];
}

function flattenIntake(waiver) {
  const w = waiver?.waiver || waiver;
  const tags = w?.tags || (w?.autoTag ? [w.autoTag] : []);
  const lsTag = extractLightspeedTag(tags);
  const lsId = lsTag ? String(lsTag).replace(/^ls_/i,'') : '';
  const participants = Array.isArray(w?.participants) ? w.participants : [];

  const cpfBy = (p, regex) => {
    const obj = p?.customParticipantFields || {};
    const arr = Object.values(obj);
    return arr.find(f => regex.test(f?.displayText || ''))?.value;
  };

  if (participants.length === 0) {
    return [{
      waiver_id: w?.waiverId || w?.waiver_id || '',
      signed_on: w?.createdOn || w?.created_on || '',
      intake_pdf_url: w?.pdf ? `${SW_API}/waivers/${encodeURIComponent(w.waiverId)}/pdf` : '',
      lightspeed_id: lsId,
      email: w?.email || '',
      first_name: w?.firstName || '',
      last_name:  w?.lastName || '',
      age: w?.age ?? null,
      weight_lb: null,
      height_in: null,
      skier_type: '',
      participant_index: 0
    }];
  }

  return participants.map((p, idx) => {
    const weightLb = Number(cpfBy(p, /weight/i) || NaN);
    const feet = Number(cpfBy(p, /height.*feet/i) || NaN);
    const inches = Number(cpfBy(p, /height.*inch/i) || NaN);
    const totalIn = (Number.isFinite(feet) ? feet : 0) * 12 + (Number.isFinite(inches) ? inches : 0);
    const skierTypeRaw = (cpfBy(p, /skier\s*type|II|III|Type/i) || '').toString().toUpperCase().replace('TYPE ', '');
    const skierType = ['I','II','III'].includes(skierTypeRaw) ? skierTypeRaw : '';

    return {
      waiver_id: w?.waiverId || '',
      signed_on: w?.createdOn || '',
      intake_pdf_url: w?.pdf ? `${SW_API}/waivers/${encodeURIComponent(w.waiverId)}/pdf` : '',
      lightspeed_id: lsId,
      email: p?.email || w?.email || '',
      first_name: p?.firstName || '',
      last_name:  p?.lastName || '',
      age: p?.age ?? null,
      weight_lb: Number.isFinite(weightLb) ? weightLb : null,
      height_in: Number.isFinite(totalIn) ? totalIn : null,
      skier_type,
      participant_index: p?.participant_index != null ? p.participant_index : idx
    };
  });
}

function keyForLiabilityMatch(row) {
  const tagKey = row.lightspeed_id ? `ls:${row.lightspeed_id}` : null;
  const emailKey = row.email ? `em:${row.email.toLowerCase()}` : null;
  const nameKey = (row.first_name || row.last_name)
    ? `nm:${(row.first_name||'').toLowerCase()}_${(row.last_name||'').toLowerCase()}`
    : null;
  return { tagKey, emailKey, nameKey };
}

module.exports = async (req, res) => {
  try {
    const intakeId = process.env.INTAKE_TEMPLATE_ID || '';
    const liabId   = process.env.LIABILITY_TEMPLATE_ID || '';
    if (!process.env.SW_API_KEY || !intakeId || !liabId) {
      return res.status(500).json({ error: 'Missing env: SW_API_KEY, INTAKE_TEMPLATE_ID, LIABILITY_TEMPLATE_ID' });
    }

    const since = (req.query?.since || 'all').toString();
    const fromDts = since === 'all' ? '1970-01-01T00:00:00Z' : (toISO(since) || '1970-01-01T00:00:00Z');
    const toDts   = toISO(new Date());

    // 1) Collect liability keys (for exclusion) — NO verified filter
    const liabKeys = new Set();
    let offset = 0; let page = 0;
    while (true) {
      const li = await swGetJSON('/waivers', {
        templateId: liabId,
        fromDts, ...(toDts ? { toDts } : {}),
        limit: 100,
        offset
      });
      const items = waiversFromList(li);
      for (const sum of items) {
        const tags = sum?.tags || (sum?.autoTag ? [sum.autoTag] : []);
        const lsTag = extractLightspeedTag(tags);
        const lsId = lsTag ? String(lsTag).replace(/^ls_/i,'') : '';
        const email = (sum?.email || '').toLowerCase();
        const first = (sum?.firstName || '').toLowerCase();
        const last  = (sum?.lastName || '').toLowerCase();
        if (lsId) liabKeys.add(`ls:${lsId}`);
        if (email) liabKeys.add(`em:${email}`);
        if (first || last) liabKeys.add(`nm:${first}_${last}`);
      }
      if (!items.length || items.length < 100) break;
      offset += 100; page++;
      if (page > 800) break; // safety cap
    }

    // 2) Intake → flatten participants → exclude if liability exists
    const rows = [];
    offset = 0; page = 0;
    while (true) {
      const li = await swGetJSON('/waivers', {
        templateId: intakeId,
        fromDts, ...(toDts ? { toDts } : {}),
        limit: 100,
        offset
      });
      const items = waiversFromList(li);
      if (!items.length) break;

      for (const sum of items) {
        const detail = await swGetDetail(sum.waiverId);
        const flats = flattenIntake(detail);
        for (const r of flats) {
          const k = keyForLiabilityMatch(r);
          const isClosed =
            (k.tagKey && liabKeys.has(k.tagKey)) ||
            (k.emailKey && liabKeys.has(k.emailKey)) ||
            (k.nameKey && liabKeys.has(k.nameKey));
          if (!isClosed) rows.push(r);
        }
      }

      if (items.length < 100) break;
      offset += 100; page++;
      if (page > 800) break;
    }

    rows.sort((a,b) => new Date(b.signed_on).getTime() - new Date(a.signed_on).getTime());
    return res.status(200).json({ rows, from: fromDts, to: toDts || null });
  } catch (e) {
    console.error('open-intakes error:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
