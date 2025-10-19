// api/waiver-pdf.js
const SW_BASE = (process.env.SW_BASE_URL || 'https://api.smartwaiver.com').replace(/\/+$/, '');
const API_BASE = `${SW_BASE}/v4`;
const cleanKey = v => String(v || '').trim().replace(/[^\x20-\x7E]+/g, '');

async function swFetch(url, key, accept){
  let r = await fetch(url, { headers: { Accept: accept, 'sw-api-key': key }, cache: 'no-store' });
  if (r.status === 401) r = await fetch(url, { headers: { Accept: accept, 'x-api-key': key }, cache: 'no-store' });
  return r;
}
async function swGetJSON(path, key){
  const url = `${API_BASE}${path}`;
  const r = await swFetch(url, key, 'application/json');
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`${path} ${r.status} ${t.slice(0,200)}`);
  }
  return r.json();
}
function* deepStrings(o, maxDepth=7){
  if (!o || typeof o !== 'object') return;
  const stack = [[o,0]];
  while (stack.length){
    const [cur,d] = stack.pop();
    if (d>maxDepth) continue;
    if (Array.isArray(cur)){ for (const v of cur) stack.push([v,d+1]); continue; }
    for (const [,v] of Object.entries(cur)){
      if (typeof v === 'string') yield v;
      if (v && typeof v === 'object') stack.push([v,d+1]);
    }
  }
}
function findPdfUrlDeep(json){
  for (const s of deepStrings(json)) {
    if (/^https?:\/\/\S+\.pdf(\?\S*)?$/i.test(s)) return s;
    if (/^https?:\/\/\S+$/i.test(s) && /\/pdf(\/|$|\?)/i.test(s)) return s;
  }
  return null;
}

export default async function handler(req, res){
  try{
    const waiverId = String((req.query.waiverId || req.query.waiverID || '')).trim();
    const key = cleanKey(process.env.SW_API_KEY);
    if (!waiverId || !key) return res.status(400).json({ error: 'Missing waiverId or SW_API_KEY' });

    // 1) Try official PDF endpoint
    {
      const url = `${API_BASE}/waivers/${encodeURIComponent(waiverId)}/pdf`;
      let r = await swFetch(url, key, 'application/pdf');
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (r.ok && ct.includes('application/pdf')) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="waiver-${waiverId}.pdf"`);
        return res.status(200).send(buf);
      }
      // If we got JSON "route not found", fall back to ?pdf=true discovery
      if (!r.ok) {
        const body = await r.text().catch(()=> '');
        if (!ct.includes('application/json') || !/route not found/i.test(body)) {
          return res.status(502).send(body || 'PDF fetch failed');
        }
      }
    }

    // 2) Fallback: pull waiver and discover a PDF URL
    let pdfUrl = null;
    try {
      const detail = await swGetJSON(`/waivers/${encodeURIComponent(waiverId)}?pdf=true`, key);
      pdfUrl = detail?.waiver?.pdf || detail?.pdf || findPdfUrlDeep(detail);
    } catch { /* ignore, try bare */ }

    if (!pdfUrl) {
      const bare = await swGetJSON(`/waivers/${encodeURIComponent(waiverId)}`, key);
      pdfUrl = bare?.waiver?.pdf || bare?.pdf || findPdfUrlDeep(bare);
    }
    if (!pdfUrl) return res.status(404).send('PDF URL not found');

    // 3) Stream the discovered URL
    let r2 = await fetch(pdfUrl, { cache: 'no-store' });
    if (!r2.ok) r2 = await fetch(pdfUrl, { headers: { 'sw-api-key': key }, cache: 'no-store' });
    if (!r2.ok) {
      const t = await r2.text().catch(()=> '');
      return res.status(502).send(`PDF URL fetch failed ${r2.status} ${t.slice(0,200)}`);
    }
    const buf = Buffer.from(await r2.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="waiver-${waiverId}.pdf"`);
    return res.status(200).send(buf);
  }catch(e){
    res.status(500).send(String(e.message || e));
  }
}
