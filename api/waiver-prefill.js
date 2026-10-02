// Creates an editable UNSIGNED Smartwaiver draft; never changes signed records.
const sw = require('../lib/smartwaiver');
const { requireStaff } = require('../lib/staff-auth');
const { buildIntakePrefill, buildLiabilityPrefill, safePrefillUrl, fieldList } = require('../lib/waiver-prefill');
const { normalizeIntake } = require('../lib/intake-normalize');
const templateCache = new Map();

async function template(id) {
  const cached = templateCache.get(id);
  if (cached && cached.until > Date.now()) return cached.value;
  const data = await sw.request(`/templates/${encodeURIComponent(id)}?customFields=true`);
  if (!data.template || data.template.templateId !== id) throw new Error('Smartwaiver template could not be verified.');
  templateCache.set(id, { value: data.template, until: Date.now() + 60000 });
  return data.template;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST.' }); }
  const headers=req.headers||{};
  // Origin checking limits cross-site browser calls; staff authentication is separate.
  if (headers.origin) {
    let originHost;
    try { originHost = new URL(headers.origin).host; } catch { return res.status(403).json({ error: 'Invalid origin.' }); }
    if (originHost !== headers.host) return res.status(403).json({ error: 'Invalid origin.' });
  }
  if (!String(headers['content-type'] || '').toLowerCase().includes('application/json')) return res.status(415).json({ error: 'Use application/json.' });
  try {
    const input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: 'Invalid request.' });
    // Verify the existing staff session before reading or copying any signed intake.
    // The welcome stage only forwards values entered in the current public form.
    const staffStage = ['liability','template-check','synthetic-preview'].includes(input.stage);
    if (staffStage) await requireStaff(req);
    const intakeId = process.env.INTAKE_WAIVER_ID || process.env.INTAKE_TEMPLATE_ID;
    const liabilityId = process.env.LIABILITY_WAIVER_ID || process.env.LIABILITY_TEMPLATE_ID || process.env.SW_TEMPLATE_LIABILITY;
    if (!intakeId || (staffStage && !liabilityId)) return res.status(503).json({ error: 'Smartwaiver templates are not configured.' });
    let draft, templateId;
    if(input.stage === 'template-check') {
      const definitions=await Promise.all([template(intakeId),template(liabilityId)]);
      const summarize=definition=>({title:definition.title||'',publishedVersion:definition.publishedVersion,participantFields:fieldList(definition,true).map(({label,fieldType,type})=>({label,fieldType,type})),waiverFields:fieldList(definition,false).map(({label,fieldType,type})=>({label,fieldType,type}))});
      return res.status(200).json({templates:definitions.map(summarize)});
    }

    if (input.stage === 'intake') {
      draft = buildIntakePrefill(input);
      templateId = intakeId;
    } else if(input.stage === 'synthetic-preview') {
      // Fixed, conspicuously synthetic data only; never reads a signed record.
      const [intake,liability]=await Promise.all([template(intakeId),template(liabilityId)]);
      const waiver={waiverId:'synthetic_snowos_preview',templateId:intakeId,email:'snowos-unsigned-test@example.invalid',participants:[{firstName:'SnowOS',lastName:'Unsigned Test',dob:'1990-01-01',isMinor:false,customParticipantFields:{w:{displayText:'Weight (lbs)',value:'180'},h:{displayText:'Height (in)',value:'71'},s:{displayText:'Skier Type: (Check One)',value:'II'}}}]};
      const participant=normalizeIntake(waiver).participants[0];
      const review={reviewed:true,waiverId:waiver.waiverId,participantIndex:0,participant:{first_name:participant.first_name,last_name:participant.last_name},source:{weight_lb:participant.weight_lb,height_in:participant.height_in,age:participant.age,skier_type:participant.skier_type},calculated:{skierCode:'M',din:'7',bootSoleLengthMm:315}};
      draft=buildLiabilityPrefill(waiver,intake,liability,0,review);templateId=liabilityId;
    } else if (input.stage === 'liability') {
      if (typeof input.waiverId !== 'string' || !/^[a-zA-Z0-9_-]{6,128}$/.test(input.waiverId)) return res.status(400).json({ error: 'A valid intake ID is required.' });
      const [data, intake, liability] = await Promise.all([
        sw.request(`/waivers/${encodeURIComponent(input.waiverId)}`), template(intakeId), template(liabilityId),
      ]);
      if (!data.waiver || data.waiver.waiverId !== input.waiverId || data.waiver.templateId !== intakeId) return res.status(400).json({ error: 'The selected waiver is not this kiosk’s intake template.' });
      draft = buildLiabilityPrefill(data.waiver, intake, liability, input.participantIndex ?? 0, input.technicianReview);
      templateId = liabilityId;
    } else return res.status(400).json({ error: 'Choose intake or liability.' });
    if (staffStage) await requireStaff(req);
    const result = await sw.request(`/templates/${encodeURIComponent(templateId)}/prefill`, { method: 'POST', body: draft.payload });
    if (typeof result.prefill?.uuid !== 'string' || !result.prefill.uuid) throw new Error('Missing Smartwaiver prefill ID.');
    const url = safePrefillUrl(result.prefill.url, draft.tag, result.prefill.uuid);
    return res.status(200).json({ url, copiedFields: draft.copiedFields, skippedFields: draft.skippedFields, reviewRequired: true });
  } catch (error) {
    const status = [401,403,503].includes(error.status) ? error.status : error instanceof SyntaxError ? 400 : error.statusCode === 400 ? 400 : error.status === 429 || error.statusCode === 429 ? 429 : 502;
    // Validation messages are ours. Upstream bodies can contain customer details.
    const message = [401,403,503].includes(error.status) ? error.message : error instanceof SyntaxError ? 'Invalid JSON request.' : error.statusCode === 400 ? error.message : 'Unable to prepare Smartwaiver right now. Please try again; no waiver has been signed.';
    return res.status(status).json({ error: message });
  }
};
