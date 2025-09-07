// api/lookup.js  — READ-ONLY lookups, defensive against bad/missing env

// ---------- URL helpers ----------
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
  if (!b) return null; // no base -> cannot build
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

// ---------- DOB normalization ----------
function toIsoDob(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;            // ISO
  if (/^\d{8}$/.test(s)) {                                // YYYYMMDD
    const yyyy = s.slice(0,4), mm = s.slice(4,6), dd = s.slice(6,8);
    return `${yyyy}-${mm}-${dd}`;
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);   // MM/DD/YYYY
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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const { first_name, last_name, email } = body;
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const base = process.env.LS_BASE_URL;   // e.g. https://helmsv.retail.lightspeed.app or .../api/2.0
    const token = process.env.LS_TOKEN;

    // ---- DIAGNOSTIC GUARD: if env missing, return safe JSON so client can proceed ----
    if (!base || !token) {
      console.warn("Lightspeed env missing: LS_BASE_URL or LS_TOKEN not set; returning NEW without lookup");
      return res.status(200).json({
        match_quality: "new",
        lightspeed_id: "",
        first_name, last_name, email,
        mobile: "",
        date_of_birth: "",
        dob_yyyymmdd: "",  // client will fallback to 19050101
        street: "", city: "", state: "", postcode: "", country: ""
      });
    }

    // --- replace ONLY the lookup section in your current file with this ---

const base = process.env.LS_BASE_URL;
const token = process.env.LS_TOKEN;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

let customer = null;

// 1) Try email via /search (2.0)
try {
  const emailUrl = safeUrl(base, "/search", { type: "customers", email });
  if (emailUrl) {
    const r = await fetch(emailUrl, { headers });
    if (r.ok) {
      const data = await r.json();
      // Results can come back as { customers: [...] } on 2.0 search
      const arr = Array.isArray(data?.customers) ? data.customers : [];
      if (arr.length > 0) {
        // prefer exact email match (case-insensitive)
        customer =
          arr.find(c => (c.email || "").toLowerCase() === email.toLowerCase()) ||
          arr[0];
      }
    } else {
      console.error("Search by email HTTP", r.status, await r.text().catch(()=>""));
    }
  }
} catch (err) {
  console.error("Search by email error:", err);
}

// 2) Fallback: first + last name via /search (2.0)
if (!customer) {
  try {
    const nameUrl = safeUrl(base, "/search", { type: "customers", first_name, last_name });
    if (nameUrl) {
      const r2 = await fetch(nameUrl, { headers });
      if (r2.ok) {
        const data2 = await r2.json();
        const arr2 = Array.isArray(data2?.customers) ? data2.customers : [];
        if (arr2.length > 0) customer = arr2[0];
      } else {
        console.error("Search by name HTTP", r2.status, await r2.text().catch(()=>""));
      }
    }
  } catch (err) {
    console.error("Search by name error:", err);
  }
}

    // Map & normalize (READ-ONLY; no create)
    const rawDob =
      customer?.date_of_birth ||
      customer?.dob ||
      customer?.custom?.date_of_birth ||
      customer?.custom?.dob ||
      "";

    const dobIso = toIsoDob(rawDob);
    const dobYyyymmdd = toYyyymmdd(dobIso);

    const match_quality = customer
      ? (customer.email && customer.email.toLowerCase() === email.toLowerCase() ? "exact" : "partial")
      : "new";

    const out = {
      match_quality,
      lightspeed_id: customer?.id || customer?.customer_id || customer?.customer?.id || "",
      first_name: customer?.first_name || first_name,
      last_name: customer?.last_name || last_name,
      email: customer?.email || email,
      mobile: customer?.mobile || customer?.phone || "",
      date_of_birth: dobIso,
      dob_yyyymmdd: dobYyyymmdd,    // client will fallback to 19050101 if empty
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
    // Always return valid JSON so the client never sees "Failed to load response data"
    return res.status(200).json({
      match_quality: "new",
      lightspeed_id: "",
      first_name: b.first_name,
      last_name: b.last_name,
      email: b.email,
      mobile: "",
      date_of_birth: "",
      dob_yyyymmdd: "",
      street: "",
      city: "",
      state: "",
      postcode: "",
      country: ""
    });
  }
};