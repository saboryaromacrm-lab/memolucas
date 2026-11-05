import type { FastifyPluginAsync } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { adjunto, formaPago, grupo, proveedor } from "../../db/schema.js";
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
import { actualizarUsuario, borrarUsuario, crearUsuario, listarUsuarios } from "../../servicios/panel-compras.js";
import { borrarAdjunto, guardarArchivo, MIMES_IMAGEN } from "../../servicios/adjuntos.js";
import { actualizarConfig, obtenerConfig } from "../../servicios/configuracion.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const ESTADOS = ["pendiente", "revisar", "confirmado", "descartado"] as const;

/** prefijo: desde dónde se sirven los archivos (el panel de compras usa su propia ruta). */
export async function serializar({ fila, datos }: ComprobanteGuardado, n: Nombres, prefijo = "/api/adjuntos") {
  const archivos =
    fila.archivosBorrados || !fila.adjuntoIds.length
      ? []
      : (await db.select({ id: adjunto.id, mime: adjunto.mime }).from(adjunto).where(inArray(adjunto.id, fila.adjuntoIds))).map((a) => ({
          url: `${prefijo}/${a.id}`,
          mime: a.mime,
        }));
  const { datosCifrados: _, ...resto } = fila;
  return {
    ...resto,
    titulo: fila.origen === "manual" ? "Sin factura" : tituloComprobante(datos),
    // El nombre de Proveedores (si se lo cambió, se ve el nuevo); si no tiene, el de la factura.
    proveedor: (fila.proveedorId && n.proveedores.get(fila.proveedorId)) || datos.encabezado.razonSocialEmisor,
    formaPago: (fila.formaPagoId && n.formasPago.get(fila.formaPagoId)) || null,
    moneda: datos.encabezado.moneda,
    renglones: datos.renglones.length,
    clase: datos.clase,
    diferencias: datos.controles.diferencias,
    dudas: datos.dudas,
    grupoNombre: fila.chat ? (n.grupos.get(fila.chat) ?? "Grupo") : null,
    archivos,
  };
}

type Nombres = { grupos: Map<string, string>; proveedores: Map<number, string>; formasPago: Map<number, string> };
/** Nombres de grupos, proveedores y formas de pago, para mostrar cada comprobante. */
export async function nombres(): Promise<Nombres> {
  const [grupos, proveedores, formas] = await Promise.all([
    db.select().from(grupo),
    db.select({ id: proveedor.id, nombre: proveedor.nombre }).from(proveedor),
    db.select({ id: formaPago.id, nombre: formaPago.nombre }).from(formaPago),
  ]);
  const porId = (filas: { id: number; nombre: string }[]) => new Map(filas.map((f) => [f.id, f.nombre]));
  return { grupos: new Map(grupos.map((g) => [g.jid, g.nombre])), proveedores: porId(proveedores), formasPago: porId(formas) };
}

export const rutasCompras: FastifyPluginAsync = async (app) => {
  app.get("/compras", async (req) => {
    const { estado, q } = z.object({ estado: z.enum(ESTADOS).optional(), q: z.string().optional() }).parse(req.query);
    let lista = await listarComprobantes({ estado });
    if (q?.trim()) {
      const buscado = normalizar(q);
      lista = lista.filter((c) => normalizar(`${c.datos.encabezado.razonSocialEmisor} ${tituloComprobante(c.datos)} ${c.datos.encabezado.cuitEmisor}`).includes(buscado));
    }
    const n = await nombres();
    return Promise.all(lista.map((c) => serializar(c, n)));
  });

  app.get("/compras/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const c = await obtenerComprobante(id);
    if (!c) throw new ErrorUsuario("No existe ese comprobante");
    return { ...(await serializar(c, await nombres())), datos: c.datos };
  });

  app.put("/compras/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const { datos } = z.object({ datos: z.unknown() }).parse(req.body);
    const c = await actualizarDatos(id, datos);
    return { ...(await serializar(c, await nombres())), datos: c.datos };
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

  // ───── Panel de compras: personas con acceso y logo ─────
  const publico = (u: Awaited<ReturnType<typeof listarUsuarios>>[number]) => ({
    id: u.id,
    nombre: u.nombre,
    activo: u.activo,
    ultimoIngreso: u.ultimoIngreso,
    creadoEn: u.creadoEn,
  });
  const Clave = z.string().regex(/^\d{4,8}$/, "La clave tiene que tener de 4 a 8 números");

  app.get("/compras-usuarios", async () => (await listarUsuarios()).map(publico));

  app.post("/compras-usuarios", async (req) => {
    const { nombre, clave } = z.object({ nombre: z.string().trim().min(1).max(60), clave: Clave }).parse(req.body);
    return publico(await crearUsuario(nombre, clave));
  });

  app.put("/compras-usuarios/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const c = z.object({ nombre: z.string().trim().min(1).max(60).optional(), clave: Clave.optional(), activo: z.boolean().optional() }).parse(req.body);
    return publico(await actualizarUsuario(id, c));
  });

  app.delete("/compras-usuarios/:id", async (req) => {
    await borrarUsuario(Id.parse(req.params).id);
    return { ok: true };
  });

  app.post("/configuracion/compras-logo", async (req) => {
    const archivo = await req.file();
    if (!archivo) throw new ErrorUsuario("No llegó ninguna imagen");
    const mime = archivo.mimetype.split(";")[0];
    if (!MIMES_IMAGEN.includes(mime)) throw new ErrorUsuario("El logo tiene que ser una imagen PNG, JPG o WEBP.");
    const adj = await guardarArchivo(await archivo.toBuffer(), mime);
    const anterior = (await obtenerConfig()).comprasLogoAdjuntoId;
    await actualizarConfig({ comprasLogoAdjuntoId: adj.id });
    if (anterior) await borrarAdjunto(anterior);
    return { ok: true };
  });

  app.delete("/configuracion/compras-logo", async () => {
    const anterior = (await obtenerConfig()).comprasLogoAdjuntoId;
    await actualizarConfig({ comprasLogoAdjuntoId: null });
    if (anterior) await borrarAdjunto(anterior);
    return { ok: true };
  });

  app.put("/grupos/:jid", async (req) => {
    const { jid } = z.object({ jid: z.string().min(5) }).parse(req.params);
    const { compras } = z.object({ compras: z.boolean() }).parse(req.body);
    await db.update(grupo).set({ compras }).where(eq(grupo.jid, jid));
    return { ok: true };
  });
};
