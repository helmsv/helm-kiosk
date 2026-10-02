// Creates an editable UNSIGNED Smartwaiver draft; never changes signed records.
const sw = require('../lib/smartwaiver');
const { requireStaff } = require('../lib/staff-auth');
const { buildIntakePrefill, buildLiabilityPrefill, safePrefillUrl, fieldList } = require('../lib/waiver-prefill');
const { normalizeIntake } = require('../lib/intake-normalize');
const templateCache = new Map();
const OPERATIONS = new Set(['intake-read', 'intake-template', 'liability-template', 'prefill-build', 'prefill-create', 'prefill-response']);

function syntheticTechnicalFields(payload, definition) {
  // Only the fixed synthetic preview may expose these three configuration
  // destinations and its outgoing defaults. Never inspect request/source data.
  const groups = [['Skier Code'], ['Initial Indicator Value', 'DIN'], ['Boot Sole Length (mm)']];
  const fields = [
    ...fieldList(definition, true).map(field => ({ ...field, scope: 'participant' })),
    ...fieldList(definition, false).map(field => ({ ...field, scope: 'waiver' })),
  ];
  const result = [];
  for (const labels of groups) {
    const matches = fields.filter(field => labels.includes(field.label));
    if (matches.length !== 1) continue;
    const { label, guid, scope } = matches[0];
    if (typeof guid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(guid)) continue;
    const values = scope === 'participant' ? payload.participants?.[0]?.customFields : payload.customWaiverFields;
    if (!values || !Object.prototype.hasOwnProperty.call(values, guid)) continue;
    const value = values[guid];
    if (typeof value !== 'string' || value.length > 128) continue;
    result.push({ label, guid, scope, value });
  }
  return result;
}

async function during(operation, action) {
  try { return await action(); }
  catch (error) {
    // These names are fixed at our call sites, not derived from input or URLs.
    error.operation = operation === 'prefill-create' && Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 200 && error.upstreamStatus <= 299
      ? 'prefill-response' : operation;
    throw error;
  }
}

async function template(id, operation, { fresh = false } = {}) {
  const cached = templateCache.get(id);
  if (!fresh && cached && cached.until > Date.now()) return cached.value;
  return during(operation, async () => {
    const data = await sw.request(`/templates/${encodeURIComponent(id)}?customFields=true`);
    if (!data.template || data.template.templateId !== id) throw new Error('Smartwaiver template could not be verified.');
    templateCache.set(id, { value: data.template, until: Date.now() + 60000 });
    return data.template;
  });
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
    let draft, templateId, technicalFields;
    if(input.stage === 'template-check') {
      const definitions=await Promise.all([template(intakeId, 'intake-template'),template(liabilityId, 'liability-template')]);
      const summarize=definition=>({title:definition.title||'',publishedVersion:definition.publishedVersion,participantFields:fieldList(definition,true).map(({label,fieldType,type})=>({label,fieldType,type})),waiverFields:fieldList(definition,false).map(({label,fieldType,type})=>({label,fieldType,type}))});
      return res.status(200).json({templates:definitions.map(summarize)});
    }

    if (input.stage === 'intake') {
      draft = await during('prefill-build', () => buildIntakePrefill(input));
      templateId = intakeId;
    } else if(input.stage === 'synthetic-preview') {
      // Fixed, conspicuously synthetic data only; never reads a signed record.
      // Version-bound dropdown contracts must see fresh destination metadata.
      // This does not make the provider's later prefill creation atomic.
      const [intake,liability]=await Promise.all([template(intakeId, 'intake-template'),template(liabilityId, 'liability-template', { fresh: true })]);
      const waiver={waiverId:'synthetic_snowos_preview',templateId:intakeId,email:'snowos-unsigned-test@example.invalid',participants:[{firstName:'SnowOS',lastName:'Unsigned Test',dob:'1990-01-01',isMinor:false,customParticipantFields:{w:{displayText:'Weight (lbs)',value:'180'},h:{displayText:'Height (in)',value:'71'},s:{displayText:'Skier Type: (Check One)',value:'II'}}}]};
      const participant=normalizeIntake(waiver).participants[0];
      const review={reviewed:true,waiverId:waiver.waiverId,participantIndex:0,participant:{first_name:participant.first_name,last_name:participant.last_name},source:{weight_lb:participant.weight_lb,height_in:participant.height_in,age:participant.age,skier_type:participant.skier_type},calculated:{skierCode:'M',din:'7',bootSoleLengthMm:315}};
      draft=await during('prefill-build', () => buildLiabilityPrefill(waiver,intake,liability,0,review));templateId=liabilityId;
      technicalFields = syntheticTechnicalFields(draft.payload, liability);
    } else if (input.stage === 'liability') {
      if (typeof input.waiverId !== 'string' || !/^[a-zA-Z0-9_-]{6,128}$/.test(input.waiverId)) return res.status(400).json({ error: 'A valid intake ID is required.' });
      const [data, intake, liability] = await Promise.all([
        during('intake-read', () => sw.request(`/waivers/${encodeURIComponent(input.waiverId)}`)), template(intakeId, 'intake-template'), template(liabilityId, 'liability-template', { fresh: true }),
      ]);
      const matchesIntake = await during('intake-read', () => data.waiver && data.waiver.waiverId === input.waiverId && data.waiver.templateId === intakeId);
      if (!matchesIntake) return res.status(400).json({ error: 'The selected waiver is not this kiosk’s intake template.' });
      draft = await during('prefill-build', () => buildLiabilityPrefill(data.waiver, intake, liability, input.participantIndex ?? 0, input.technicianReview));
      templateId = liabilityId;
    } else return res.status(400).json({ error: 'Choose intake or liability.' });
    if (staffStage) await requireStaff(req);
    const result = await during('prefill-create', () => sw.request(`/templates/${encodeURIComponent(templateId)}/prefill`, { method: 'POST', body: draft.payload }));
    const url = await during('prefill-response', () => {
      if (typeof result.prefill?.uuid !== 'string' || !result.prefill.uuid) throw new Error('Missing Smartwaiver prefill ID.');
      return safePrefillUrl(result.prefill.url, draft.tag, result.prefill.uuid);
    });
    return res.status(200).json({ url, copiedFields: draft.copiedFields, skippedFields: draft.skippedFields, reviewRequired: true, ...(technicalFields ? { technicalFields } : {}) });
  } catch (error) {
    const status = [401,403,503].includes(error.status) ? error.status : error instanceof SyntaxError ? 400 : error.statusCode === 400 ? 400 : error.status === 429 || error.statusCode === 429 ? 429 : 502;
    // Validation messages are ours. Upstream bodies can contain customer details.
    const message = [401,403,503].includes(error.status) ? error.message : error instanceof SyntaxError ? 'Invalid JSON request.' : error.statusCode === 400 ? error.message : 'Unable to prepare Smartwaiver right now. Please try again; no waiver has been signed.';
    const operation = OPERATIONS.has(error.operation) ? error.operation : '';
    const upstreamStatus = Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599 ? error.upstreamStatus : null;
    const reference = operation ? ` [${operation}${upstreamStatus === null ? '' : `; HTTP ${upstreamStatus}`}]` : '';
    if (status === 429 && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(status).json({ error: message + reference });
  }
};
