// api/waiver-pdf.js
// Drop-in replacement: always returns an actual PDF stream (no 'authenticate' HTML)

const SW_BASE = process.env.SW_BASE || "https://api.smartwaiver.com";
const SW_KEY  = process.env.SW_API_KEY;

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function swGet(path, headers = {}) {
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: { "x-api-key": SW_KEY, ...headers },
    cache: "no-store",
    redirect: "follow"
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Smartwaiver ${path} failed: ${r.status} ${text || r.statusText}`);
  }
  return r;
}

async function swGetJson(path) {
  const r = await swGet(path, { "accept": "application/json" });
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
    const waiverId = searchParams.get("waiverId") || searchParams.get("waiverID");
    if (!waiverId) return bad("Missing waiverId");

    // 1) Preferred: official PDF endpoint (application/pdf)
    try {
      const pdfRes = await swGet(`/v4/waivers/${encodeURIComponent(waiverId)}/pdf`, {
        "accept": "application/pdf"
      });
      const buf = await pdfRes.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="${waiverId}.pdf"`
        }
      });
    } catch (_) {
      // fall through
    }

    // 2) Fallback: ask for JSON with embedded/base64 PDF if available
    try {
      const w = await swGetJson(`/v4/waivers/${encodeURIComponent(waiverId)}?pdf=true`);
      // Try multiple common spots
      const candidates = [
        w?.pdf,
        w?.waiver?.pdf,
        w?.document?.pdf,
        w?.waiver?.document?.pdf,
      ].filter(Boolean);

      // Base64?
      for (const c of candidates) {
        const b64 = c?.base64 || c?.data || c?.content;
        if (b64 && typeof b64 === "string" && b64.length > 1000) {
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `inline; filename="${waiverId}.pdf"`
            }
          });
        }
      }

      // Direct link?
      for (const c of candidates) {
        const url = c?.url || c?.href || c?.link;
        if (url && !looksLikeAuthUrl(url)) {
          const direct = await fetch(url, { redirect: "follow" });
          if (direct.ok && (direct.headers.get("content-type") || "").includes("pdf")) {
            const buf = await direct.arrayBuffer();
            return new Response(buf, {
              status: 200,
              headers: {
                "content-type": "application/pdf",
                "content-disposition": `inline; filename="${waiverId}.pdf"`
              }
            });
          }
        }
      }

      // If we only get an "authenticate_document_id" URL, don't serve the HTML — we'll keep falling through.
    } catch (_) {
      // fall through
    }

    // 3) Last resort: fetch waiver JSON and hunt for any direct PDF-like URL (non-authenticator)
    try {
      const w = await swGetJson(`/v4/waivers/${encodeURIComponent(waiverId)}`);
      const urls = [];
      (function walk(o) {
        if (!o || typeof o !== "object") return;
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.push(v);
          else if (v && typeof v === "object") walk(v);
        }
      })(w);

      for (const u of urls) {
        if (looksLikeAuthUrl(u)) continue;
        if (!/\.(pdf)(\?|#|$)/i.test(u)) continue;
        const direct = await fetch(u, { redirect: "follow" });
        if (direct.ok && (direct.headers.get("content-type") || "").includes("pdf")) {
          const buf = await direct.arrayBuffer();
          return new Response(buf, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `inline; filename="${waiverId}.pdf"`
            }
          });
        }
      }
    } catch (_) {
      // ignore
    }

    return bad("PDF not available for this waiver (only 'authenticate' page was provided by vendor).", 404);
  } catch (err) {
    return bad(String(err), 500);
  }
}

// App Router (Next.js 13+)
export async function GET(req) { return handle(req); }

// If you’re on pages/api, replace the two lines above with:
// export default async function handler(req, res) {
//   const r = await handle(new Request(`http://x${req.url}`));
//   const body = await r.arrayBuffer();
//   res.status(r.status).setHeader("content-type", "application/pdf").send(Buffer.from(body));
// }
