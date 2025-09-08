// api/today-intakes.js — tolerant listing: supports tag or email fallback, last 24h window, Intake PDF proxy

async function fetchTO(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function iso24hAgo() {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString();
}

async function toJson(resp) {
  const ct = resp.headers.get("content-type") || "";
  if (/json/i.test(ct)) return await resp.json();
  const txt = await resp.text();
  return { _nonjson: txt.slice(0, 300) };
}

function arrFrom(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.waivers)) return payload.waivers;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  return Array.isArray(payload) ? payload : [];
}

function toSimpleRow(w) {
  const first = w?.firstName || w?.participantFirstName || w?.firstname || "";
  const last  = w?.lastName  || w?.participantLastName  || w?.lastname  || "";
  const email = (w?.email || "").trim().toLowerCase();
  const tag   = (Array.isArray(w?.tags) ? w.tags[0] : w?.tag) || "";
  const signedOn = w?.createdOn || w?.ts || w?.date || "";
  const lsId = (tag && String(tag).startsWith("ls_")) ? String(tag).slice(3) : "";
  const templateId = w?.templateId || w?.template_id || "";
  const waiverId = w?.waiverId || w?.uuid || w?.id || "";
  return {
    ls_tag: tag || (lsId ? `ls_${lsId}` : ""),
    lightspeed_id: lsId,
    email,
    first_name: first,
    last_name: last,
    signed_on: signedOn,
    waiver_template_id: templateId,
    waiver_id: waiverId
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

    // Window = last 24 hours to avoid TZ edges
    const fromIso = iso24hAgo();
    const toIso = new Date().toISOString();

    const url = new URL("https://api.smartwaiver.com/v4/waivers");
    url.searchParams.set("fromDts", fromIso);
    url.searchParams.set("toDts", toIso);
    url.searchParams.set("limit", "1000");

    const r = await fetchTO(url.toString(), { headers: { "sw-api-key": key } }, 20000);
    const data = await toJson(r);
    const all = arrFrom(data).map(toSimpleRow);

    // Build lookups:
    //  - by tag (for tag-based correlation)
    //  - by email (fallback when no tag present)
    const intakeByTag = new Map();
    const liabByTag   = new Map();
    const intakeByEmail = new Map();
    const liabByEmail   = new Map();

    for (const row of all) {
      const isIntake   = row.waiver_template_id === INTAKE_ID;
      const isLiability= row.waiver_template_id === LIABILITY_ID;
      const tag = row.ls_tag || "";                  // may be empty if no tag on waiver
      const email = row.email || "";

      if (isIntake) {
        if (tag) {
          if (!intakeByTag.has(tag)) intakeByTag.set(tag, []);
          intakeByTag.get(tag).push(row);
        } else if (email) {
          if (!intakeByEmail.has(email)) intakeByEmail.set(email, []);
          intakeByEmail.get(email).push(row);
        }
      }
      if (isLiability) {
        if (tag) {
          if (!liabByTag.has(tag)) liabByTag.set(tag, []);
          liabByTag.get(tag).push(row);
        } else if (email) {
          if (!liabByEmail.has(email)) liabByEmail.set(email, []);
          liabByEmail.get(email).push(row);
        }
      }
    }

    const needsLiability = [];

    // A) Tag-based: include latest Intake if NO liability with same tag
    for (const [tag, list] of intakeByTag.entries()) {
      if ((liabByTag.get(tag) || []).length === 0) {
        list.sort((a,b) => String(b.signed_on).localeCompare(String(a.signed_on)));
        const latest = list[0];
        latest.intake_pdf_url = `/api/today-intakes?pdf=${encodeURIComponent(latest.waiver_id)}`;
        needsLiability.push(latest);
      }
    }

    // B) Email-based fallback: only for intakes WITHOUT a tag
    for (const [email, list] of intakeByEmail.entries()) {
      if ((liabByEmail.get(email) || []).length === 0) {
        list.sort((a,b) => String(b.signed_on).localeCompare(String(a.signed_on)));
        const latest = list[0];
        latest.intake_pdf_url = `/api/today-intakes?pdf=${encodeURIComponent(latest.waiver_id)}`;
        needsLiability.push(latest);
      }
    }

    // Newest first
    needsLiability.sort((a,b) => String(b.signed_on).localeCompare(String(a.signed_on)));

    return res.status(200).json({ rows: needsLiability, from: fromIso, to: toIso });
  } catch (e) {
    console.error("today-intakes fatal:", e?.message || e);
    return res.status(200).json({ rows: [] });
  }
};