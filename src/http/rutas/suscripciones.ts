import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { obtenerConfig } from "../../servicios/configuracion.js";
import { actualizarSuscripcion, borrarSuscripcion, crearSuscripcion, listarSuscripciones, renovarSuscripcion } from "../../servicios/suscripciones.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida");
const Datos = z.object({
  nombre: z.string().trim().min(1, "Falta el nombre").max(120),
  url: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).default(""),
  fechaInicio: Fecha.nullable().default(null),
  fechaVto: Fecha,
  monto: z.number().min(0).max(1_000_000_000).default(0),
  moneda: z.enum(["ARS", "USD"]).default("ARS"),
  frecuencia: z.enum(["7dias", "quincenal", "mensual", "anual"]),
  observacion: z.string().trim().max(1000).default(""),
});

export const rutasSuscripciones: FastifyPluginAsync = async (app) => {
  /** diasAviso: con cuántos días de anticipación avisa el bot (el panel lo usa para marcar las que vencen pronto). */
  app.get("/suscripciones", async () => ({ suscripciones: await listarSuscripciones(), diasAviso: (await obtenerConfig()).suscripcionesDiasAviso }));

  app.post("/suscripciones", async (req) => crearSuscripcion(Datos.parse(req.body)));

  app.put("/suscripciones/:id", async (req) => actualizarSuscripcion(Id.parse(req.params).id, Datos.parse(req.body)));

  app.delete("/suscripciones/:id", async (req) => {
    await borrarSuscripcion(Id.parse(req.params).id);
    return { ok: true };
  });

  app.post("/suscripciones/:id/renovar", async (req) => renovarSuscripcion(Id.parse(req.params).id));
};
