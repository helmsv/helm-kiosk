// api/waiver-pdf.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;
const cleanKey = v => String(v || '').trim().replace(/[^\x20-\x7E]+/g, '');

async function fetchPDFDirect(waiverId, key) {
  const url = `${API_BASE}/waivers/${encodeURIComponent(waiverId)}/pdf`;
  let r = await fetch(url, { headers: { 'sw-api-key': key, Accept: 'application/pdf' }, cache: 'no-store' });
  if (r.status === 401) r = await fetch(url, { headers: { 'x-api-key': key, Accept: 'application/pdf' }, cache: 'no-store' });
  if (!r.ok) {
    const ct = r.headers.get('content-type') || '';
    const body = await r.text().catch(()=> '');
    // If Smartwaiver returned JSON "Route not found", propagate so we can fall back
    if (ct.includes('application/json') && /route not found/i.test(body)) {
      const err = new Error('ROUTE_NOT_FOUND');
      err.code = 'ROUTE_NOT_FOUND';
      throw err;
    }
    const err = new Error(`PDF ${r.status} ${body.slice(0,200)}`);
    err.status = r.status;
    throw err;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

async function swGetJSON(path, key) {
  const url = `${API_BASE}${path}`;
  let r = await fetch(url, { headers: { 'sw-api-key': key, Accept: 'application/json' }, cache: 'no-store' });
  if (r.status === 401) r = await fetch(url, { headers: { 'x-api-key': key, Accept: 'application/json' }, cache: 'no-store' });
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`${path} ${r.status} ${t.slice(0,200)}`);
  }
  return r.json();
}

function* deepValues(o, maxDepth=6) {
  if (!o || typeof o !== 'object') return;
  const stack = [[o, 0]];
  while (stack.length) {
    const [cur, d] = stack.pop();
    if (d > maxDepth) continue;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push([v, d+1]);
    } else {
      for (const [k,v] of Object.entries(cur)) {
        if (typeof v === 'string') yield v;
        if (v && typeof v === 'object') stack.push([v, d+1]);
      }
    }
  }
}
function findPdfUrlDeep(json){
  for (const v of deepValues(json)) {
    if (/^https?:\/\/\S+\.pdf(\?\S*)?$/i.test(v) || (/^https?:\/\/\S+$/i.test(v) && /\/pdf(\/|$|\?)/i.test(v))) {
      return v;
    }
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const waiverId = String(req.query.waiverId || '').trim();
    const key = cleanKey(process.env.SW_API_KEY);
    if (!waiverId || !key) return res.status(400).json({ error: 'Missing waiverId or SW_API_KEY' });

    let pdfBuf = null;
    try {
      pdfBuf = await fetchPDFDirect(waiverId, key);
    } catch (e) {
      if (e && e.code === 'ROUTE_NOT_FOUND') {
        // fall back: pull waiver JSON and look for a pdf URL
        const data = await swGetJSON(`/waivers/${encodeURIComponent(waiverId)}`, key);
        const url = findPdfUrlDeep(data);
        if (!url) throw new Error('PDF URL not found in waiver payload');
        // try fetch the discovered URL (usually public S3)
        let r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) {
          // try with key just in case the link expects authenticated header
          r = await fetch(url, { headers: { 'sw-api-key': key }, cache: 'no-store' });
        }
        if (!r.ok) {
          const t = await r.text().catch(()=> '');
          throw new Error(`Fetched PDF URL failed ${r.status} ${t.slice(0,200)}`);
        }
        pdfBuf = Buffer.from(await r.arrayBuffer());
      } else {
        throw e;
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="waiver-${waiverId}.pdf"`);
    res.status(200).send(pdfBuf);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
}
