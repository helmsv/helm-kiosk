// api/lookup.js — Lightspeed X-Series 2.0 search, read-only, robust

// ---------- helpers ----------
function normalizeBase(u) {
  if (!u) return "";
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;   // ensure scheme
  s = s.replace(/\/+$/,"");                            // trim trailing slashes
  // allow either raw tenant base or already /api/2.0
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

// ---------- handler ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const { first_name, last_name, email } = body;
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const base = process.env.LS_BASE_URL;   // ex: https://helmsv.retail.lightspeed.app  (with or without /api/2.0)
    const token = process.env.LS_TOKEN;

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

    // normalize inputs for matching
    const emailQ = (email || "").trim();
    const emailLc = emailQ.toLowerCase();
    const fnQ = (first_name || "").trim();
    const lnQ = (last_name || "").trim();

    let customer = null;

    // --- EXACT URL per your reference: /api/2.0/search?type=customers&email=<encoded> ---
    try {
      const emailUrl = safeUrl(base, "/search", { type: "customers", email: emailQ });
      console.log("Search by email URL:", emailUrl);
      if (emailUrl) {
        const r = await fetch(emailUrl, { headers });
        console.log("Search by email status:", r.status);
        const data = await safeJson(r);
        if (!r.ok) console.error("Search by email body:", data);
        const arr = Array.isArray(data?.customers) ? data.customers : [];
        console.log("Search by email results:", arr.length);
        if (arr.length > 0) {
          customer =
            arr.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) ||
            arr[0];
        }
      }
    } catch (err) { console.error("Search by email error:", err); }

    // Fallback 1: /api/2.0/search?type=customers&first_name=&last_name=
    if (!customer && (fnQ || lnQ)) {
      try {
        const nameUrl = safeUrl(base, "/search", { type: "customers", first_name: fnQ, last_name: lnQ });
        console.log("Search by name URL:", nameUrl);
        if (nameUrl) {
          const r2 = await fetch(nameUrl, { headers });
          console.log("Search by name status:", r2.status);
          const data2 = await safeJson(r2);
          if (!r2.ok) console.error("Search by name body:", data2);
          const arr2 = Array.isArray(data2?.customers) ? data2.customers : [];
          console.log("Search by name results:", arr2.length);
          if (arr2.length > 0) customer = arr2[0];
        }
      } catch (err) { console.error("Search by name error:", err); }
    }

    // Fallback 2: generic 'q' search some tenants prefer
    if (!customer && emailQ) {
      try {
        const qUrl = safeUrl(base, "/search", { type: "customers", q: emailQ });
        console.log("Search by q URL:", qUrl);
        if (qUrl) {
          const r3 = await fetch(qUrl, { headers });
          console.log("Search by q status:", r3.status);
          const data3 = await safeJson(r3);
          if (!r3.ok) console.error("Search by q body:", data3);
          const arr3 = Array.isArray(data3?.customers) ? data3.customers : [];
          console.log("Search by q results:", arr3.length);
          if (arr3.length > 0) {
            customer =
              arr3.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) ||
              arr3[0];
          }
        }
      } catch (err) { console.error("Search by q error:", err); }
    }

    // Map output (no creation; read-only)
    const rawDob =
      customer?.date_of_birth ||
      customer?.dob ||
      customer?.custom?.date_of_birth ||
      customer?.custom?.dob ||
      "";

    const dobIso = toIsoDob(rawDob);
    const dobYyyymmdd = toYyyymmdd(dobIso);

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
      last_name: customer?.last_name || last_name,
      email: customer?.email || email,
      mobile: customer?.mobile || customer?.phone || "",
      date_of_birth: dobIso,
      dob_yyyymmdd: dobYyyymmdd,   // client will fallback to 19050101 if empty
      street: customer?.street || customer?.physical_address?.street || "",
      city: customer?.city || customer?.physical_address?.city || "",
      state: customer?.state || customer?.physical_address?.state || "",
      postcode: customer?.postcode || customer?.physical_address?.postal_code || "",
      country: customer?.country || customer?.physical_address?.country || ""
    };

    return res.status(200).json(out);
  } catch (e) {
    console.error("lookup fatal:", e);
    const b = req.body || {};
    return res.status(200).json({
      match_quality: "new",
      lightspeed_id: "",
      first_name: b.first_name,
      last_name: b.last_name,
      email: b.email,
      mobile: "",
      date_of_birth: "",
      dob_yyyymmdd: "",
      street: "", city: "", state: "", postcode: "", country: ""
    });
  }
};