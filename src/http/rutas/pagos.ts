import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { analizarMesPagos, ARCHIVO_IA_MAX_BYTES, armarFijosConIa, cargarMesConIa, type ArchivoIa } from "../../bot/ia-pagos.js";
import { actualizarConfig, obtenerConfig } from "../../servicios/configuracion.js";
import {
  actualizarFijo,
  aplicarFijos,
  actualizarLugar,
  actualizarPagoDelMes,
  aplicarMes,
  borrarComprobante,
  borrarFijo,
  borrarLugar,
  borrarPago,
  COMPROBANTE_MAX_BYTES,
  corregirPago,
  crearFijo,
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
import { actualizarForma, borrarForma, crearForma, listarFormas, ordenarFormas, TIPOS_FORMA } from "../../servicios/pagos-formas.js";
import { CATEGORIAS, periodoDe } from "../../servicios/pagos-reglas.js";
import { hoyIso } from "../../lib/fechas.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const Periodo = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes inválido");
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida");
const Moneda = z.enum(["ARS", "USD"]);
const Monto = z.number().min(0).max(1e12);
const TipoLugar = z.enum(["negocio", "personal"]);
const Lugar = z.object({ nombre: z.string().max(60), tipo: TipoLugar });
const IdForma = z.number().int().positive();
const Forma = z.object({ nombre: z.string().max(60), tipo: z.enum(TIPOS_FORMA) });
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
  /** null: sin vencimiento. */
  dia: z.number().int().min(1).max(31).nullable(),
  frecuencia: z.enum(["mensual", "bimestral", "trimestral", "cuatrimestral", "semestral", "anual", "unica"]),
  desde: Periodo.optional(),
  formaId: IdForma.nullable(),
  cuenta: z.string().max(120),
  avisoDias: z.number().int().min(-1).max(30).nullable(),
  nota: z.string().max(500),
});

/** Lo que se le pasa a la IA: texto y, opcional, una foto o un PDF (en base64). */
const PedidoIa = z
  .object({
    texto: z.string().max(8000).default(""),
    archivo: z.object({ mime: z.string().regex(/^(image\/[\w.+-]+|application\/pdf)$/, "Mandá una foto o un PDF."), base64: z.string() }).optional(),
  })
  .refine((p) => p.texto.trim().length >= 3 || p.archivo, "Escribí qué querés o pegá una foto o un PDF.");
