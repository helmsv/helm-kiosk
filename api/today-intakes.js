// api/today-intakes.js
// Lists customers who signed INTAKE today but have NOT signed LIABILITY today (matched by Smartwaiver tag "ls_<lightspeed_id>").
// Also proxies Intake PDF downloads via ?pdf=<waiverId> to avoid exposing your SW_API_KEY in the browser.

async function fetchTO(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function startOfTodayISO(tzOffsetMinutes = -480) {
  // tzOffsetMinutes defaults to Pacific (-480 ~ UTC-8; close enough for daily windowing)
  const now = new Date();
  const utcNow = now.getTime() + now.getTimezoneOffset() * 60000;
  const local = new Date(utcNow + tzOffsetMinutes * 60000);
  local.setHours(0, 0, 0, 0);
  // convert back to UTC ISO (Smartwaiver accepts full ISO)
  const backUTC = new Date(local.getTime() - now.getTimezoneOffset() * 60000);
  return backUTC.toISOString();
}

async function toJson(resp) {
  const ct = resp.headers.get("content-type") || "";
  if (/json/i.test(ct)) return await resp.json();
  const txt = await resp.text();
  return { _nonjson: txt.slice(0, 300) };
}

// Normalize list shapes from Smartwaiver
function arrFrom(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.waivers)) return payload.waivers;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  return Array.isArray(payload) ? payload : [];
}

// Convert one waiver to a simple row used by the tech UI
function toSimpleRow(w) {
  const first = w?.firstName || w?.participantFirstName || w?.firstname || "";
  const last  = w?.lastName  || w?.participantLastName  || w?.lastname  || "";
  const email = w?.email || "";
  const tag   = (Array.isArray(w?.tags) ? w.tags[0] : w?.tag) || "";
  const signedOn = w?.createdOn || w?.ts || w?.date || "";
  const lsId = (tag && String(tag).startsWith("ls_")) ? String(tag).slice(3) : "";
  return {
    ls_tag: tag || (lsId ? `ls_${lsId}` : ""),
    lightspeed_id: lsId,
    email,
    first_name: first,
    last_name: last,
    signed_on: signedOn,
    waiver_template_id: w?.templateId || w?.template_id || "",
    waiver_id: w?.waiverId || w?.uuid || w?.id || ""
  };
}

// ====== PDF Proxy Mode ======
async function handlePdfProxy(req, res) {
  const key = process.env.SW_API_KEY;
  const waiverId = String(req.query?.pdf || "").trim();
  if (!key || !waiverId) {
    return res.status(400).send("Missing SW_API_KEY or pdf (waiverId) parameter");
  }

  try {
    const u = `https://api.smartwaiver.com/v4/waivers/${encodeURIComponent(waiverId)}/pdf`;
    const r = await fetchTO(u, { headers: { "sw-api-key": key } }, 30000);

    if (!r.ok) {
      const peek = await r.text();
      return res.status(r.status).send(peek);
    }

    // Stream PDF through
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

// ====== List Mode ======
module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // PDF proxy branch
  if (req.query && typeof req.query.pdf !== "undefined") {
    return handlePdfProxy(req, res);
  }

  try {
    const key = process.env.SW_API_KEY;
    const INTAKE_ID = process.env.INTAKE_WAIVER_ID;
    const LIABILITY_ID = process.env.LIABILITY_WAIVER_ID;

    if (!key || !INTAKE_ID || !LIABILITY_ID) {
      return res.status(200).json({
        rows: [],
        error: "Missing SW env (SW_API_KEY/INTAKE_WAIVER_ID/LIABILITY_WAIVER_ID)"
      });
    }

    // Time window: today in Pacific (loose & reliable for daily ops)
    const fromIso = startOfTodayISO(-480);
    const toIso = new Date().toISOString();

    // Fetch today's waivers (limit generously; raise if your volume exceeds)
    const url = new URL("https://api.smartwaiver.com/v4/waivers");
    url.searchParams.set("fromDts", fromIso);
    url.searchParams.set("toDts", toIso);
    url.searchParams.set("limit", "1000");

    const r = await fetchTO(url.toString(), { headers: { "sw-api-key": key } }, 20000);
    const data = await toJson(r);
    const all = arrFrom(data);

    // Group by Smartwaiver tag (ls_<id>)
    const byTag = new Map(); // tag -> { intakes:[], liabilities:[] }
    for (const w of all) {
      const row = toSimpleRow(w);
      const tag = row.ls_tag || "";
      const tmpl = String(row.waiver_template_id || "");
      if (!tag) continue; // only track waivers linked to a Lightspeed customer (tag present)
      if (!byTag.has(tag)) byTag.set(tag, { intakes: [], liabilities: [] });
      if (tmpl === INTAKE_ID) byTag.get(tag).intakes.push(row);
      else if (tmpl === LIABILITY_ID) byTag.get(tag).liabilities.push(row);
    }

    // For each tag, include the most recent Intake only if there is no Liability today
    const needsLiability = [];
    for (const [tag, grp] of byTag.entries()) {
      if (grp.intakes.length > 0 && grp.liabilities.length === 0) {
        grp.intakes.sort((a, b) => String(b.signed_on).localeCompare(String(a.signed_on)));
        const latest = grp.intakes[0];
        // Attach a PDF link (proxied through this API)
        latest.intake_pdf_url = `/api/today-intakes?pdf=${encodeURIComponent(latest.waiver_id)}`;
        needsLiability.push(latest);
      }
    }

    // Sort newest first for the UI
    needsLiability.sort((a, b) => String(b.signed_on).localeCompare(String(a.signed_on)));

    return res.status(200).json({ rows: needsLiability, from: fromIso, to: toIso });
  } catch (e) {
    console.error("today-intakes fatal:", e?.message || e);
    return res.status(200).json({ rows: [] });
  }
};