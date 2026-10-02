// Smartwaiver v4 client. Keep credentials server-side and upstream bodies out of errors.
function apiBase() {
  const base = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').trim().replace(/\/+$/, '');
  return base.endsWith('/v4') ? base : `${base}/v4`;
}
function apiKey() {
  return String(process.env.SW_API_KEY || process.env.SMARTWAIVER_API_KEY || '').trim().replace(/^"(.*)"$/, '$1');
}
function retryAfterSeconds(response, now = Date.now()) {
  const raw = response.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || !raw.trim()) return 60;
  if (/^\d+$/.test(raw.trim())) {
    const seconds = Number(raw.trim());
    return Number.isSafeInteger(seconds) ? Math.max(1, seconds) : 60;
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) && date > now ? Math.max(1, Math.ceil((date - now) / 1000)) : 60;
}
async function request(path, { method = 'GET', body } = {}) {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('Smartwaiver is not configured.'), { status: 503 });
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw Object.assign(new Error('Smartwaiver could not be reached. Please try again.'), { status: 502 });
  }
  // Retain only the numeric HTTP boundary, never the upstream body or headers.
  const http = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    ? { upstreamStatus: response.status } : {};
  if (!response.ok) {
    const status = response.status === 404 ? 404 : response.status === 429 ? 429 : 502;
    throw Object.assign(new Error(response.status === 404 ? 'The requested waiver was not found.' : response.status === 429 ? 'Smartwaiver is busy. Please wait before trying again.' : 'Smartwaiver could not complete the request.'), { status, ...http, ...(status === 429 ? { retryAfterSeconds: retryAfterSeconds(response) } : {}) });
  }
  try { return await response.json(); }
  catch { throw Object.assign(new Error('Smartwaiver returned an invalid response.'), { status: 502, ...http }); }
}
module.exports = { apiBase, apiKey, request, retryAfterSeconds };
