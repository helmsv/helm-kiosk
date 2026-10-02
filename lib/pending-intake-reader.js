// This reader returns private staff-only rows. Callers MUST authenticate/authorize
// staff before invoking it or returning its rows. api/open-intakes.js does so.
// Inject a server-only, read-only Smartwaiver client. Never expose the key.
const { normalizeIntake } = require('./intake-normalize');

const DEFAULT_POLICY = Object.freeze({
  pageSize: 300,
  detailsPerRead: 6,
  requestsPerMinute: 40,
  summaryTtlMs: 10000,
  detailTtlMs: 30 * 60 * 1000,
  failureTtlMs: 30000,
  maxSummaryEntries: 8,
  maxDetailEntries: 600,
});
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const text = value => typeof value === 'string' ? value.trim() : '';
function error(message, status = 502, retryAfterSeconds = 0) {
  return Object.assign(new Error(message), { status, retryAfterSeconds });
}
function signedOn(value) {
  const input = text(value).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, '$1T$2Z');
  const time = Date.parse(input);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
function normalizedRows(waiver, summary, now) {
  const normalized = normalizeIntake(waiver, new Date(now));
  const tag = text(waiver.autoTag || summary.autoTag);
  // Explicit allowlist, not a spread: do not cache or return DOBs, addresses,
  // guardian records, raw custom fields, PDFs, or signatures.
  return normalized.participants.map(person => ({
    waiver_id: normalized.waiver_id,
    participant_index: person.participant_index,
    signed_on: signedOn(waiver.createdOn || summary.createdOn),
    intake_pdf_url: '',
    lightspeed_id: tag.startsWith('ls_') ? tag.slice(3) : '',
    email: normalized.email,
    first_name: person.first_name,
    last_name: person.last_name,
    age: person.age,
    height_in: person.height_in,
    weight_lb: person.weight_lb,
    skier_type: person.skier_type,
  }));
}
function validateInput({ templateId, fromDts, toDts, page = 0 }) {
  if (typeof templateId !== 'string' || !ID.test(templateId)) throw error('A configured intake template is required.', 400);
  if (!Number.isSafeInteger(page) || page < 0 || page > 10000) throw error('Invalid intake page.', 400);
  const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (!iso(fromDts) || !iso(toDts) || Date.parse(fromDts) >= Date.parse(toDts)) throw error('A valid inclusive-start, exclusive-end date range is required.', 400);
  return { templateId, fromDts: new Date(fromDts).toISOString(), toDts: new Date(toDts).toISOString(), page };
}

