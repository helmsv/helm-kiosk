// api/sw-webhook.js
// Smartwaiver webhook endpoint: receives waiver events and publishes SSE updates.
// Env needed: SW_API_KEY, INTAKE_TEMPLATE_ID, LIABILITY_TEMPLATE_ID

const SW_API = 'https://api.smartwaiver.com/v4';

async function swGet(path, opts = {}) {
  const key = process.env.SW_API_KEY;
  if (!key) throw new Error('Missing SW_API_KEY');
  const r = await fetch(`${SW_API}${path}`, {
    ...opts,
    headers: {
      'X-SW-API-KEY': key,
      'Accept': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!r.ok) {
    const t = await r.text().catch(()=>'');
    throw new Error(`Smartwaiver ${path} ${r.status}: ${t}`);
  }
  return await r.json();
}

function extractLightspeedTag(tags) {
  if (!Array.isArray(tags)) return '';
  const t = tags.find(x => /^ls_/i.test(String(x || '')));
  return t || '';
}

function normalizeParticipants(detail) {
  // Try participants array; fallback to top-level fields
  const out = [];
  const ps = detail?.participants;
  if (Array.isArray(ps) && ps.length) {
    ps.forEach((p, idx) => {
      // Try to pull customParticipantFields for weight/height/skier type if they exist
      const cpf = p?.customParticipantFields || {};
      // In your intake, we saw keys like:
      //   Weight: cpf.{id}.displayText contains 'Weight', value numeric (lbs)
      //   Height feet/in: two fields (Feet/Inches) → convert to total inches
      //   Skier Type: maybe 'I'/'II'/'III'
      const allFields = Object.values(cpf || {});
      const weightLb = Number(allFields.find(f => /weight/i.test(f?.displayText || ''))?.value || NaN);
      const hFeet    = Number(allFields.find(f => /height.*feet/i.test(f?.displayText || ''))?.value || NaN);
      const hInches  = Number(allFields.find(f => /height.*inch/i.test(f?.displayText || ''))?.value || NaN);
      const totalIn  = (Number.isFinite(hFeet) ? hFeet : 0) * 12 + (Number.isFinite(hInches) ? hInches : 0);
      // Skier Type field (your intake had “II” in debug under a field):
      const skierType = (allFields.find(f => /skier\s*type|II|III|Type/i.test(f?.displayText || ''))?.value || '')
        .toString().toUpperCase().replace('TYPE ', '');
      out.push({
        participant_index: idx,
        first_name: p?.firstName || '',
        last_name:  p?.lastName || '',
        email:      p?.email || detail?.email || '',
        age:        p?.age ?? null,
        weight_lb:  Number.isFinite(weightLb) ? weightLb : null,
        height_in:  Number.isFinite(totalIn) ? totalIn : null,
        skier_type: ['I','II','III'].includes(skierType) ? skierType : ''
      });
    });
  } else {
    out.push({
      participant_index: 0,
      first_name: detail?.firstName || '',
      last_name:  detail?.lastName || '',
      email:      detail?.email || '',
      age:        detail?.age ?? null,
      weight_lb:  null,
      height_in:  null,
      skier_type: ''
    });
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const { waiverId, templateId } = req.body || {};
    if (!waiverId || !templateId) return res.status(400).json({ ok:false, error:'Missing waiverId/templateId' });

    // Fetch full waiver detail to build participants + metadata
    const detail = await swGet(`/waivers/${encodeURIComponent(waiverId)}`);
    const w = detail?.waiver || detail; // API sometimes nests in {waiver: {...}}

    const signed_on = w?.createdOn || w?.created_on || null;
    const tags = w?.tags || w?.autoTag ? [w.autoTag, ...(w.tags || [])] : (w?.tags || []);
    const lsTag = extractLightspeedTag(tags);
    const participants = normalizeParticipants(w);
    const intake_pdf_url = w?.pdf ? `${SW_API}/waivers/${encodeURIComponent(waiverId)}/pdf` : '';

    const payload = {
      waiver_id: waiverId,
      template_id: templateId,
      signed_on,
      email: w?.email || '',
      lightspeed_id: lsTag ? String(lsTag).replace(/^ls_/i,'') : '',
      intake_pdf_url,
      participants
    };

    const intakeId = process.env.INTAKE_TEMPLATE_ID || '';
    const liabilityId = process.env.LIABILITY_TEMPLATE_ID || '';

    if (templateId === intakeId) {
      globalThis.__sse_publish?.('intake', payload);
    } else if (templateId === liabilityId) {
      // For liability, publish participant list when available for precise removal
      const removal = {
        waiver_id: waiverId,
        template_id: templateId,
        signed_on,
        lightspeed_id: payload.lightspeed_id || '',
        email: payload.email || '',
        participants: participants.map(p => ({
          first_name: p.first_name || '',
          last_name:  p.last_name || '',
          email:      p.email || ''
        }))
      };
      globalThis.__sse_publish?.('liability', removal);
    } else {
      // Other templates: ignore
    }

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error('sw-webhook error:', e);
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
