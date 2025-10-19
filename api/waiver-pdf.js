// api/waiver-pdf.js
// Always returns a PDF if the API exposes it; otherwise *redirects* to Smartwaiver's Authenticator page.

const SW_BASE = process.env.SW_BASE || "https://api.smartwaiver.com";
const SW_KEY  = process.env.SW_API_KEY;

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

async function swGet(path, headers = {}) {
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: { "x-api-key": SW_KEY, ...headers },
    cache: "no-store",
    redirect: "follow",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Smartwaiver ${path} failed: ${r.status} ${text || r.statusText}`);
  }
  return r;
}
async function swGetJson(path) {
  const r = await swGet(path, { accept: "application/json" });
  return r.json();
}

function looksLikeAuthUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname.includes("smartwaiver.com")
        && url.pathname.includes("/authenticate/")
        && url.searchParams.has("authenticate_document_id");
  } catch { return false; }
}

async function handle(req) {
  try {
    const { searchParams } = new URL(req.url);
    // Accept multiple param names for resilience
    const id = searchParams.get("waiverId") || searchParams.get("waiverID") ||
               searchParams.get("authenticateId") || searchParams.get("documentId");
    if (!id) return bad("Missing waiverId");

    // 1) Try official PDF endpoint
    try {
      const pdfRes = await swGet(`/v4/waivers/${encodeURIComponent(id)}/pdf`, { accept: "application/pdf" });
      const buf = await pdfRes.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="${id}.pdf"`,
          "cache-control": "no-store",
        }
      });
    } catch (_) {}

    // 2) Try JSON with embedded/base64 PDF or direct URL
    let authUrl = null;
    try {
      const w = await swGetJson(`/v4/waivers/${encodeURIComponent(id)}?pdf=true`);
      const candidates = [w?.pdf, w?.waiver?.pdf, w?.document?.pdf, w?.waiver?.document?.pdf].filter(Boolean);

      for (const c of candidates) {
        const b64 = c?.base64 || c?.data || c?.content;
        if (b64 && typeof b64 === "string" && b64.length > 1000) {
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `inline; filename="${id}.pdf"`,
              "cache-control": "no-store",
            }
          });
        }
      }
      for (const c of candidates) {
        const url = c?.url || c?.href || c?.link;
        if (url) {
          if (looksLikeAuthUrl(url)) authUrl = url;
          else {
            const direct = await fetch(url, { redirect: "follow", cache: "no-store" });
            if (direct.ok && (direct.headers.get("content-type") || "").includes("pdf")) {
              const buf = await direct.arrayBuffer();
              return new Response(buf, {
                status: 200,
                headers: {
                  "content-type": "application/pdf",
                  "content-disposition": `inline; filename="${id}.pdf"`,
                  "cache-control": "no-store",
                }
              });
            }
          }
        }
      }
    } catch (_) {}

    // 3) Last resort: hunt any .pdf link in the waiver payload (non-authenticator)
    try {
      const w = await swGetJson(`/v4/waivers/${encodeURIComponent(id)}`);
      const urls = [];
      (function walk(o) {
        if (!o || typeof o !== "object") return;
        for (const v of Object.values(o)) {
          if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.push(v);
          else if (v && typeof v === "object") walk(v);
        }
      })(w);

      for (const u of urls) {
        if (looksLikeAuthUrl(u)) { authUrl = authUrl || u; continue; }
        if (!/\.(pdf)(\?|#|$)/i.test(u)) continue;
        const direct = await fetch(u, { redirect: "follow", cache: "no-store" });
        if (direct.ok && (direct.headers.get("content-type") || "").includes("pdf")) {
          const buf = await direct.arrayBuffer();
          return new Response(buf, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `inline; filename="${id}.pdf"`,
              "cache-control": "no-store",
            }
          });
        }
      }
    } catch (_) {}

    // If the vendor only gives an Authenticator link, redirect there instead of erroring.
    if (authUrl) {
      return Response.redirect(authUrl, 302);
    }

    return bad("PDF not available for this waiver.", 404);
  } catch (err) {
    return bad(String(err), 500);
  }
}

export async function GET(req) { return handle(req); }
