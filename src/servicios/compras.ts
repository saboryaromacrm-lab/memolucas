import fs from "node:fs/promises";
import { and, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { adjunto, comprobante, encuesta, grupo, type FilaComprobante } from "../db/schema.js";
import { cifrar, descifrar } from "../lib/cifrado.js";
import { claveDe, controlar, EsquemaComprobante, type Comprobante } from "../lib/comprobantes.js";
import { bus } from "../lib/eventos.js";
import { registrar } from "../lib/log.js";
import { obtenerConfig } from "./configuracion.js";
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

const columnas = (datos: Comprobante, cierra: boolean) => ({
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
  datos: Comprobante;
  cierra: boolean;
  modelo: string | null;
  adjuntoIds: number[];
}): Promise<FilaComprobante> {
  const [fila] = await db
    .insert(comprobante)
    .values({
      chat: d.chat,
      autor: d.autor,
      estado: d.cierra ? "pendiente" : "revisar",
      modelo: d.modelo,
      adjuntoIds: d.adjuntoIds,
      ...columnas(d.datos, d.cierra),
    })
    .returning();
  bus.avisar("compras");
  return fila;
}

export async function obtenerComprobante(id: number): Promise<ComprobanteGuardado | null> {
  const [fila] = await db.select().from(comprobante).where(eq(comprobante.id, id));
  return fila ? { fila, datos: leerDatos(fila) } : null;
}

export async function listarComprobantes(f: { estado?: string; desde?: Date; hasta?: Date } = {}): Promise<ComprobanteGuardado[]> {
  const filas = await db
    .select()
    .from(comprobante)
    .where(
      and(
        f.estado ? eq(comprobante.estado, f.estado as FilaComprobante["estado"]) : ne(comprobante.estado, "descartado"),
        f.desde ? gt(comprobante.creadoEn, f.desde) : undefined,
        f.hasta ? lt(comprobante.creadoEn, f.hasta) : undefined,
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
  const [fila] = await db
    .update(comprobante)
    .set({ ...columnas(datos, cierra), estado: cierra ? "pendiente" : "revisar", corrigiendoHasta: null, actualizadoEn: sql`now()` })
    .where(eq(comprobante.id, id))
    .returning();
  bus.avisar("compras");
  return { fila, datos };
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
