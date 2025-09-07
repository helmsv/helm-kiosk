// api/lookup.js — Lightspeed X-Series 2.0 search, read-only, robust & defensive

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
    console.error("URL build error:", e);
    return null;
  }
}
async function safeJson(resp) {
  const ct = resp.headers.get("content-type") || "";
  if (/application\/json/i.test(ct)) return await resp.json();
  const txt = await resp.text();
  return { _nonjson: txt.slice(0, 300) };
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

// ---------- main handler ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const first_name = (body.first_name || "").trim();
    const last_name  = (body.last_name  || "").trim();
    const email      = (body.email      || "").trim();

    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const base  = process.env.LS_BASE_URL;   // e.g. https://helmsv.retail.lightspeed.app (with or without /api/2.0)
    const token = process.env.LS_TOKEN;      // raw token string (NO "Bearer " prefix here)

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

    // --- BEGIN LOOKUP BLOCK ---

const base = process.env.LS_BASE_URL;
const token = process.env.LS_TOKEN;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

let customer = null;

const emailQ = (email || "").trim();
const emailLc = emailQ.toLowerCase();
const fnQ = (first_name || "").trim();
const lnQ = (last_name || "").trim();

// 0) Log retailer (one-time diag)
try {
  const rret = await fetch(safeUrl(base, "/retailers"), { headers });
  console.log("Retailer status:", rret.status);
  const retData = await safeJson(rret);
  console.log("Retailer peek:", JSON.stringify(retData).slice(0, 160));
} catch (e) {
  console.error("Retailer check error:", e);
}

async function tryEndpoint(desc, path, qs) {
  const u = safeUrl(base, path, qs);
  console.log(`${desc} URL:`, u);
  if (!u) return [];
  const r = await fetch(u, { headers });
  console.log(`${desc} status:`, r.status);
  const data = await safeJson(r);
  if (!r.ok) console.error(`${desc} body:`, data);
  const arr = Array.isArray(data?.customers) ? data.customers
            : Array.isArray(data) ? data
            : [];
  console.log(`${desc} results:`, arr.length);
  return arr;
}

// 1) Exact email (per docs)
try {
  const byEmail = await tryEndpoint("Search(email)", "/search", { type: "customers", email: emailQ });
  if (byEmail.length) {
    customer =
      byEmail.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) ||
      byEmail[0];
  }
} catch (e) { console.error("Search(email) error:", e); }

// 2) Name fallback
if (!customer && (fnQ || lnQ)) {
  try {
    const byName = await tryEndpoint("Search(name)", "/search", { type: "customers", first_name: fnQ, last_name: lnQ });
    if (byName.length) customer = byName[0];
  } catch (e) { console.error("Search(name) error:", e); }
}

// 3) Generic q (many tenants match this well)
if (!customer && emailQ) {
  try {
    const byQ = await tryEndpoint("Search(q=email)", "/search", { type: "customers", q: emailQ });
    if (byQ.length) {
      customer =
        byQ.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) ||
        byQ[0];
    }
  } catch (e) { console.error("Search(q) error:", e); }
}

// 4) Mobile / phone fallback (if you have it later)
if (!customer && body.mobile) {
  try {
    const byMob = await tryEndpoint("Search(mobile)", "/search", { type: "customers", mobile: String(body.mobile).trim() });
    if (byMob.length) customer = byMob[0];
  } catch (e) { console.error("Search(mobile) error:", e); }
}

// 5) Customer code (some retailers use this)
if (!customer && body.customer_code) {
  try {
    const byCode = await tryEndpoint("Search(customer_code)", "/search", { type: "customers", customer_code: String(body.customer_code).trim() });
    if (byCode.length) customer = byCode[0];
  } catch (e) { console.error("Search(customer_code) error:", e); }
}

// --- END LOOKUP BLOCK ---

    // ----- Map output (no creation; read-only) -----
    const rawDob =
      customer?.date_of_birth ||
      customer?.dob ||
      customer?.custom?.date_of_birth ||
      customer?.custom?.dob ||
      "";

    const dobIso       = toIsoDob(rawDob);
    const dobYyyymmdd  = toYyyymmdd(dobIso);

    // Try multiple possible ID fields to be safe
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

    const out = {
      match_quality,
      lightspeed_id: String(idCandidate || ""),
      first_name: customer?.first_name || first_name,
      last_name:  customer?.last_name  || last_name,
      email:      customer?.email      || email,
      mobile:     customer?.mobile     || customer?.phone || "",
      date_of_birth: dobIso,
      dob_yyyymmdd:  dobYyyymmdd,   // client will fallback to 19050101 if empty
      street:   customer?.street || customer?.physical_address?.street || "",
      city:     customer?.city   || customer?.physical_address?.city   || "",
      state:    customer?.state  || customer?.physical_address?.state  || "",
      postcode: customer?.postcode || customer?.physical_address?.postal_code || "",
      country:  customer?.country  || customer?.physical_address?.country     || ""
    };

    return res.status(200).json(out);
  } catch (e) {
    // FINAL CATCH: never crash the function
    console.error("lookup fatal:", e);
    const b = req.body || {};
    return res.status(200).json({
      match_quality: "new",
      lightspeed_id: "",
      first_name: b.first_name || "",
      last_name:  b.last_name  || "",
      email:      b.email      || "",
      mobile: "",
      date_of_birth: "",
      dob_yyyymmdd: "",
      street: "", city: "", state: "", postcode: "", country: ""
    });
  }
};