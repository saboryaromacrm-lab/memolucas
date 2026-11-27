import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { obtenerConfig } from "../../servicios/configuracion.js";
import { sugerirTarjetas } from "../../servicios/tarjetas.js";
import { actualizarSuscripcion, borrarSuscripcion, crearSuscripcion, listarSuscripciones, pagarSuscripcionCon, renovarSuscripcion } from "../../servicios/suscripciones.js";

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
  tarjetaId: z.number().int().positive().nullable().default(null),
  sinTarjeta: z.boolean().default(false),
  /** Es del negocio: en Pagos cuenta como "General · negocio". */
  negocio: z.boolean().default(false),
});

export const rutasSuscripciones: FastifyPluginAsync = async (app) => {
  /**
   * diasAviso: con cuántos días de anticipación avisa el bot (el panel lo usa para marcar las que vencen pronto).
   * sugerencias: con qué tarjeta parece pagarse cada una que no lo tiene definido.
   */
  app.get("/suscripciones", async () => {
    const suscripciones = await listarSuscripciones();
    return { suscripciones, sugerencias: await sugerirTarjetas(suscripciones), diasAviso: (await obtenerConfig()).suscripcionesDiasAviso };
  });

  app.post("/suscripciones", async (req) => crearSuscripcion(Datos.parse(req.body)));

  app.put("/suscripciones/:id", async (req) => actualizarSuscripcion(Id.parse(req.params).id, Datos.parse(req.body)));

  app.delete("/suscripciones/:id", async (req) => {
    await borrarSuscripcion(Id.parse(req.params).id);
    return { ok: true };
  });

  /** Con qué tarjeta se paga (null: con otro medio). */
  app.put("/suscripciones/:id/tarjeta", async (req) => {
    await pagarSuscripcionCon(Id.parse(req.params).id, z.object({ tarjetaId: z.number().int().positive().nullable() }).parse(req.body).tarjetaId);
    return { ok: true };
  });

  app.post("/suscripciones/:id/renovar", async (req) => renovarSuscripcion(Id.parse(req.params).id));
};
