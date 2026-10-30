import type { FastifyPluginAsync } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { adjunto, grupo } from "../../db/schema.js";
import { normalizar } from "../../lib/textos.js";
import { tituloComprobante } from "../../lib/comprobantes.js";
import {
  actualizarDatos,
  confirmarComprobante,
  descartarComprobante,
  enviarAlErp,
  listarComprobantes,
  obtenerComprobante,
  type ComprobanteGuardado,
} from "../../servicios/compras.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const ESTADOS = ["pendiente", "revisar", "confirmado", "descartado"] as const;

async function serializar({ fila, datos }: ComprobanteGuardado, grupos: Map<string, string>) {
  const archivos =
    fila.archivosBorrados || !fila.adjuntoIds.length
      ? []
      : (await db.select({ id: adjunto.id, mime: adjunto.mime }).from(adjunto).where(inArray(adjunto.id, fila.adjuntoIds))).map((a) => ({
          url: `/api/adjuntos/${a.id}`,
          mime: a.mime,
        }));
  const { datosCifrados: _, ...resto } = fila;
  return {
    ...resto,
    titulo: tituloComprobante(datos),
    proveedor: datos.encabezado.razonSocialEmisor,
    moneda: datos.encabezado.moneda,
    renglones: datos.renglones.length,
    clase: datos.clase,
    diferencias: datos.controles.diferencias,
    dudas: datos.dudas,
    grupoNombre: fila.chat ? (grupos.get(fila.chat) ?? "Grupo") : null,
    archivos,
  };
}

const nombresGrupos = async () => new Map((await db.select().from(grupo)).map((g) => [g.jid, g.nombre]));

export const rutasCompras: FastifyPluginAsync = async (app) => {
  app.get("/compras", async (req) => {
    const { estado, q } = z.object({ estado: z.enum(ESTADOS).optional(), q: z.string().optional() }).parse(req.query);
    let lista = await listarComprobantes({ estado });
    if (q?.trim()) {
      const buscado = normalizar(q);
      lista = lista.filter((c) => normalizar(`${c.datos.encabezado.razonSocialEmisor} ${tituloComprobante(c.datos)} ${c.datos.encabezado.cuitEmisor}`).includes(buscado));
    }
    const grupos = await nombresGrupos();
    return Promise.all(lista.map((c) => serializar(c, grupos)));
  });

  app.get("/compras/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const c = await obtenerComprobante(id);
    if (!c) throw new ErrorUsuario("No existe ese comprobante");
    return { ...(await serializar(c, await nombresGrupos())), datos: c.datos };
  });

  app.put("/compras/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const { datos } = z.object({ datos: z.unknown() }).parse(req.body);
    const c = await actualizarDatos(id, datos);
    return { ...(await serializar(c, await nombresGrupos())), datos: c.datos };
  });

  app.post("/compras/:id/confirmar", async (req) => {
    const { id } = Id.parse(req.params);
    const r = await confirmarComprobante(id);
    if (!r) throw new ErrorUsuario("Ese comprobante ya estaba confirmado o descartado.");
    return { envio: r.envio };
  });

  app.post("/compras/:id/descartar", async (req) => {
    const { id } = Id.parse(req.params);
    if (!(await descartarComprobante(id))) throw new ErrorUsuario("Ese comprobante ya estaba confirmado o descartado.");
    return { ok: true };
  });

  app.post("/compras/:id/enviar", async (req) => {
    const { id } = Id.parse(req.params);
    return enviarAlErp(id);
  });

  /** El JSON tal cual lo espera el ERP: { comprobantes: [...] }. */
  app.post("/compras/exportar", async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body);
    const lista = await Promise.all(ids.map((id) => obtenerComprobante(id)));
    return { comprobantes: lista.filter((c) => !!c).map((c) => c.datos) };
  });

  app.put("/grupos/:jid", async (req) => {
    const { jid } = z.object({ jid: z.string().min(5) }).parse(req.params);
    const { compras } = z.object({ compras: z.boolean() }).parse(req.body);
    await db.update(grupo).set({ compras }).where(eq(grupo.jid, jid));
    return { ok: true };
  });
};
