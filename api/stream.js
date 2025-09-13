// api/stream.js
export const config = { runtime: "edge" };

export default async function handler(req) {
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      function send(event, data) {
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      // Keep-alive ping every 20s
      const ping = setInterval(() => send("ping", { t: Date.now() }), 20000);

      // Subscribe via Upstash REST pub/sub (SSE-like long poll)
      let aborted = false;
      (async function loop() {
        while (!aborted) {
          try {
            const r = await fetch(`${UPSTASH_REDIS_REST_URL}/pubsub/subscribe/intakes`, {
              headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
              // Upstash holds the request open until a message arrives or timeout
            });
            if (r.ok) {
              const msg = await r.json(); // { messages: ["..."] } or one message
              if (msg && msg.messages) {
                for (const m of msg.messages) {
                  let parsed = null;
                  try { parsed = JSON.parse(m); } catch {}
                  if (parsed) send("intake", parsed);
                }
              }
            }
          } catch { /* ignore and retry */ }
        }
      })();

      return () => {
        aborted = true;
        clearInterval(ping);
      };
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}