const archivoDe = (a?: { mime: string; base64: string }): ArchivoIa | undefined => (a ? { mime: a.mime, datos: Buffer.from(a.base64, "base64") } : undefined);
/** El archivo viaja en base64 (un tercio más grande). */
const LIMITE_IA = Math.ceil(ARCHIVO_IA_MAX_BYTES * 1.4) + 64 * 1024;

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
    return {
      lugares: await listarLugares(),
      fijos: await listarFijos(),
      formas: await listarFormas(),
      categorias: CATEGORIAS,
      diasAviso: cfg.pagosDiasAviso,
      mensajes: cfg.pagosMensajes,
      notasIa: cfg.pagosNotasIa,
    };
  });
  app.put("/pagos/ajustes", async (req) => {
    const a = z.object({ diasAviso: z.number().int().min(0).max(30), mensajes: z.boolean(), notasIa: z.string().max(4000) }).partial().parse(req.body);
    await actualizarConfig({
      ...(a.diasAviso !== undefined ? { pagosDiasAviso: a.diasAviso } : {}),
      ...(a.mensajes !== undefined ? { pagosMensajes: a.mensajes } : {}),
      ...(a.notasIa !== undefined ? { pagosNotasIa: a.notasIa.trim() } : {}),
    });
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

  app.post("/pagos/formas", async (req) => crearForma(Forma.parse(req.body)));
  app.put("/pagos/formas/orden", async (req) => {
    await ordenarFormas(z.object({ ids: z.array(IdForma).max(200) }).parse(req.body).ids);
    return { ok: true };
  });
  app.put("/pagos/formas/:id", async (req) => {
    await actualizarForma(Id.parse(req.params).id, Forma.partial().parse(req.body));
    return { ok: true };
  });
  app.delete("/pagos/formas/:id", async (req) => {
    await borrarForma(Id.parse(req.params).id);
    return { ok: true };
  });

  app.post("/pagos/fijos", async (req) => crearFijo(Fijo.parse(req.body)));
  /** Lo que propuso la IA y revisaste: agrega (los lugares nuevos se crean), cambia y borra. */
  app.post("/pagos/fijos/aplicar", async (req) => {
    const Propuesto = Fijo.extend({ lugarNuevo: Lugar.optional() });
    const IdFijo = z.number().int().positive();
    return aplicarFijos(
      z.object({ nuevos: z.array(Propuesto).max(200), cambios: z.array(Propuesto.extend({ id: IdFijo })).max(500), borrar: z.array(IdFijo).max(500) }).parse(req.body),
    );
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
  app.post("/pagos/ia/armar", { bodyLimit: LIMITE_IA }, async (req) => {
    const p = PedidoIa.parse(req.body);
    return armarFijosConIa(p.texto, archivoDe(p.archivo));
  });
  /** Los montos de un mes leídos de una foto, un PDF o un texto (el resumen de la contadora): para revisar. */
  app.post("/pagos/ia/mes", { bodyLimit: LIMITE_IA }, async (req) => {
    const p = PedidoIa.and(z.object({ periodo: Periodo })).parse(req.body);
    return cargarMesConIa(p.periodo, p.texto, archivoDe(p.archivo));
  });
  app.post("/pagos/ia/analizar", async (req) => ({ texto: await analizarMesPagos(z.object({ periodo: Periodo }).parse(req.body).periodo) }));

  // ── Los pagos del mes ──
  /** Lo que leyó la IA y revisaste: los montos van a los pagos del mes y lo que faltaba se crea. */
  app.post("/pagos/mes/aplicar", async (req) => {
    const Propuesto = Fijo.extend({ lugarNuevo: Lugar.optional() });
    const { periodo, montos, nuevos } = z
      .object({
        periodo: Periodo,
        montos: z.array(z.union([z.object({ fijoId: z.number().int().positive(), monto: Monto }), z.object({ itemId: z.number().int().positive(), monto: Monto })])).max(500),
        nuevos: z.array(Propuesto).max(200),
      })
      .parse(req.body);
    return aplicarMes(periodo, { montos, nuevos });
  });
  app.post("/pagos", async (req) =>
    crearSuelto(
      z
        .object({ nombre: z.string().max(120), lugarId: z.number().int().positive().nullable(), tipo: TipoLugar.optional(), categoria: z.string().max(60), monto: Monto, moneda: Moneda, fecha: Fecha, formaId: IdForma.nullable(), nota: z.string().max(500), pagado: z.boolean() })
        .parse(req.body),
    ),
  );
  app.post("/pagos/:id/pagar", async (req) =>
    registrarPago(Id.parse(req.params).id, z.object({ monto: Monto.optional(), fecha: Fecha.optional(), formaId: IdForma }).parse(req.body ?? {})),
  );
  /** Corregir un pago ya hecho: la última parte (monto y fecha) y con qué se pagó. */
  app.put("/pagos/:id/pago", async (req) => corregirPago(Id.parse(req.params).id, z.object({ monto: Monto, fecha: Fecha, formaId: IdForma }).parse(req.body)));
  app.post("/pagos/:id/desmarcar", async (req) => {
    await desmarcarPago(Id.parse(req.params).id);
    return { ok: true };
  });
  app.post("/pagos/:id/omitir", async (req) => {
    await omitirPago(Id.parse(req.params).id, z.object({ omitido: z.boolean() }).parse(req.body).omitido);
    return { ok: true };
  });
  app.put("/pagos/:id", async (req) =>
    actualizarPagoDelMes(Id.parse(req.params).id, z.object({ monto: Monto, vence: Fecha.nullable(), nota: z.string().max(500) }).partial().parse(req.body)),
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
