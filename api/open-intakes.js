// Private participant-row view. Never issue a Smartwaiver read before staff auth.
const { createHash } = require('node:crypto');
const { apiBase, apiKey, request } = require('../lib/smartwaiver');
const { createPendingIntakeReader } = require('../lib/pending-intake-reader');
let reader, readerIdentity;

function invalidRange() { return Object.assign(new Error('Invalid intake date range or page.'), { status: 400 }); }
function dateOnly(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function startOfDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalidRange();
  return date;
}
function range(query) {
  let { from, to, page = '0' } = query || {};
  if (typeof page !== 'string' || !/^\d{1,5}$/.test(page) || Number(page) > 10000) throw invalidRange();
  if (!from && !to) from = to = new Date().toISOString().slice(0, 10);
  let fromDts = from, toDts = to;
  if (dateOnly(from) && dateOnly(to)) {
    fromDts = startOfDay(from).toISOString();
    const end = startOfDay(to); end.setUTCDate(end.getUTCDate() + 1); toDts = end.toISOString();
  }
  return { fromDts, toDts, page: Number(page) };
}
function privateReader() {
  // Account/key rotation must not reuse another account's in-memory rows.
  const identity = createHash('sha256').update(JSON.stringify([apiBase(), apiKey()])).digest('hex');
  if (!reader || readerIdentity !== identity) {
    readerIdentity = identity;
    reader = createPendingIntakeReader({ request });
  }
  return reader;
}
const messages = {
  400: 'Invalid intake date range or page.',
  401: 'Staff sign-in is required.',
  403: 'Staff access is required.',
  404: 'The requested intake was not found.',
  429: 'Smartwaiver is busy. Please wait before trying again.',
  502: 'Unable to load intake rows. Please try again.',
  503: 'Staff access or intake data is not configured.',
};
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    // Lazy import also fails closed if the auth integration is absent/unavailable.
    const { requireStaff } = require('../lib/staff-auth');
    await requireStaff(req);
    if (req.method && req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ rows: [], error: 'Method not allowed.' });
    }
    const templateId = process.env.INTAKE_WAIVER_ID || process.env.INTAKE_TEMPLATE_ID;
    if (!apiKey() || !templateId) return res.status(503).json({ rows: [], error: messages[503] });
    const result = await privateReader().read({ ...range(req.query), templateId });
    return res.status(200).json(result);
  } catch (cause) {
    const status = Object.hasOwn(messages, cause?.status) ? Number(cause.status) : 502;
    const retry = status === 429 && Number.isFinite(Number(cause?.retryAfterSeconds)) ? Math.max(1, Math.ceil(Number(cause.retryAfterSeconds))) : status === 429 ? 60 : 0;
    if (retry) res.setHeader('Retry-After', String(retry));
    return res.status(status).json({ rows: [], error: messages[status], ...(retry ? { retry_after_seconds: retry } : {}) });
  }
};
