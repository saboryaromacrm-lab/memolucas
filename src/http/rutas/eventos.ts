import type { FastifyPluginAsync } from "fastify";
import { bus } from "../../lib/eventos.js";

/** Server-Sent Events: el panel se entera de los cambios y se actualiza solo. */
export const rutasEventos: FastifyPluginAsync = async (app) => {
  app.get("/eventos", { config: { rateLimit: false } }, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const enviar = (e: unknown) => res.write(`event: cambio\ndata: ${JSON.stringify(e)}\n\n`);
    const latido = setInterval(() => res.write(": latido\n\n"), 25_000);
    bus.on("cambio", enviar);
    req.raw.on("close", () => {
      clearInterval(latido);
      bus.off("cambio", enviar);
    });
  });
};
