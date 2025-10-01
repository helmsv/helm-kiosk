// api/waiver-pdf.js
// Proxy to Smartwaiver v4 waiver PDF. Works with both `sw-api-key` and `x-api-key`.

const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;

function cleanKey(v) {
  if (!v) return '';
  let t = String(v).trim();
  const m = t.match(/^"(.*)"$/);
  if (m) t = m[1];
  return t.replace(/[^\x20-\x7E]+/g, '');
}

async function swFetch(url, key, accept) {
  const base = { Accept: accept };
  // try sw-api-key first, then x-api-key fallback
  let r = await fetch(url, { headers: { ...base, 'sw-api-key': key }, redirect: 'manual', cache: 'no-store' });
  if (r.status === 401) {
    r = await fetch(url, { headers: { ...base, 'x-api-key': key }, redirect: 'manual', cache: 'no-store' });
  }
  return r;
}

export default async function handler(req, res) {
  try {
    const key = cleanKey(process.env.SW_API_KEY);
    const waiverId = (req.query.waiverId || '').toString().trim();
    if (!key)      return res.status(500).send('Missing SW_API_KEY');
    if (!waiverId) return res.status(400).send('Missing waiverId');

    const url = `${API_BASE}/waivers/${encodeURIComponent(waiverId)}/pdf`;

    // 1) Ask for JSON first — many Smartwaiver accounts return a signed URL in JSON or via redirect
    let r = await swFetch(url, key, 'application/json');

    // Follow 30x Location from Smartwaiver to the actual file
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (loc) {
        res.writeHead(302, { Location: loc });
        return res.end();
      }
    }

    // If JSON body contains a URL field, redirect there
    let txt = '';
    try { txt = await r.text(); } catch {}
    if (txt) {
      try {
        const j = JSON.parse(txt);
        const pdfUrl = j.url || j.pdfUrl || j.pdf || j.link;
        if (pdfUrl) {
          res.writeHead(302, { Location: pdfUrl });
          return res.end();
        }
      } catch {
        // not JSON; fall through to PDF attempt
      }
    }

    // 2) Request the PDF directly (some deployments return the binary stream)
    r = await swFetch(url, key, 'application/pdf');

    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (loc) {
        res.writeHead(302, { Location: loc });
        return res.end();
      }
    }

    if (r.ok && (r.headers.get('content-type') || '').includes('application/pdf')) {
      const ab = await r.arrayBuffer();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).send(Buffer.from(ab));
    }

    // Fallback: bubble up error body we received from Smartwaiver
    const fallback = txt || (await r.text().catch(() => ''));
    return res.status(r.status || 500).send(fallback || 'Failed to fetch waiver PDF');
  } catch (e) {
    return res.status(500).send(String(e));
  }
}
