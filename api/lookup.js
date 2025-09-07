// api/lookup.js

// ---------- URL helpers (fix base, add scheme, add /api/2.0, build query) ----------
function normalizeBase(u) {
  if (!u) return "";
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;   // ensure scheme
  s = s.replace(/\/+$/,"");                            // trim trailing slashes
  if (!/\/api\/2\.0$/i.test(s)) s = s + "/api/2.0";    // ensure /api/2.0
  return s;
}
function url(base, path, qs) {
  const b = normalizeBase(base);
  const u = new URL(b + (path.startsWith("/") ? path : "/" + path));
  if (qs && typeof qs === "object") {
    for (const [k,v] of Object.entries(qs)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

// ---------- DOB normalization ----------
function toIsoDob(input) {
  if (!input) return "";
  const s = String(input).trim();

  // already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // compact YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    const yyyy = s.slice(0,4), mm = s.slice(4,6), dd = s.slice(6,8);
    return `${yyyy}-${mm}-${dd}`;
  }

  // US MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
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

// ---------- Main handler ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const { first_name, last_name, email } = body;
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const base = process.env.LS_BASE_URL;           // e.g., https://helmsv.retail.lightspeed.app or .../api/2.0
    const token = process.env.LS_TOKEN;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    let customer = null;

    // 1) Try email
    try {
      const byEmail = await fetch(url(base, "/customers", { email }), { headers });
      if (byEmail.ok) {
        const data = await byEmail.json();
        if (Array.isArray(data?.customers) && data.customers.length > 0) {
          customer =
            data.customers.find(c => (c.email || "").toLowerCase() === email.toLowerCase()) ||
            data.customers[0];
        }
      }
    } catch (err) {
      console.error("Email lookup error:", err);
    }

    // 2) Try name
    if (!customer) {
      try {
        const byName = await fetch(url(base, "/customers", { first_name, last_name }), { headers });
        if (byName.ok) {
          const data2 = await byName.json();
          if (Array.isArray(data2?.customers) && data2.customers.length > 0) {
            customer = data2.customers[0];
          }
        }
      } catch (err) {
        console.error("Name lookup error:", err);
      }
    }

    // 3) Create minimal if still missing
    if (!customer) {
      const createBody = { first_name, last_name, email };
      try {
        const cr = await fetch(url(base, "/customers"), {
          method: "POST",
          headers,
          body: JSON.stringify(createBody)
        });
        customer = cr.ok ? await cr.json() : { first_name, last_name, email };
      } catch (err) {
        console.error("Customer create error:", err);
        customer = { first_name, last_name, email };
      }
    }

    // ----- Map & normalize DOB -----
    const rawDob =
      customer.date_of_birth ||
      customer.dob ||
      customer?.custom?.date_of_birth ||
      customer?.custom?.dob ||
      "";

    const dobIso = toIsoDob(rawDob);           // "YYYY-MM-DD" or ""
    const dobYyyymmdd = toYyyymmdd(dobIso);    // "YYYYMMDD" or ""

    const out = {
      match_quality: customer?.email?.toLowerCase() === email.toLowerCase() ? "exact" : (customer ? "partial" : "new"),
      lightspeed_id: customer.id || customer.customer_id || customer?.customer?.id || "",
      first_name: customer.first_name || first_name,
      last_name: customer.last_name || last_name,
      email: customer.email || email,
      mobile: customer.mobile || customer.phone || "",
      date_of_birth: dobIso,       // for reference
      dob_yyyymmdd: dobYyyymmdd,   // client prefers this; falls back to 19050101 on the page if empty
      street: customer.street || customer.physical_address?.street || "",
      city: customer.city || customer.physical_address?.city || "",
      state: customer.state || customer.physical_address?.state || "",
      postcode: customer.postcode || customer.physical_address?.postal_code || "",
      country: customer.country || customer.physical_address?.country || ""
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
      street: "",
      city: "",
      state: "",
      postcode: "",
      country: ""
    });
  }
};