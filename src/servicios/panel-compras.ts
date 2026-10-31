import { hash, verify } from "@node-rs/argon2";
import { and, desc, eq, gt, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { lecturaCompras, usuarioCompras, type LecturaCompras, type UsuarioCompras } from "../db/schema.js";
import { ErrorIA } from "../bot/ia.js";
import { bus } from "../lib/eventos.js";
import { registrar } from "../lib/log.js";
import { borrarAdjunto } from "./adjuntos.js";
import { actualizarConfig, obtenerConfig } from "./configuracion.js";
import { leerYGuardar, textoRepetido } from "./lectura-compras.js";
import { ErrorUsuario } from "./recordatorios.js";

const CLAVE = /^\d{4,8}$/;

// ───────────── Personas con acceso ─────────────

export const listarUsuarios = () => db.select().from(usuarioCompras).orderBy(usuarioCompras.nombre);

export async function obtenerUsuario(id: number): Promise<UsuarioCompras | null> {
  const [u] = await db.select().from(usuarioCompras).where(eq(usuarioCompras.id, id));
  return u ?? null;
}

/** Cada persona entra solo con su clave: no puede haber dos iguales. */
async function claveEnUso(clave: string, salvoId?: number) {
  const todos = await db.select().from(usuarioCompras);
  for (const u of todos) if (u.id !== salvoId && (await verify(u.claveHash, clave))) return true;
  return false;
}

async function validarClave(clave: string, salvoId?: number) {
  if (!CLAVE.test(clave)) throw new ErrorUsuario("La clave tiene que tener de 4 a 8 números.");
  if (await claveEnUso(clave, salvoId)) throw new ErrorUsuario("Esa clave ya la usa otra persona: elegí otra.");
}

export async function crearUsuario(nombre: string, clave: string) {
  await validarClave(clave);
  const [u] = await db.insert(usuarioCompras).values({ nombre: nombre.trim(), claveHash: await hash(clave) }).returning();
  await registrar("info", "compras", `Se dio acceso al panel de compras a ${u.nombre}`);
  return u;
}

export async function actualizarUsuario(id: number, c: { nombre?: string; clave?: string; activo?: boolean }) {
  const actual = await obtenerUsuario(id);
  if (!actual) throw new ErrorUsuario("No existe esa persona");
  const cambios: Partial<typeof usuarioCompras.$inferInsert> = {};
  if (c.nombre?.trim()) cambios.nombre = c.nombre.trim();
  if (c.clave) {
    await validarClave(c.clave, id);
    cambios.claveHash = await hash(c.clave);
  }
  if (c.activo !== undefined) cambios.activo = c.activo;
  // Cambiar la clave o desactivarla cierra sus sesiones abiertas.
  const cerrarSesiones = !!c.clave || c.activo === false;
  const [u] = await db
    .update(usuarioCompras)
    .set({ ...cambios, ...(cerrarSesiones ? { version: sql`${usuarioCompras.version} + 1` } : {}) })
    .where(eq(usuarioCompras.id, id))
    .returning();
  return u;
}

export async function borrarUsuario(id: number) {
  await db.delete(usuarioCompras).where(eq(usuarioCompras.id, id));
}

/** Ingreso con la clave personal. Hay un bloqueo general por intentos fallidos (como en el panel). */
export async function ingresar(clave: string, ip: string): Promise<UsuarioCompras> {
  const cfg = await obtenerConfig();
  if (cfg.comprasBloqueadoHasta && cfg.comprasBloqueadoHasta > new Date()) {
    const min = Math.ceil((cfg.comprasBloqueadoHasta.getTime() - Date.now()) / 60_000);
    throw new ErrorUsuario(`Demasiados intentos. Probá de nuevo en ${min} min.`);
  }
  if (CLAVE.test(clave)) {
    for (const u of await db.select().from(usuarioCompras).where(eq(usuarioCompras.activo, true))) {
      if (!(await verify(u.claveHash, clave))) continue;
      await actualizarConfig({ comprasIntentosFallidos: 0, comprasBloqueadoHasta: null });
      await db.update(usuarioCompras).set({ ultimoIngreso: new Date() }).where(eq(usuarioCompras.id, u.id));
      return u;
    }
  }
  const intentos = cfg.comprasIntentosFallidos + 1;
  const bloquear = intentos >= cfg.maxIntentosLogin;
  await actualizarConfig({
    comprasIntentosFallidos: bloquear ? 0 : intentos,
    comprasBloqueadoHasta: bloquear ? new Date(Date.now() + cfg.bloqueoMinutos * 60_000) : null,
  });
  await registrar("aviso", "compras", bloquear ? `Panel de compras bloqueado ${cfg.bloqueoMinutos} min por clave incorrecta` : "Clave incorrecta en el panel de compras", { ip });
  if (bloquear) throw new ErrorUsuario(`Demasiados intentos. Probá de nuevo en ${cfg.bloqueoMinutos} min.`);
  throw new ErrorUsuario(`Clave incorrecta. Te quedan ${cfg.maxIntentosLogin - intentos} intentos.`);
}

// ───────────── Lecturas (lo que se sube desde el celular) ─────────────

const enCurso = new Set<number>();
const pendientes = new Set<Promise<void>>();

/** Crea la lectura y la lee en segundo plano. Si el celular reintenta la misma subida, devuelve la que ya existe. */
export async function crearLectura(d: { clienteId: string; usuario: UsuarioCompras; archivos: { adjuntoId: number; nombre: string }[] }) {
  const [fila] = await db
    .insert(lecturaCompras)
    .values({
      clienteId: d.clienteId,
      usuarioId: d.usuario.id,
      autor: d.usuario.nombre,
      adjuntoIds: d.archivos.map((a) => a.adjuntoId),
      nombres: d.archivos.map((a) => a.nombre),
    })
    .onConflictDoNothing()
    .returning();
  if (!fila) {
    for (const a of d.archivos) await borrarAdjunto(a.adjuntoId);
    const [existente] = await db.select().from(lecturaCompras).where(eq(lecturaCompras.clienteId, d.clienteId));
    return existente;
  }
  bus.avisar("compras");
  leerEnSegundoPlano(fila.id);
  return fila;
}

export async function existeLectura(clienteId: string): Promise<LecturaCompras | null> {
  const [l] = await db.select().from(lecturaCompras).where(eq(lecturaCompras.clienteId, clienteId));
  return l ?? null;
}

function leerEnSegundoPlano(id: number) {
  if (enCurso.has(id)) return;
  enCurso.add(id);
  const p: Promise<void> = procesarLectura(id)
    .catch((err) => void registrar("error", "compras", `Falló la lectura ${id}`, err))
    .finally(() => {
      enCurso.delete(id);
      pendientes.delete(p);
    });
  pendientes.add(p);
}

/** Para pruebas: espera a que terminen las lecturas en curso. */
export const esperarLecturas = () => Promise.all([...pendientes]);

async function terminar(id: number, cambios: Partial<typeof lecturaCompras.$inferInsert>) {
  await db.update(lecturaCompras).set({ ...cambios, actualizadoEn: sql`now()` }).where(eq(lecturaCompras.id, id));
  bus.avisar("compras");
}

async function procesarLectura(id: number) {
  const [l] = await db.select().from(lecturaCompras).where(eq(lecturaCompras.id, id));
  if (!l || l.estado !== "leyendo") return;
  const archivos = l.adjuntoIds.map((adjuntoId, i) => ({ adjuntoId, nombre: l.nombres[i] || `foto-${adjuntoId}.jpg` }));
  let resultados: Awaited<ReturnType<typeof leerYGuardar>>;
  try {
    resultados = await leerYGuardar(archivos, { chat: null, autor: l.autor, origen: "panel" });
  } catch (err) {
    const sinClave = err instanceof ErrorIA && /API key/i.test(err.message);
    return terminar(id, {
      estado: "error",
      mensaje: sinClave ? "Falta la clave de Claude en Memolucas (Configuración → IA)." : "No se pudo leer. Probá de nuevo o sacá una foto más clara, entera y derecha.",
    });
  }
  const nuevos = resultados.flatMap((r) => (r.tipo === "nuevo" ? [r.fila.id] : []));
  const repetidos = resultados.flatMap((r) => (r.tipo === "repetido" ? [`Ya estaba cargado: ${textoRepetido(r)}.`] : []));
  if (!resultados.length) return terminar(id, { estado: "vacia", adjuntoIds: [], mensaje: "No encontré ningún comprobante en las fotos." });
  if (!nuevos.length) return terminar(id, { estado: "repetido", adjuntoIds: [], mensaje: repetidos.join(" ") });
  return terminar(id, { estado: "lista", comprobanteIds: nuevos, mensaje: repetidos.length ? repetidos.join(" ") : null });
}

/** Al arrancar: retoma las lecturas que quedaron a medias por un reinicio. */
export async function retomarLecturas() {
  const filas = await db.select({ id: lecturaCompras.id }).from(lecturaCompras).where(eq(lecturaCompras.estado, "leyendo"));
  for (const f of filas) leerEnSegundoPlano(f.id);
}

export async function reintentarLectura(id: number) {
  const [l] = await db
    .update(lecturaCompras)
    .set({ estado: "leyendo", mensaje: null, actualizadoEn: sql`now()` })
    .where(and(eq(lecturaCompras.id, id), eq(lecturaCompras.estado, "error")))
    .returning();
  if (!l) throw new ErrorUsuario("Esa lectura no se puede reintentar.");
  bus.avisar("compras");
  leerEnSegundoPlano(id);
}

/** Cierra el aviso (error, repetido, sin comprobante). Si era un error, borra las fotos. */
export async function cerrarLectura(id: number) {
  const [l] = await db.select().from(lecturaCompras).where(eq(lecturaCompras.id, id));
  if (!l || l.estado === "leyendo") return;
  if (l.estado === "error") for (const a of l.adjuntoIds) await borrarAdjunto(a);
  await terminar(id, { cerrada: true, ...(l.estado === "error" ? { adjuntoIds: [] } : {}) });
}

/** Lo que se muestra arriba de la lista: lo que se está leyendo y los avisos sin cerrar de la última semana. */
export async function lecturasAbiertas() {
  const semana = new Date(Date.now() - 7 * 86_400_000);
  return db
    .select()
    .from(lecturaCompras)
    .where(
      and(
        eq(lecturaCompras.cerrada, false),
        gt(lecturaCompras.creadoEn, semana),
        or(ne(lecturaCompras.estado, "lista"), sql`${lecturaCompras.mensaje} is not null`),
      ),
    )
    .orderBy(desc(lecturaCompras.id));
}

/** El colaborador solo puede ver archivos de comprobantes o lecturas, nunca otros (fotos personales, etc.). */
export async function adjuntoDeCompras(adjuntoId: number): Promise<boolean> {
  const r = await db.execute(
    sql`select 1 from comprobante where ${adjuntoId} = any(adjunto_ids) union all select 1 from lectura_compras where ${adjuntoId} = any(adjunto_ids) limit 1`,
  );
  return r.rows.length > 0;
}
