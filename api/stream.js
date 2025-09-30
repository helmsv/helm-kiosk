// api/stream.js
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // helper to send an SSE event
      const send = (event, data) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      // Subscribe to BroadcastChannel for waiver events
      const bc = new BroadcastChannel('sw-events');
      bc.onmessage = (evt) => {
        const { type, data } = evt.data || {};
        if (type === 'intake' || type === 'liability' || type === 'ping') {
          send(type, data || {});
        }
      };

      // Initial ping + keepalive pings
      send('ping', {});
      const pingId = setInterval(() => send('ping', {}), 20000);

      // Close when client disconnects
      const abort = () => {
        try { clearInterval(pingId); } catch {}
        try { bc.close(); } catch {}
        try { controller.close(); } catch {}
      };
      req.signal.addEventListener('abort', abort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
