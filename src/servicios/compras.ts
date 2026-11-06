import fs from "node:fs/promises";
import { and, desc, eq, gt, inArray, isNull, lt, ne, notExists, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { adjunto, comprobante, encuesta, formaPago, grupo, precioProducto, producto, proveedor, type FilaComprobante } from "../db/schema.js";
import { cifrar, descifrar } from "../lib/cifrado.js";
import { claveDe, controlar, EsquemaComprobante, type Comprobante } from "../lib/comprobantes.js";
import { bus } from "../lib/eventos.js";
import { registrar } from "../lib/log.js";
import { borrarAdjunto } from "./adjuntos.js";
import { obtenerConfig } from "./configuracion.js";
import { exigirFormaPago, sugerirFormaPago } from "./formas-pago.js";
import { enlazarSegunCompras, fechaDeCompra, proveedorPara, sincronizarNombres } from "./proveedores.js";
import { ErrorUsuario, filtroChat } from "./recordatorios.js";

export type ComprobanteGuardado = { fila: FilaComprobante; datos: Comprobante };

const MINUTOS_CORRECCION = 30;

export async function esGrupoCompras(jid: string | null): Promise<boolean> {
  if (!jid) return false;
  const [g] = await db.select({ compras: grupo.compras }).from(grupo).where(eq(grupo.jid, jid));
  return !!g?.compras;
}

export function leerDatos(fila: FilaComprobante): Comprobante {
  const texto = descifrar(fila.datosCifrados);
  if (!texto) throw new Error(`No se pudo descifrar el comprobante ${fila.id}`);
  return JSON.parse(texto) as Comprobante;
}

/** El proveedor de la factura (se crea solo si es nuevo). */
const proveedorDe = (datos: Comprobante) => proveedorPara(datos.encabezado.razonSocialEmisor, datos.encabezado.cuitEmisor);

/** El proveedor y la forma de pago preelegida (la que figura en la factura o la habitual del proveedor). */
async function vinculosDe(datos: Comprobante) {
  const proveedorId = await proveedorDe(datos);
  const { figura, medio } = datos.pagoQueFigura;
  return { proveedorId, formaPagoSugerida: await sugerirFormaPago(figura ? medio : "", proveedorId) };
}

export const columnas = (datos: Comprobante, cierra: boolean) => ({
  datosCifrados: cifrar(JSON.stringify(datos)),
  clave: claveDe(datos),
  fecha: datos.encabezado.fecha || null,
  total: datos.pie.total.toFixed(2),
  cierra,
});

/** Otro comprobante igual ya cargado (no descartado). */
export async function buscarDuplicado(c: Comprobante, sinId?: number): Promise<FilaComprobante | null> {
  const clave = claveDe(c);
  if (!clave) return null;
  const [fila] = await db
    .select()
    .from(comprobante)
    .where(and(eq(comprobante.clave, clave), ne(comprobante.estado, "descartado"), sinId ? ne(comprobante.id, sinId) : undefined))
    .limit(1);
  return fila ?? null;
}

export async function guardarComprobante(d: {
  chat: string | null;
  autor: string | null;
  origen?: FilaComprobante["origen"];
  datos: Comprobante;
  cierra: boolean;
  modelo: string | null;
  adjuntoIds: number[];
}): Promise<FilaComprobante> {
  const { proveedorId, formaPagoSugerida } = await vinculosDe(d.datos);
  const [fila] = await db
    .insert(comprobante)
    .values({
      chat: d.chat,
      autor: d.autor,
      origen: d.origen ?? "whatsapp",
      estado: d.cierra ? "pendiente" : "revisar",
      modelo: d.modelo,
      adjuntoIds: d.adjuntoIds,
      proveedorId,
      formaPagoId: formaPagoSugerida,
      ...columnas(d.datos, d.cierra),
    })
    .returning();
  bus.avisar("compras");
  return fila;
}

export type Nombres = { grupos: Map<string, string>; proveedores: Map<number, string>; formasPago: Map<number, string> };
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

export async function obtenerComprobante(id: number): Promise<ComprobanteGuardado | null> {
  const [fila] = await db.select().from(comprobante).where(eq(comprobante.id, id));
  return fila ? { fila, datos: leerDatos(fila) } : null;
}

/** periodo: solo los de ese mes ("2026-11") o día ("2026-11-05"), por la fecha de la factura. */
export async function listarComprobantes(f: { estado?: string; desde?: Date; hasta?: Date; proveedorId?: number; periodo?: string } = {}): Promise<ComprobanteGuardado[]> {
  const filas = await db
    .select()
    .from(comprobante)
    .where(
      and(
        f.estado ? eq(comprobante.estado, f.estado as FilaComprobante["estado"]) : ne(comprobante.estado, "descartado"),
        f.desde ? gt(comprobante.creadoEn, f.desde) : undefined,
        f.hasta ? lt(comprobante.creadoEn, f.hasta) : undefined,
        f.proveedorId ? eq(comprobante.proveedorId, f.proveedorId) : undefined,
        f.periodo ? sql`${fechaDeCompra} like ${`${f.periodo}%`}` : undefined,
      ),
    )
    .orderBy(desc(comprobante.id))
    .limit(500);
  return filas.map((fila) => ({ fila, datos: leerDatos(fila) }));
}

/** Guarda una versión corregida: rehace los controles y vuelve a "pendiente" o "revisar". */
export async function actualizarDatos(id: number, nuevos: unknown): Promise<ComprobanteGuardado> {
  const actual = await obtenerComprobante(id);
  if (!actual) throw new ErrorUsuario("No existe ese comprobante");
  if (actual.fila.estado === "confirmado") throw new ErrorUsuario("Ya está confirmado: no se puede cambiar.");
  const { comprobante: datos, cierra } = controlar(EsquemaComprobante.parse(nuevos));
  const { proveedorId, formaPagoSugerida } = await vinculosDe(datos);
  const [fila] = await db
    .update(comprobante)
    .set({
      ...columnas(datos, cierra),
      proveedorId,
      // La forma elegida a mano se respeta; si no tenía, se preelige.
      formaPagoId: sql`coalesce(${comprobante.formaPagoId}, ${formaPagoSugerida}::int)`,
      estado: cierra ? "pendiente" : "revisar", corrigiendoHasta: null, actualizadoEn: sql`now()` })
    .where(eq(comprobante.id, id))
    .returning();
  bus.avisar("compras");
  return { fila, datos };
}

/** Cómo se pagó la compra (null = sin especificar). Se puede cambiar siempre, aunque ya esté confirmada. */
export async function fijarFormaPago(id: number, formaPagoId: number | null) {
  await exigirFormaPago(formaPagoId);
  const [fila] = await db.update(comprobante).set({ formaPagoId, actualizadoEn: sql`now()` }).where(eq(comprobante.id, id)).returning({ id: comprobante.id });
  if (!fila) throw new ErrorUsuario("No existe ese comprobante");
  bus.avisar("compras");
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Los productos que quedaron sin ninguna compra (por editar, borrar o mover compras) se borran. */
export async function borrarHuerfanos(tx: Tx, ids: number[]) {
  if (!ids.length) return;
  await tx
    .delete(producto)
    .where(and(inArray(producto.id, ids), notExists(tx.select({ uno: sql`1` }).from(precioProducto).where(eq(precioProducto.productoId, producto.id)))));
}

/**
 * Borra comprobantes del todo, con sus fotos. Lo que habían pasado a Productos sale con ellos (los productos que
 * quedan sin compras se borran; el proveedor queda). Las confirmadas solo si se puede (quien tiene Métricas).
 */
export async function borrarComprobantes(ids: number[], conConfirmadas: boolean) {
  const filas = await db.select().from(comprobante).where(inArray(comprobante.id, ids));
  if (filas.length !== new Set(ids).size) throw new ErrorUsuario("Alguna de esas facturas ya no existe.");
  if (!conConfirmadas && filas.some((f) => f.estado === "confirmado")) throw new ErrorUsuario("Las facturas confirmadas solo las puede borrar quien tiene Métricas.");
  await db.transaction(async (tx) => {
    const productos = await tx.select({ id: precioProducto.productoId }).from(precioProducto).where(inArray(precioProducto.comprobanteId, ids));
    // Sus precios en Productos se borran solos con el comprobante.
    await tx.delete(comprobante).where(inArray(comprobante.id, ids));
    await borrarHuerfanos(tx, productos.map((p) => p.id));
  });
  for (const a of filas.flatMap((f) => f.adjuntoIds)) await borrarAdjunto(a);
  bus.avisar("compras");
}

/** Al arrancar: las facturas sin confirmar se vuelven a controlar, por si el control cambió (ej. una que no cerraba y ahora sí). */
export async function recontrolarPendientes() {
  const filas = await db
    .select()
    .from(comprobante)
    .where(inArray(comprobante.estado, ["pendiente", "revisar"]));
  let cambiaron = 0;
  for (const fila of filas) {
    const antes = leerDatos(fila);
    const { comprobante: datos, cierra } = controlar(antes);
    if (JSON.stringify(datos) === JSON.stringify(antes)) continue;
    await db
      .update(comprobante)
      .set({ ...columnas(datos, cierra), estado: cierra ? "pendiente" : "revisar" })
      .where(eq(comprobante.id, fila.id));
    cambiaron++;
  }
  if (cambiaron) bus.avisar("compras");
}

/** Al arrancar: las facturas que todavía no tienen proveedor (las de antes de Proveedores) se vinculan solas, con sus productos. */
export async function vincularProveedores() {
  const filas = await db.select().from(comprobante).where(isNull(comprobante.proveedorId));
  for (const fila of filas) {
    const proveedorId = await proveedorDe(leerDatos(fila));
    if (!proveedorId) continue;
    await db.update(comprobante).set({ proveedorId }).where(eq(comprobante.id, fila.id));
    await enlazarSegunCompras(db, sql`c.id = ${fila.id}`);
  }
  await sincronizarNombres();
}

export async function fijarMensaje(id: number, waMessageId: string | null) {
  await db.update(comprobante).set({ waMessageId }).where(eq(comprobante.id, id));
}

export async function empezarCorreccion(id: number) {
  await db
    .update(comprobante)
    .set({ corrigiendoHasta: new Date(Date.now() + MINUTOS_CORRECCION * 60_000) })
    .where(eq(comprobante.id, id));
}

/** El comprobante al que se responde: citando el resumen o la encuesta. */
export async function comprobantePorMensaje(waMessageId: string, chat: string | null): Promise<FilaComprobante | null> {
  const [porResumen] = await db
    .select()
    .from(comprobante)
    .where(and(eq(comprobante.waMessageId, waMessageId), filtroChat(comprobante.chat, chat)));
  if (porResumen) return porResumen;
  const [enc] = await db.select().from(encuesta).where(eq(encuesta.waMessageId, waMessageId));
  if (enc?.accion.tipo !== "comprobante") return null;
  const [fila] = await db
    .select()
    .from(comprobante)
    .where(and(eq(comprobante.id, enc.accion.comprobanteId), filtroChat(comprobante.chat, chat)));
  return fila ?? null;
}

/** Comprobante que espera una corrección en este chat (después de tocar "✏️ Corregir"). */
export async function comprobanteEnCorreccion(chat: string | null): Promise<FilaComprobante | null> {
  const [fila] = await db
    .select()
    .from(comprobante)
    .where(and(gt(comprobante.corrigiendoHasta, new Date()), filtroChat(comprobante.chat, chat)))
    .orderBy(desc(comprobante.corrigiendoHasta))
    .limit(1);
  return fila ?? null;
}

export type ResultadoEnvio = { ok: boolean; mensaje: string };

/** Manda el comprobante al ERP (si hay una dirección cargada). */
export async function enviarAlErp(id: number): Promise<ResultadoEnvio> {
  const c = await obtenerComprobante(id);
  if (!c) throw new ErrorUsuario("No existe ese comprobante");
  if (c.fila.origen === "manual") return { ok: false, mensaje: "Las compras sin factura no se mandan al ERP" };
  const cfg = await obtenerConfig();
  if (!cfg.erpUrl) return { ok: false, mensaje: "No hay dirección del ERP cargada" };
  const token = cfg.erpTokenCifrado ? descifrar(cfg.erpTokenCifrado) : null;
  let resultado: ResultadoEnvio;
  try {
    const r = await fetch(cfg.erpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Memolucas-Comprobante": String(id),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ comprobantes: [c.datos] }),
      signal: AbortSignal.timeout(20_000),
    });
    resultado = r.ok ? { ok: true, mensaje: `El ERP respondió ${r.status}` } : { ok: false, mensaje: `El ERP respondió ${r.status} ${(await r.text()).slice(0, 200)}` };
  } catch (err) {
    resultado = { ok: false, mensaje: err instanceof Error ? err.message : String(err) };
  }
  await db
    .update(comprobante)
    .set(resultado.ok ? { enviadoEn: new Date(), envioError: null } : { envioError: resultado.mensaje })
    .where(eq(comprobante.id, id));
  if (!resultado.ok) await registrar("aviso", "compras", `No se pudo mandar el comprobante ${id} al ERP: ${resultado.mensaje}`);
  bus.avisar("compras");
  return resultado;
}

/** Confirma y, si está configurado, lo manda al ERP. envio = null si no se intentó mandar. */
export async function confirmarComprobante(id: number): Promise<{ fila: FilaComprobante; envio: ResultadoEnvio | null } | null> {
  const [fila] = await db
    .update(comprobante)
    .set({ estado: "confirmado", confirmadoEn: new Date(), corrigiendoHasta: null, actualizadoEn: sql`now()` })
    .where(and(eq(comprobante.id, id), inArray(comprobante.estado, ["pendiente", "revisar"])))
    .returning();
  if (!fila) return null;
  bus.avisar("compras");
  const cfg = await obtenerConfig();
  const envio = cfg.erpUrl && cfg.erpEnvioAuto ? await enviarAlErp(id) : null;
  return { fila, envio };
}

export async function descartarComprobante(id: number): Promise<FilaComprobante | null> {
  const [fila] = await db
    .update(comprobante)
    .set({ estado: "descartado", corrigiendoHasta: null, actualizadoEn: sql`now()` })
    .where(and(eq(comprobante.id, id), inArray(comprobante.estado, ["pendiente", "revisar"])))
    .returning();
  if (fila) bus.avisar("compras");
  return fila ?? null;
}

/** Las fotos y PDF se guardan unos días; los datos quedan siempre. */
export async function limpiarArchivosViejos(dias: number): Promise<number> {
  const limite = new Date(Date.now() - dias * 86_400_000);
  const viejos = await db
    .select()
    .from(comprobante)
    .where(and(lt(comprobante.creadoEn, limite), eq(comprobante.archivosBorrados, false)));
  for (const c of viejos) {
    if (c.adjuntoIds.length) {
      const adjs = await db.select().from(adjunto).where(inArray(adjunto.id, c.adjuntoIds));
      for (const a of adjs) await fs.rm(a.rutaArchivo, { force: true });
      await db.delete(adjunto).where(inArray(adjunto.id, c.adjuntoIds));
    }
    await db.update(comprobante).set({ archivosBorrados: true }).where(eq(comprobante.id, c.id));
  }
  return viejos.length;
}
