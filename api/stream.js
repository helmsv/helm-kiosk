// /api/stream.js
export const config = { runtime: 'edge' };

// Channel name – keep consistent with publisher in sw-webhook.js
const CHANNEL = 'sw-events';

export default async function handler(req) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return new Response('Missing Upstash env', { status: 500 });
  }

  // Connect to Upstash SSE subscribe endpoint and pipe to client
  const upstream = await fetch(`${url.replace(/\/+$/,'')}/sse/subscribe/${CHANNEL}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    }
  });

  if (!upstream.ok || !upstream.body) {
    const peek = await upstream.text().catch(()=>'');
    return new Response(`Upstream subscribe failed ${upstream.status}: ${peek}`, { status: 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // send helper
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`));
      };

      // initial ping
      send('ping', {});

      const reader = upstream.body.getReader();

      // pipe everything we get from Upstash SSE directly to the client
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
        return pump();
      }).catch(() => controller.close());

      pump();

      // close when client disconnects
      req.signal.addEventListener('abort', () => {
        try { reader.cancel(); } catch {}
        try { controller.close(); } catch {}
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  });
}
