// pages/api/waiver-pdf.js
//
// Drop-in replacement for “Open PDF”.
// Instead of streaming raw PDF bytes (which broke your client by trying to
// treat them as a URL), this returns a *plain-text URL* that you can open in
// a new tab. Optionally supports JSON or a 307 redirect.
//
// Usage from the client can stay the same if you were doing:
//   const href = await fetch(`/api/waiver-pdf?waiverID=...`).then(r => r.text());
//   window.open(href, '_blank');
//
// Query params:
//   waiverID   (required)
//   format=json    -> returns { href: "<url>" }
//   redirect=1     -> 307 Location: <url>
//
// Env (optional):
//   SMARTWAIVER_AUTH_BASE   defaults to https://www.smartwaiver.com/authenticate/
//

const AUTH_BASE = (process.env.SMARTWAIVER_AUTH_BASE || 'https://www.smartwaiver.com/authenticate/').replace(/\/+$/, '/') ;

function bad(res, code, msg) {
  res.status(code).setHeader('Cache-Control', 'no-store');
  return res.send(msg);
}

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');

    const waiverId = (req.query.waiverID || req.query.waiverId || req.query.id || '').toString().trim();
    if (!waiverId) return bad(res, 400, 'Missing waiverID');

    // Smartwaiver's public PDF auth endpoint. We do not fetch the PDF here;
    // we hand the browser a URL it can open itself.
    const href = `${AUTH_BASE}?authenticate_document_id=${encodeURIComponent(waiverId)}`;

    if (req.query.redirect === '1' || req.query.redirect === 'true') {
      res.setHeader('Location', href);
      return res.status(307).end();
    }

    if (req.query.format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify({ href }));
    }

    // Default: plain text URL so existing client code that expects a string still works.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(href);
  } catch (err) {
    return bad(res, 500, `waiver-pdf error: ${String(err)}`);
  }
}
