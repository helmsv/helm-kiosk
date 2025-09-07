// api/lookup.js — Crash-proof Lightspeed X-Series 2.0 lookup (GET-only) with flexible result extraction
function normalizeBase(u) {
  if (!u) return "";
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/\/+$/,"");
  if (!/\/api\/2\.0$/i.test(s)) s = s + "/api/2.0";
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
    if (/json/i.test(ct)) return await resp.json();
    const txt = await resp.text();
    return { _nonjson: String(txt).slice(0, 300) };
  } catch (e) {
    return { _parse_error: String(e?.message || e) };
  }
}
function toIsoDob(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) {
    const yyyy = s.slice(0,4), mm = s.slice(4,6), dd = s.slice(6,8);
    return `${yyyy}-${mm}-${dd}`;
  }
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
async function fetchTO(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
// Flexible customer extractor (handles multiple API shapes)
function extractCustomers(payload) {
  if (!payload || typeof payload !== "object") return { arr: [], shape: "none" };
  const candidates = [
    { path: "customers",      arr: payload?.customers },
    { path: "data.customers", arr: payload?.data?.customers },
    { path: "customers.data", arr: payload?.customers?.data },
    { path: "data",           arr: payload?.data },
    { path: "results",        arr: payload?.results },
  ];
  for (const c of candidates) {
    if (Array.isArray(c.arr)) return { arr: c.arr, shape: c.path };
  }
  if (payload?.customer && typeof payload.customer === "object") {
    return { arr: [payload.customer], shape: "customer" };
  }
  if (payload?.data?.customer && typeof payload.data.customer === "object") {
    return { arr: [payload.data.customer], shape: "data.customer" };
  }
  return { arr: [], shape: "unknown" };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    let body = req.body ?? {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

    // ✅ Email-only is allowed now
    const first_name = (body.first_name || "").trim();
    const last_name  = (body.last_name  || "").trim();
    const email      = (body.email      || "").trim();

    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    const base  = process.env.LS_BASE_URL;
    const token = process.env.LS_TOKEN; // raw token (no "Bearer ")
    console.log("ENV present?", { hasBase: !!base, hasToken: !!token });

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
      if (!u) return { arr: [], status: null, shape: "invalid", peek: null };
      try {
        const r = await fetchTO(u, { headers }, 12000);
        const status = r.status;
        const data = await safeJson(r);
        const { arr, shape } = extractCustomers(data);
        const peek = JSON.stringify(data).slice(0, 220);
        console.log(`${desc} status:`, status);
        console.log(`${desc} shape:`, shape, "| results:", arr.length);
        if (!arr.length && status === 200) console.log(`${desc} peek:`, peek);
        return { arr, status, shape, peek };
      } catch (e) {
        console.error(`${desc} fetch error:`, e?.name === 'AbortError' ? 'Timeout' : (e?.message || e));
        return { arr: [], status: null, shape: "error", peek: null };
      }
    }

    // (0) Retailer diag (safe)
    try {
      const rr = await fetchTO(safeUrl(base, "/retailers"), { headers }, 8000);
      console.log("Retailer status:", rr?.status);
      const peek = await safeJson(rr);
      console.log("Retailer peek:", JSON.stringify(peek).slice(0,160));
    } catch (e) { console.error("Retailer check error:", e?.message || e); }

    // 1) Primary: /search by email
    const r1 = await tryEndpoint("Search(email)", "/search", { type: "customers", email });
    if (r1.arr.length) {
      customer =
        r1.arr.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) ||
        r1.arr[0];
    }

    // 2) Fallbacks only if names were provided (optional)
    if (!customer && (first_name || last_name)) {
      const r2 = await tryEndpoint("Search(name)", "/search", { type: "customers", first_name, last_name });
      if (r2.arr.length) customer = r2.arr[0];
    }

    if (!customer) {
      const r3 = await tryEndpoint("Search(q=email)", "/search", { type: "customers", q: email });
      if (r3.arr.length) {
        customer =
          r3.arr.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) ||
          r3.arr[0];
      }
    }

    if (!customer) {
      const r4 = await tryEndpoint("Customers(search)", "/customers", { search: email });
      if (r4.arr.length) {
        customer = r4.arr.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) || r4.arr[0];
      }
    }

    if (!customer) {
      const r5 = await tryEndpoint("Customers(email)", "/customers", { email });
      if (r5.arr.length) {
        customer = r5.arr.find(c => ((c.email || "").trim().toLowerCase() === emailLc)) || r5.arr[0];
      }
    }

    // ----- Map output -----
    const rawDob =
      customer?.date_of_birth ||
      customer?.dob ||
      customer?.custom?.date_of_birth ||
      customer?.custom?.dob ||
      "";

    const dobIso       = toIsoDob(rawDob);
    const dobYyyymmdd  = toYyyymmdd(dobIso);

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
      first_name: customer?.first_name || first_name || "",
      last_name:  customer?.last_name  || last_name  || "",
      email:      customer?.email      || email,
      mobile:     customer?.mobile     || customer?.phone || "",
      date_of_birth: dobIso,
      dob_yyyymmdd:  dobYyyymmdd, // client will fallback to 19300101 if empty
      street:   customer?.street || customer?.physical_address?.street || "",
      city:     customer?.city   || customer?.physical_address?.city   || "",
      state:    customer?.state  || customer?.physical_address?.state  || "",
      postcode: customer?.postcode || customer?.physical_address?.postal_code || "",
      country:  customer?.country  || customer?.physical_address?.country     || ""
    });

  } catch (e) {
    console.error("lookup fatal:", e?.message || e);
    return res.status(200).json({
      match_quality: "new",
      lightspeed_id: "",
      first_name: "", last_name: "", email: "",
      mobile: "",
      date_of_birth: "",
      dob_yyyymmdd: "",
      street: "", city: "", state: "", postcode: "", country: ""
    });
  }
};