// Each reader belongs to ONE fixed server-side account/client. A per-instance
// limiter cannot enforce Smartwaiver's account-wide limit across serverless
// instances, other endpoints, or other apps. See docs/pending-intake-reader.md.
function createPendingIntakeReader({ request, now = Date.now, policy = {} } = {}) {
  if (typeof request !== 'function') throw new TypeError('Inject a server-only read-only Smartwaiver request function.');
  const limits = { ...DEFAULT_POLICY, ...policy };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid policy: ${name}`);
  if (limits.pageSize > 300) throw new TypeError('Smartwaiver pageSize cannot exceed 300.');
  if (limits.maxDetailEntries < limits.pageSize) throw new TypeError('The detail cache must hold at least one complete page.');
  const summaries = new Map(), details = new Map();
  let requestTimes = [], blockedUntil = 0;

  function prune(cache) {
    for (const [key, entry] of cache) if (!entry.promise && entry.expiresAt <= now()) cache.delete(key);
  }
  function remember(cache, key, entry, maximum) {
    cache.delete(key); cache.set(key, entry);
    while (cache.size > maximum) cache.delete(cache.keys().next().value);
    return entry;
  }
  function get(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (!entry.promise && entry.expiresAt <= now()) { cache.delete(key); return null; }
    // LRU access order; the retention bound is independent of range/page count.
    cache.delete(key); cache.set(key, entry);
    return entry;
  }
  function waitSeconds() {
    requestTimes = requestTimes.filter(time => time > now() - 60000);
    const budgetReady = requestTimes.length >= limits.requestsPerMinute ? requestTimes[0] + 60000 : 0;
    return Math.max(0, Math.ceil((Math.max(blockedUntil, budgetReady) - now()) / 1000));
  }
  async function limitedRequest(path) {
    const wait = waitSeconds();
    if (wait) throw error('Intake loading is paused briefly to respect Smartwaiver limits.', 429, wait);
    requestTimes.push(now());
    try { return await request(path); }
    catch (cause) {
      // Only consume the structured status and Retry-After from the client.
      // Never propagate upstream body text, URLs, secrets, or arbitrary messages.
      if (cause?.status === 429) {
        const supplied = Number(cause.retryAfterSeconds);
        const seconds = Number.isFinite(supplied) && supplied > 0 ? Math.ceil(supplied) : 60;
        blockedUntil = Math.max(blockedUntil, now() + seconds * 1000);
        throw error('Smartwaiver is busy. Please wait before trying again.', 429, seconds);
      }
      throw error('Unable to load signed intake data.', cause?.status === 404 ? 404 : 502);
    }
  }
  async function getSummaries(input) {
    const cacheKey = JSON.stringify(input);
    const existing = get(summaries, cacheKey);
    if (existing) {
      if (existing.promise) await existing.promise;
      if (existing.failure) throw existing.failure;
      return existing.value;
    }
    const entry = remember(summaries, cacheKey, {}, limits.maxSummaryEntries);
    entry.promise = (async () => {
      try {
        const query = new URLSearchParams({ templateId: input.templateId, verified: 'true', limit: String(limits.pageSize), offset: String(input.page), fromDts: input.fromDts, toDts: input.toDts });
        const payload = await limitedRequest(`/waivers?${query}`);
        if (!Array.isArray(payload?.waivers) || payload.waivers.length > limits.pageSize) throw error('Smartwaiver returned an invalid intake list.');
        const seen = new Set(); let rejected = 0;
        const waivers = [];
        for (const waiver of payload.waivers) {
          // Do not trust a filtered upstream response without checking its IDs.
          if (!waiver || typeof waiver.waiverId !== 'string' || !ID.test(waiver.waiverId) || waiver.templateId !== input.templateId) { rejected++; continue; }
          if (seen.has(waiver.waiverId)) continue;
          seen.add(waiver.waiverId);
          waivers.push({ waiverId: waiver.waiverId, createdOn: text(waiver.createdOn || waiver.created), autoTag: text(waiver.autoTag) });
        }
        entry.value = { waivers, rejected, hasMore: payload.waivers.length >= limits.pageSize };
        entry.expiresAt = now() + limits.summaryTtlMs;
      } catch (cause) {
        entry.failure = cause;
        entry.expiresAt = now() + Math.max(limits.failureTtlMs, (cause.retryAfterSeconds || 0) * 1000);
      } finally { entry.promise = null; }
    })();
    await entry.promise;
    if (entry.failure) throw entry.failure;
    return entry.value;
  }
  async function hydrate(summary, templateId) {
    const key = `${templateId}:${summary.waiverId}`;
    const existing = get(details, key);
    if (existing) { if (existing.promise) await existing.promise; return; }
    const entry = remember(details, key, {}, limits.maxDetailEntries);
    entry.promise = (async () => {
      try {
        const payload = await limitedRequest(`/waivers/${encodeURIComponent(summary.waiverId)}?pdf=false`);
        const waiver = payload?.waiver;
        if (!waiver || waiver.waiverId !== summary.waiverId || waiver.templateId !== templateId) throw error('The returned waiver does not match the selected intake.');
        if (!Array.isArray(waiver.participants) || !waiver.participants.length || waiver.participants.some(person => !person || typeof person !== 'object' || Array.isArray(person))) throw error('The signed intake has no valid participant list.');
        entry.rows = normalizedRows(waiver, summary, now());
        const date = new Date(now());
        const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
        // Age must not remain cached over a birthday. Cache only derived age.
        entry.expiresAt = Math.min(now() + limits.detailTtlMs, midnight);
      } catch (cause) {
        entry.failed = true;
        entry.expiresAt = now() + Math.max(limits.failureTtlMs, (cause.retryAfterSeconds || 0) * 1000);
      } finally { entry.promise = null; }
    })();
    await entry.promise;
  }
  return {
    async read(options) {
      const input = validateInput(options || {});
      prune(summaries); prune(details);
      const listing = await getSummaries(input);
      let requested = 0;
      // Bounded, sequential batches stop immediately when an upstream 429 arrives.
      // Other requests join in-flight hydration rather than duplicate the read.
      for (const summary of listing.waivers) {
        const cached = get(details, `${input.templateId}:${summary.waiverId}`);
        if (cached) { if (cached.promise) await cached.promise; continue; }
        if (requested >= limits.detailsPerRead || waitSeconds()) break;
        requested++;
        await hydrate(summary, input.templateId);
      }
      const rows = []; let loaded = 0, pending = 0, failed = 0, retry = waitSeconds();
      for (const summary of listing.waivers) {
        const entry = get(details, `${input.templateId}:${summary.waiverId}`);
        if (entry?.rows) { loaded++; rows.push(...entry.rows.map(row => ({ ...row }))); }
        else if (entry?.failed) { failed++; retry = Math.max(retry, Math.ceil((entry.expiresAt - now()) / 1000)); }
        else pending++;
      }
      return {
        rows, count: rows.length, from: input.fromDts, to: input.toDts,
        waiver_count: listing.waivers.length, loaded_waivers: loaded,
        pending_waivers: pending, failed_waivers: failed, rejected_waivers: listing.rejected,
        partial: Boolean(pending || failed || listing.rejected || listing.hasMore),
        retry_after_seconds: retry || (pending ? 3 : 0),
        pagination: { page: input.page, page_size: limits.pageSize, has_more: listing.hasMore, next_page: listing.hasMore ? input.page + 1 : null },
      };
    },
  };
}
module.exports = { createPendingIntakeReader, DEFAULT_POLICY };
