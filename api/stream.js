// api/stream.js (CommonJS)
let clients = global.__sse_clients;
if (!clients) {
  clients = new Set();
  global.__sse_clients = clients;
}

global.__sse_publish = function (event, dataObj) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method Not Allowed');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // initial ping
  res.write(`event: ping\ndata: {}\n\n`);
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
};
