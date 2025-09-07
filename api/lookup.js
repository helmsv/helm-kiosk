// api/lookup.js — Crash-proof Lightspeed X-Series 2.0 lookup (GET-only)

// ---------- helpers ----------
function normalizeBase(u) {
  if (!u) return "";
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;   // ensure scheme
  s = s.replace(/\/+$/,"");                            // trim trailing slashes
  if (!/\/api\/2\.0$/i.test(s)) s = s + "/api/2.0";    // ensure /api/2.0
  return s;
}
function safeUrl(base, path, qs) {
  const b = normalizeBase(base);
  if (!b) return null;
  try {
    const u = new URL(b + (path.startsWith("/") ? path : "/" + path));
    if (qs && typeof qs === "object") {
      for (const [k,v] of Object.entries(qs)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  } catch (e) {
    console.error("URL build error:", e?.message || e);
    return null;
  }
}
async function safeJson(resp) {
  try {
    const ct = resp.headers.get("content-type") || "";
    if (/application\/json/i.test(ct)) return await resp.json();
    const txt = await resp.text();
    return { _nonjson: String(txt).slice(0, 300) };
  } catch (e) {
    return { _parse_error: String(e?.message || e) };
  }
}
function toIsoDob(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;          // ISO
  if (/^\d{8}$/.test(s)) {                               // YYYYMMDD
    const yyyy = s.slice(0,4), mm = s.slice(4,6), dd = s.slice(6,8);
    return `${yyyy}-${mm}-${dd}`;
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);  // MM/DD/YYYY
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
  }
  return "";
}
function toYyyymmdd(iso) {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const [, yyyy, mm, dd] = m;
  return `${yyyy}${mm}${dd}`;
}
// fetch with timeout
async function fetchTO(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- main handler ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Body can arrive as object or JSON string depending on deploy/runtime
    let body = req.body ?? {};
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }

    const first_name = (body.first_name || "").trim();
    const last_name  = (body.last_name  || "").trim();
    const email      = (body.email      || "").trim();

    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const base  = process.env.LS_BASE_URL;
    const token = process.env.LS_TOKEN; // raw token (no "Bearer ")

    console.log("ENV present?", { hasBase: !!base, hasToken: !!token });

    // If envs missing, return safe NEW so client can proceed with dummy DOB
    if (!base || !token) {
      console.warn("Lightspeed env missing; returning NEW without lookup");
      return res.status(200).json({
        match_quality: "new",
        lightspeed_id: "",
        first_name, last_name, email,
        mobile: "",
        date_of_birth: "",
        dob_yyyymmdd: "",
        street: "", city: "", state: "", postcode: "", country: ""
      });
    }

    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    let customer = null;
    const emailLc = email.toLowerCase();

    async function tryEndpoint(desc, path, qs) {
      const u = safeUrl(base, path, qs);
      console.log(`${desc} URL:`, u);
      if (!u) return [];
      try {
        const r = await fetchTO(u, { headers }, 12000);
        console.log(`${desc} status:`, r.status);
        const data = await safeJson(r);
        if (!r.ok) console.error(`${desc} body:`, data);
        const arr = Array.isArray(data?.customers) ? data.customers
                  : Array.isArray(data) ? data
                  : [];
        console.log(`${desc} results:`, arr.length);
        return arr;
      } catch (e) {
        console.error(`${desc} fetch error:`, e?.name === 'AbortError' ? 'Timeout' : (e?.message || e));
        return [];
      }
    }

    // (0) Optional: verify retailer for diagnostics; never throw
    try {
      const rret = await fetchTO(safeUrl(base, "/retailers"), { headers }, 8000);
      console.log("Retailer status:", rret?.status);
      const peek = await safeJson(rret);
      console.log("Retailer peek:", JSON.stringify(peek).slice(0,160));
    } catch (e) {
      console.error("Retailer check error:", e?.message || e);
    }

    // 1) Exact email search (per LS 2.0 docs)
    const byEmail = await tryEndpoint("Search(email)", "/search", { type: "customers", email });
    if (byEmail.length) {
      customer =
        byEmail.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) ||
        byEmail[0];
    }

    // 2) Name fallback
    if (!customer && (first_name || last_name)) {
      const byName = await tryEndpoint("Search(name)", "/search", { type: "customers", first_name, last_name });
      if (byName.length) customer = byName[0];
    }

    // 3) Generic q fallback (some tenants)
    if (!customer && email) {
      const byQ = await tryEndpoint("Search(q=email)", "/search", { type: "customers", q: email });
      if (byQ.length) {
        customer =
          byQ.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) ||
          byQ[0];
      }
    }

    // ----- Map output (no creation; read-only) -----
    const rawDob =
      customer?.date_of_birth ||
      customer?.dob ||
      customer?.custom?.date_of_birth ||
      customer?.custom?.dob ||
      "";

    const dobIso       = toIsoDob(rawDob);
    const dobYyyymmdd  = toYyyymmdd(dobIso);

    // Robust ID detection (tenants differ)
    const idCandidate =
      customer?.id ??
      customer?.customer_id ??
      customer?.customer?.id ??
      customer?.customerId ??
      customer?.uuid ??
      "";

    console.log("RESOLVED customer id:", idCandidate);

    const match_quality = customer
      ? (customer.email && customer.email.trim().toLowerCase() === emailLc ? "exact" : "partial")
      : "new";

    return res.status(200).json({
      match_quality,
      lightspeed_id: String(idCandidate || ""),
      first_name: customer?.first_name || first_name,
      last_name:  customer?.last_name  || last_name,
      email:      customer?.email      || email,
      mobile:     customer?.mobile     || customer?.phone || "",
      date_of_birth: dobIso,
      dob_yyyymmdd:  dobYyyymmdd, // client will fallback to 19050101 if empty
      street:   customer?.street || customer?.physical_address?.street || "",
      city:     customer?.city   || customer?.physical_address?.city   || "",
      state:    customer?.state  || customer?.physical_address?.state  || "",
      postcode: customer?.postcode || customer?.physical_address?.postal_code || "",
      country:  customer?.country  || customer?.physical_address?.country     || ""
    });

  } catch (e) {
    // FINAL CATCH: never crash the function
    console.error("lookup fatal:", e?.message || e);
    // Fall back to "new" so the kiosk can continue
    return res.status(200).json({
      match_quality: "new",
      lightspeed_id: "",
      first_name: "",
      last_name:  "",
      email:      "",
      mobile: "",
      date_of_birth: "",
      dob_yyyymmdd: "",
      street: "", city: "", state: "", postcode: "", country: ""
    });
  }
};