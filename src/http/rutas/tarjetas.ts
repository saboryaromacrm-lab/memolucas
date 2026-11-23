import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { obtenerConfig } from "../../servicios/configuracion.js";
import { guardarResumen, leerResumen } from "../../servicios/importar-resumen.js";
import {
  actualizarCuota,
  actualizarTarjeta,
  borrarCompra,
  borrarConsumo,
  borrarCuota,
  borrarTarjeta,
  cargarCompra,
  crearCuota,
  crearTarjeta,
  listarTarjetas,
  marcarPago,
} from "../../servicios/tarjetas.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida").nullable();
const Plata = z.number().min(0).max(1_000_000_000_000);
const DatosTarjeta = z.object({
  nombre: z.string().trim().min(1, "Falta el nombre").max(80),
  ultimos4: z.string().trim().regex(/^(\d{4})?$/, "Los últimos 4 números de la tarjeta (solo eso)"),
  cierre: Fecha,
  vencimiento: Fecha,
  limiteCompra: Plata,
  limiteCuotas: Plata,
  disponibleCompra: Plata,
  disponibleCuotas: Plata,
  saldo: Plata,
  pagoMinimo: Plata,
});
const DatosCuota = z.object({
  comercio: z.string().trim().min(1, "Falta el comercio").max(120),
  montoCuota: Plata.positive("Falta el monto de la cuota"),
  fechaCompra: Fecha,
  cuotaActual: z.number().int().min(0).max(120),
  cuotaTotal: z.number().int().min(1).max(120),
});
/** Una compra con la tarjeta (en un pago, o en cuotas si cuotas > 1). */
const DatosCompra = z.object({
  descripcion: z.string().trim().min(1, "Falta qué compraste").max(120),
  monto: Plata.positive("Falta el monto"),
  moneda: z.enum(["ARS", "USD"]).default("ARS"),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
  cuotas: z.number().int().min(1).max(120).default(1),
});
/** Lo revisado en el panel después de leer el resumen. El saldo puede ser negativo (a favor). */
const ResumenRevisado = z.object({
  cierre: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Falta la fecha de cierre"),
  vencimiento: Fecha,
  saldo: z.number().min(-1_000_000_000_000).max(1_000_000_000_000),
  pagoMinimo: Plata,
  limiteCompra: Plata.nullable(),
  limiteCuotas: Plata.nullable(),
  disponibleCompra: Plata,
  disponibleCuotas: Plata,
  ultimos4: z.string().regex(/^(\d{4})?$/).default(""),
  cuotas: z.array(DatosCuota.refine((c) => c.cuotaActual <= c.cuotaTotal, "Hay una cuota mayor que su total")).max(300),
  consumos: z.array(z.object({ nombre: z.string().trim().min(1).max(120), monto: z.number().min(0).max(1_000_000_000) })).max(300),
  cargos: z.array(z.object({ descripcion: z.string().trim().min(1).max(200), monto: z.number().min(-1_000_000_000).max(1_000_000_000) })).max(300),
});

export const rutasTarjetas: FastifyPluginAsync = async (app) => {
  /** diasAviso: con cuántos días de anticipación avisa el bot el vencimiento del resumen. */
  app.get("/tarjetas", async () => ({ tarjetas: await listarTarjetas(), diasAviso: (await obtenerConfig()).tarjetasDiasAviso }));

  app.post("/tarjetas", async (req) => crearTarjeta(DatosTarjeta.parse(req.body)));

  app.put("/tarjetas/:id", async (req) => {
    await actualizarTarjeta(Id.parse(req.params).id, DatosTarjeta.parse(req.body));
    return { ok: true };
  });

  app.delete("/tarjetas/:id", async (req) => {
    await borrarTarjeta(Id.parse(req.params).id);
    return { ok: true };
  });

  app.post("/tarjetas/:id/cuotas", async (req) => crearCuota(Id.parse(req.params).id, DatosCuota.parse(req.body)));

  app.put("/tarjetas/cuotas/:id", async (req) => {
    await actualizarCuota(Id.parse(req.params).id, DatosCuota.parse(req.body));
    return { ok: true };
  });

  app.delete("/tarjetas/cuotas/:id", async (req) => {
    await borrarCuota(Id.parse(req.params).id);
    return { ok: true };
  });

  /** Claude lee el texto del resumen (sacado del PDF en el navegador, o pegado). No guarda nada. */
  app.post("/tarjetas/leer-resumen", async (req) => leerResumen(z.object({ texto: z.string().trim().min(50, "Pegá el texto completo del resumen").max(200_000) }).parse(req.body).texto));

  app.post("/tarjetas/:id/resumenes", async (req) => guardarResumen(Id.parse(req.params).id, ResumenRevisado.parse(req.body)));

  app.post("/tarjetas/:id/compras", async (req) => cargarCompra(Id.parse(req.params).id, DatosCompra.parse(req.body)));

  app.delete("/tarjetas/compras/:id", async (req) => {
    await borrarCompra(Id.parse(req.params).id);
    return { ok: true };
  });

  /** Cuánto pagaste del último resumen. */
  app.put("/tarjetas/:id/pago", async (req) => {
    await marcarPago(Id.parse(req.params).id, z.object({ monto: Plata }).parse(req.body).monto);
    return { ok: true };
  });

  app.delete("/tarjetas/consumos/:id", async (req) => {
    await borrarConsumo(Id.parse(req.params).id);
    return { ok: true };
  });
};
