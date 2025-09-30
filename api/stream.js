// api/stream.js
// Simple SSE hub: /api/stream
// Emits: event:intake {waiver_id, template_id, signed_on, intake_pdf_url, lightspeed_id, participants:[...]}
//        event:liability {waiver_id, template_id, signed_on, lightspeed_id?, email?, participants:[...]}
//        event:ping {}

let clients = globalThis.__sse_clients;
if (!clients) {
  clients = new Set();
  globalThis.__sse_clients = clients;
}

// Basic publish helper accessible from other API routes
globalThis.__sse_publish = function (event, dataObj) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* autoprune on close */ }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // for some proxies
  });

  // Immediately send a ping so client knows we’re live
  res.write(`event: ping\ndata: {}\n\n`);
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
}
