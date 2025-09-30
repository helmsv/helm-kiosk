// /api/sw-webhook.js
// Env needed: SW_API_KEY, INTAKE_TEMPLATE_ID, LIABILITY_TEMPLATE_ID,
//             UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
const SW_API = 'https://api.smartwaiver.com/v4';
const CHANNEL = 'sw-events';

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

// ---- Upstash publish helper (REST)
async function publish(type, data) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) {
    console.warn('[sw-webhook] Upstash env missing; skipping publish');
    return;
  }
  const url = `${base.replace(/\/+$/,'')}/publish/${CHANNEL}`;
  const msg = JSON.stringify({ type, data });
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: msg })
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    console.warn('[sw-webhook] publish failed', r.status, t);
  }
}

function extractLightspeedTag(tags) {
  if (!Array.isArray(tags)) return '';
  const t = tags.find(x => /^ls_/i.test(String(x || '')));
  return t || '';
}

function normalizeParticipants(detail) {
  const out = [];
  const ps = detail?.participants;
  if (Array.isArray(ps) && ps.length) {
    ps.forEach((p, idx) => {
      const cpf = p?.customParticipantFields || {};
      const all = Object.values(cpf || {});
      const weightLb = Number(all.find(f => /weight/i.test(f?.displayText || ''))?.value || NaN);
      const hFeet    = Number(all.find(f => /height.*feet/i.test(f?.displayText || ''))?.value || NaN);
      const hInches  = Number(all.find(f => /height.*inch/i.test(f?.displayText || ''))?.value || NaN);
      const totalIn  = (Number.isFinite(hFeet) ? hFeet : 0) * 12 + (Number.isFinite(hInches) ? hInches : 0);
      const skierType = (all.find(f => /skier\s*type|II|III|Type/i.test(f?.displayText || ''))?.value || '')
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

function parseIncoming(req) {
  let b = req.body;
  if (b && typeof b === 'object' && typeof b.payload === 'string') {
    try { b = JSON.parse(b.payload); } catch {}
  }
  if (!b || typeof b !== 'object') b = {};
  const waiverId = b.waiverId || b.waiver_id ||
                   b?.waiver?.waiverId || b?.waiver?.waiver_id ||
                   b?.data?.waiverId || b?.data?.waiver_id || '';
  const templateId = b.templateId || b.template_id ||
                     b?.waiver?.templateId || b?.waiver?.template_id ||
                     b?.data?.templateId || b?.data?.template_id || '';
  return { waiverId, templateId, raw: b };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const { waiverId, templateId, raw } = parseIncoming(req);

    console.log('[sw-webhook] parsed keys:', Object.keys(raw || {}));
    console.log('[sw-webhook] waiverId:', waiverId, 'templateId:', templateId);

    if (!waiverId || !templateId) {
      console.warn('[sw-webhook] Missing waiverId/templateId – ignoring');
      return res.status(200).json({ ok:true, note:'missing ids' });
    }

    const detailWrap = await swGet(`/waivers/${encodeURIComponent(waiverId)}`);
    const w = detailWrap?.waiver || detailWrap;

    const signed_on = w?.createdOn || w?.created_on || null;
    const tags = w?.tags || (w?.autoTag ? [w.autoTag] : []);
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

    const intakeId    = process.env.INTAKE_TEMPLATE_ID    || process.env.INTAKE_WAIVER_ID || '';
    const liabilityId = process.env.LIABILITY_TEMPLATE_ID || process.env.LIABILITY_WAIVER_ID || '';

    if (templateId === intakeId) {
      await publish('intake', payload);
      console.log('[sw-webhook] published intake event', waiverId);
    } else if (templateId === liabilityId) {
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
      await publish('liability', removal);
      console.log('[sw-webhook] published liability event', waiverId);
    } else {
      console.log('[sw-webhook] non-target template; ignoring');
    }

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error('sw-webhook error:', e);
    // 200 to avoid Smartwaiver retry storms; poller will still pick them up
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
};
