import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { analizarMesPagos, armarFijosConIa } from "../../bot/ia-pagos.js";
import { actualizarConfig, obtenerConfig } from "../../servicios/configuracion.js";
import {
  actualizarFijo,
  actualizarLugar,
  actualizarPagoDelMes,
  borrarComprobante,
  borrarFijo,
  borrarLugar,
  borrarPago,
  COMPROBANTE_MAX_BYTES,
  crearFijo,
  crearFijos,
  crearLugar,
  crearSuelto,
  desmarcarPago,
  exportarCsv,
  guardarComprobante,
  leerComprobante,
  listarFijos,
  listarLugares,
  omitirPago,
  registrarPago,
  resumenPagos,
  verMes,
} from "../../servicios/pagos.js";
import { CATEGORIAS, MEDIOS, periodoDe } from "../../servicios/pagos-reglas.js";
import { hoyIso } from "../../lib/fechas.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const Periodo = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes inválido");
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida");
const Moneda = z.enum(["ARS", "USD"]);
const Monto = z.number().min(0).max(1e12);
const TipoLugar = z.enum(["negocio", "personal"]);
const Lugar = z.object({ nombre: z.string().max(60), tipo: TipoLugar });
/** A qué corresponde: un lugar, repartido entre varios (iguales o con %) o general (de negocio o personal). */
const Alcance = z.object({
  alcance: z.enum(["lugar", "repartido", "general"]),
  lugarId: z.number().int().positive().nullable(),
  tipo: TipoLugar.nullable(),
  reparto: z.array(z.object({ lugarId: z.number().int().positive(), porcentaje: z.number().min(0).max(100).nullable() })).max(50).nullable(),
});
const Fijo = Alcance.extend({
  nombre: z.string().max(120),
  categoria: z.string().max(60),
  monto: Monto,
  variable: z.boolean(),
  moneda: Moneda,
  dia: z.number().int().min(1).max(31),
  frecuencia: z.enum(["mensual", "bimestral", "trimestral", "cuatrimestral", "semestral", "anual", "unica"]),
  desde: Periodo.optional(),
  medio: z.string().max(60),
  cuenta: z.string().max(120),
  avisoDias: z.number().int().min(-1).max(30).nullable(),
  nota: z.string().max(500),
});

const mesDe = (query: unknown) => z.object({ periodo: Periodo.optional() }).parse(query).periodo ?? periodoDe(hoyIso());

