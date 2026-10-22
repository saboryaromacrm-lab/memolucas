import type { FastifyPluginAsync } from "fastify";
import { baseOk } from "../../db/index.js";
import { estadoScheduler } from "../../servicios/scheduler.js";
import { whatsapp } from "../../whatsapp/conexion.js";

export const rutasSalud: FastifyPluginAsync = async (app) => {
  app.get("/health", async (_req, reply) => {
    const db = await baseOk();
    const sch = estadoScheduler();
    const wa = whatsapp.info().estado;
    // WhatsApp caído no marca la app como caída (se reconecta sola); la base sí.
    return reply.code(db ? 200 : 503).send({
      ok: db && sch.activo,
      baseDeDatos: db ? "ok" : "caida",
      whatsapp: wa,
      scheduler: sch.activo ? "ok" : "detenido",
      ultimoBarrido: sch.ultimoBarrido,
    });
  });
};
