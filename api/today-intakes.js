// api/today-intakes.js
// Lists customers who signed INTAKE within a window but have NOT signed LIABILITY in that same window,
// matched by Smartwaiver tag "ls_<lightspeed_id>" (falls back to email when no tag exists).
// Also proxies Intake PDF via ?pdf=<waiverId> to avoid exposing your SW API key in the browser.
//
// Uses Smartwaiver Search workflow:
//   1) GET /v4/search?templateId=...&fromDts=...&toDts=...  -> returns {guid}
//   2) GET /v4/search/{guid}/results?page=N                 -> returns waivers page
//
// Adds a 15s in-memory cache for list mode to reduce API calls / rate-limits.

const SEARCH_PAGE_MAX = 100;         // Smartwaiver pages are size 100
const FETCH_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 15_000;         // 15 seconds

// ---- simple in-memory cache (per Vercel function instance) ----
let _cache = {
  ts: 0,
  key: "",
  payload: null
};

// --- utils ---
async function fetchTO(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function isoNow() { return new Date().toISOString(); }
// safer across DST: last 24 hours
function iso24hAgo() { return new Date(Date.now() - 24 * 3600 * 1000).toISOString(); }

function cacheGet(key) {
  const now = Date.now();
  if (_cache.key === key && (now - _cache.ts) < CACHE_TTL_MS && _cache.payload) {
    return _cache.payload;
  }
  return null;
}
function cacheSet(key, payload) {
  _cache = { ts: Date.now(), key, payload };
}

function normalizeRow(w) {
  const first = w?.firstName || w?.participantFirstName || w?.firstname || "";
  const last  = w?.lastName  || w?.participantLastName  || w?.lastname  || "";
  const email = (w?.email || "").trim().toLowerCase();
  const tag   = (Array.isArray(w?.tags) ? w.tags[0] : w?.tag) || "";
  const createdOn = w?.createdOn || w?.ts || w?.date || "";
  const lsId = (tag && String(tag).startsWith("ls_")) ? String(tag).slice(3) : "";
  const templateId = w?.templateId || w?.template_id || "";
  const waiverId = w?.waiverId || w?.uuid || w?.id || "";
  return {
    ls_tag: tag || (lsId ? `ls_${lsId}` : ""),
    lightspeed_id: lsId,
    email,
    first_name: first,
    last_name: last,
    signed_on: createdOn,
    waiver_template_id: templateId,
    waiver_id: waiverId
  };
}

// --- Smartwaiver API helpers (Search workflow) ---
async function swSearch({ key, templateId, fromDts, toDts, sort = "desc" }) {
  const url = new URL("https://api.smartwaiver.com/v4/search");
  if (templateId) url.searchParams.set("templateId", templateId);
  if (fromDts)    url.searchParams.set("fromDts", fromDts);
  if (toDts)      url.searchParams.set("toDts", toDts);
  url.searchParams.set("sort", sort); // desc -> newest first
  const r = await fetchTO(url.toString(), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }
  });
  if (!r.ok) {
    const peek = await r.text();
    throw new Error(`search failed ${r.status}: ${peek}`);
  }
  const j = await r.json();
  const guid = j?.search?.guid || j?.guid;
  if (!guid) throw new Error("search returned no guid");
  return { guid, pageCount: j?.search?.pages ?? undefined };
}

async function swSearchPage({ key, guid, page = 0 }) {
  const url = new URL(`https://api.smartwaiver.com/v4/search/${encodeURIComponent(guid)}/results`);
  url.searchParams.set("page", String(page));
  const r = await fetchTO(url.toString(), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }
  }, 30000);
  if (!r.ok) {
    const peek = await r.text();
    throw new Error(`results failed ${r.status}: ${peek}`);
  }
  const j = await r.json();
  const list = Array.isArray(j?.search_results) ? j.search_results : [];
  return list.map(normalizeRow);
}