export const rutasPagos: FastifyPluginAsync = async (app) => {
  app.get("/pagos/mes", async (req) => verMes(mesDe(req.query)));
  app.get("/pagos/resumen", async (req) => resumenPagos(mesDe(req.query)));

  app.get("/pagos/exportar", async (req, reply) => {
    const { desde, hasta } = z.object({ desde: Periodo, hasta: Periodo }).parse(req.query);
    if (desde > hasta) throw new ErrorUsuario("El mes «desde» tiene que ser antes que «hasta».");
    return reply
      .header("Content-Disposition", `attachment; filename="pagos-${desde}${desde === hasta ? "" : `-a-${hasta}`}.csv"`)
      .type("text/csv; charset=utf-8")
      .send(await exportarCsv(desde, hasta));
  });

  // ── Configuración: lugares, fijos y ajustes ──
  app.get("/pagos/config", async () => {
    const cfg = await obtenerConfig();
    return { lugares: await listarLugares(), fijos: await listarFijos(), categorias: CATEGORIAS, medios: MEDIOS, diasAviso: cfg.pagosDiasAviso, mensajes: cfg.pagosMensajes };
  });
  app.put("/pagos/ajustes", async (req) => {
    const a = z.object({ diasAviso: z.number().int().min(0).max(30), mensajes: z.boolean() }).partial().parse(req.body);
    await actualizarConfig({ ...(a.diasAviso !== undefined ? { pagosDiasAviso: a.diasAviso } : {}), ...(a.mensajes !== undefined ? { pagosMensajes: a.mensajes } : {}) });
    return { ok: true };
  });

  app.post("/pagos/lugares", async (req) => crearLugar(Lugar.parse(req.body)));
  app.put("/pagos/lugares/:id", async (req) => {
    await actualizarLugar(Id.parse(req.params).id, Lugar.partial().parse(req.body));
    return { ok: true };
  });
  app.delete("/pagos/lugares/:id", async (req) => {
    await borrarLugar(Id.parse(req.params).id);
    return { ok: true };
  });

  app.post("/pagos/fijos", async (req) => crearFijo(Fijo.parse(req.body)));
  /** Lo que armó la IA y revisaste: los lugares nuevos se crean. */
  app.post("/pagos/fijos/lote", async (req) => {
    const { fijos } = z
      .object({ fijos: z.array(Fijo.extend({ lugarNuevo: Lugar.optional() })).max(200) })
      .parse(req.body);
    return crearFijos(fijos);
  });
  app.put("/pagos/fijos/:id", async (req) => {
    await actualizarFijo(Id.parse(req.params).id, Fijo.parse(req.body));
    return { ok: true };
  });
  app.delete("/pagos/fijos/:id", async (req) => {
    await borrarFijo(Id.parse(req.params).id);
    return { ok: true };
  });

  // ── IA ──
  app.post("/pagos/ia/armar", async (req) => armarFijosConIa(z.object({ texto: z.string().min(3).max(8000) }).parse(req.body).texto));
  app.post("/pagos/ia/analizar", async (req) => ({ texto: await analizarMesPagos(z.object({ periodo: Periodo }).parse(req.body).periodo) }));

  // ── Los pagos del mes ──
  app.post("/pagos", async (req) =>
    crearSuelto(
      z
        .object({ nombre: z.string().max(120), lugarId: z.number().int().positive().nullable(), tipo: TipoLugar.optional(), categoria: z.string().max(60), monto: Monto, moneda: Moneda, fecha: Fecha, medio: z.string().max(60), nota: z.string().max(500), pagado: z.boolean() })
        .parse(req.body),
    ),
  );
  app.post("/pagos/:id/pagar", async (req) =>
    registrarPago(Id.parse(req.params).id, z.object({ monto: Monto.optional(), fecha: Fecha.optional(), medio: z.string().max(60).optional() }).parse(req.body ?? {})),
  );
  app.post("/pagos/:id/desmarcar", async (req) => {
    await desmarcarPago(Id.parse(req.params).id);
    return { ok: true };
  });
  app.post("/pagos/:id/omitir", async (req) => {
    await omitirPago(Id.parse(req.params).id, z.object({ omitido: z.boolean() }).parse(req.body).omitido);
    return { ok: true };
  });
  app.put("/pagos/:id", async (req) =>
    actualizarPagoDelMes(Id.parse(req.params).id, z.object({ monto: Monto, vence: Fecha, nota: z.string().max(500), medio: z.string().max(60) }).partial().parse(req.body)),
  );
  app.delete("/pagos/:id", async (req) => {
    await borrarPago(Id.parse(req.params).id);
    return { ok: true };
  });

  // ── Comprobantes: llegan tal cual (foto o PDF), hasta 15 MB ──
  app.addContentTypeParser(/^(image\/.+|application\/pdf)$/, { parseAs: "buffer", bodyLimit: COMPROBANTE_MAX_BYTES }, (_req, cuerpo, listo) => listo(null, cuerpo));
  app.put("/pagos/:id/comprobante", { bodyLimit: COMPROBANTE_MAX_BYTES }, async (req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ErrorUsuario("Mandá una foto o un PDF.");
    await guardarComprobante(Id.parse(req.params).id, req.body, String(req.headers["content-type"] ?? "").split(";")[0]);
    return { ok: true };
  });
  app.get("/pagos/:id/comprobante", async (req, reply) => {
    const c = await leerComprobante(Id.parse(req.params).id);
    return reply.header("Cache-Control", "private, no-cache").type(c.mime).send(c.datos);
  });
  app.delete("/pagos/:id/comprobante", async (req) => {
    await borrarComprobante(Id.parse(req.params).id);
    return { ok: true };
  });
};
