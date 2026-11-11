import { dashboardEvents, type DashboardEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: DashboardEvent) => controller.enqueue(encoder.encode(`event: dashboard\ndata: ${JSON.stringify(event)}\n\n`));
      const close = () => { clearInterval(heartbeat); dashboardEvents.off("event", send); try { controller.close(); } catch { return; } };
      dashboardEvents.on("event", send);
      controller.enqueue(encoder.encode(`event: connected\ndata: {"ok":true}\n\n`));
      heartbeat = setInterval(() => controller.enqueue(encoder.encode(`: heartbeat\n\n`)), 20_000);
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() { clearInterval(heartbeat); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