async function swSearchAll({ key, templateId, fromDts, toDts }) {
  const { guid, pageCount } = await swSearch({ key, templateId, fromDts, toDts, sort: "desc" });
  const maxPages = Number.isFinite(pageCount) ? pageCount : 10; // sane cap
  const out = [];
  for (let p = 0; p < maxPages; p++) {
    const pageRows = await swSearchPage({ key, guid, page: p });
    if (pageRows.length === 0) break;
    out.push(...pageRows);
    if (pageRows.length < SEARCH_PAGE_MAX) break;
  }
  return out;
}

// --- PDF proxy (keeps API key server-side; no caching here) ---
async function handlePdfProxy(req, res) {
  const key = process.env.SW_API_KEY;
  const waiverId = String(req.query?.pdf || "").trim();
  if (!key || !waiverId) return res.status(400).send("Missing SW_API_KEY or pdf (waiverId)");

  try {
    const u = `https://api.smartwaiver.com/v4/waivers/${encodeURIComponent(waiverId)}/pdf`;
    const r = await fetchTO(u, { headers: { Authorization: `Bearer ${key}` } }, 30000);
    if (!r.ok) return res.status(r.status).send(await r.text());
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="intake-${waiverId}.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (e) {
    console.error("PDF proxy error:", e?.message || e);
    return res.status(500).send("Failed to fetch PDF");
  }
}

// --- main handler ---
module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // PDF passthrough (no cache)
  if (req.query && typeof req.query.pdf !== "undefined") {
    return handlePdfProxy(req, res);
  }

  try {
    const key = process.env.SW_API_KEY;
    const INTAKE_ID = process.env.INTAKE_WAIVER_ID;
    const LIABILITY_ID = process.env.LIABILITY_WAIVER_ID;

    if (!key || !INTAKE_ID || !LIABILITY_ID) {
      return res.status(200).json({ rows: [], error: "Missing SW env (SW_API_KEY / INTAKE_WAIVER_ID / LIABILITY_WAIVER_ID)" });
    }

    // Window = last 24 hours
    const fromDts = iso24hAgo();
    const toDts   = isoNow();

    // ---- cache check (keyed by window + template IDs) ----
    const cacheKey = `v1|${fromDts}|${toDts}|${INTAKE_ID}|${LIABILITY_ID}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    // Pull INTAKE and LIABILITY within window
    const [intakes, liabilities] = await Promise.all([
      swSearchAll({ key, templateId: INTAKE_ID, fromDts, toDts }),
      swSearchAll({ key, templateId: LIABILITY_ID, fromDts, toDts })
    ]);

    // Build lookups
    const liabByTag = new Map();
    const liabByEmail = new Map();
    for (const r of liabilities) {
      const tag = r.ls_tag || "";
      const email = r.email || "";
      if (tag) liabByTag.set(tag, true);
      else if (email) liabByEmail.set(email, true);
    }

    // Most recent intake per tag/email
    const candidatesByTag = new Map();
    const candidatesByEmail = new Map();

    for (const r of intakes) {
      r.intake_pdf_url = `/api/today-intakes?pdf=${encodeURIComponent(r.waiver_id)}`;
      const keyTag = r.ls_tag || "";
      if (keyTag) {
        const cur = candidatesByTag.get(keyTag);
        if (!cur || String(r.signed_on).localeCompare(cur.signed_on) > 0) {
          candidatesByTag.set(keyTag, r);
        }
      } else if (r.email) {
        const keyEmail = r.email;
        const cur = candidatesByEmail.get(keyEmail);
        if (!cur || String(r.signed_on).localeCompare(cur.signed_on) > 0) {
          candidatesByEmail.set(keyEmail, r);
        }
      }
    }

    const out = [];
    for (const [tag, latest] of candidatesByTag.entries()) {
      if (!liabByTag.get(tag)) out.push(latest);
    }
    for (const [email, latest] of candidatesByEmail.entries()) {
      if (!liabByEmail.get(email)) out.push(latest);
    }

    out.sort((a, b) => String(b.signed_on).localeCompare(String(a.signed_on)));

    const payload = { rows: out, from: fromDts, to: toDts };
    cacheSet(cacheKey, payload);
    return res.status(200).json(payload);
  } catch (e) {
    console.error("today-intakes fatal:", e?.message || e);
    return res.status(200).json({ rows: [] });
  }
};