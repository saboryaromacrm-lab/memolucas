import { and, asc, count, eq, max } from "drizzle-orm";
import { db } from "../db/index.js";
import { pagoFijo, pagoForma, pagoMes, pagoPersona, tarjeta, type TipoFormaPago } from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { ErrorUsuario } from "./recordatorios.js";

// Las formas de pago de Pagos: las que cargás y, solas, las tarjetas de la sección Tarjetas y «Lo pagó: …» de cada
// persona que paga cosas por vos (Cuentas).

/** Los tipos que se eligen al cargar una forma (las «Lo pagó: …» se crean solas con cada persona). */
export const TIPOS_FORMA = ["transferencia", "efectivo", "debito_automatico", "billetera", "credito", "debito", "otro"] as const satisfies readonly TipoFormaPago[];

export type FormaPago = typeof pagoForma.$inferSelect;

const avisar = () => bus.avisar("pagos");
const nombreDeTarjeta = (t: { nombre: string; ultimos4: string }) => `${t.nombre}${t.ultimos4 ? ` ···${t.ultimos4}` : ""}`;
export const nombreDePersona = (nombre: string) => `Lo pagó: ${nombre}`;

/**
 * Las que se crean solas y siguen el nombre de lo suyo: una por tarjeta (si la archivaste, no vuelve) y una por persona
 * de Cuentas.
 */
async function sincronizarAutomaticas() {
  const [tarjetas, personas, formas] = await Promise.all([db.select().from(tarjeta), db.select().from(pagoPersona), db.select().from(pagoForma)]);
  let orden = Math.max(0, ...formas.map((f) => f.orden));
  const asegurar = async (actual: FormaPago | undefined, nombre: string, nueva: Omit<typeof pagoForma.$inferInsert, "nombre" | "orden">) => {
    if (!actual) await db.insert(pagoForma).values({ ...nueva, nombre, orden: ++orden }).onConflictDoNothing();
    else if (actual.nombre !== nombre) await db.update(pagoForma).set({ nombre }).where(eq(pagoForma.id, actual.id));
  };
  for (const t of tarjetas) await asegurar(formas.find((x) => x.tarjetaId === t.id), nombreDeTarjeta(t), { tipo: "credito", tarjetaId: t.id });
  for (const p of personas) await asegurar(formas.find((x) => x.personaId === p.id), nombreDePersona(p.nombre), { tipo: "tercero", personaId: p.id });
}

/** Todas, en orden (también las archivadas: el historial las nombra). */
export async function listarFormas(): Promise<FormaPago[]> {
  await sincronizarAutomaticas();
  return db.select().from(pagoForma).orderBy(asc(pagoForma.orden), asc(pagoForma.id));
}

const nombreValido = (nombre: string) => {
  const n = nombre.trim();
  if (!n) throw new ErrorUsuario("Falta el nombre de la forma de pago.");
  return n;
};

async function nombreLibre(nombre: string, menos?: number) {
  const igual = (await db.select().from(pagoForma).where(eq(pagoForma.archivada, false))).find((f) => f.id !== menos && normalizar(f.nombre) === normalizar(nombre));
  if (igual) throw new ErrorUsuario(`Ya tenés «${igual.nombre}».`);
}

export async function crearForma(d: { nombre: string; tipo: TipoFormaPago }) {
  const nombre = nombreValido(d.nombre);
  await nombreLibre(nombre);
  const [{ ultimo }] = await db.select({ ultimo: max(pagoForma.orden) }).from(pagoForma);
  const [f] = await db
    .insert(pagoForma)
    .values({ nombre, tipo: d.tipo, orden: (ultimo ?? 0) + 1 })
    .returning();
  avisar();
  return f;
}

/** La de una tarjeta se llama como la tarjeta: el nombre se cambia en Tarjetas. */
export async function actualizarForma(id: number, d: { nombre?: string; tipo?: TipoFormaPago }) {
  const [f] = await db.select().from(pagoForma).where(eq(pagoForma.id, id));
  if (!f || f.archivada) throw new ErrorUsuario("Esa forma de pago ya no está.");
  if (d.nombre !== undefined && f.tarjetaId && d.nombre.trim() !== f.nombre) throw new ErrorUsuario("El nombre de una tarjeta se cambia en Tarjetas.");
  if (f.personaId) throw new ErrorUsuario("Esta forma es de una persona: se cambia en Pagos → Cuentas.");
  const nombre = d.nombre === undefined ? undefined : nombreValido(d.nombre);
  if (nombre) await nombreLibre(nombre, id);
  await db
    .update(pagoForma)
    .set({ ...(nombre ? { nombre } : {}), ...(d.tipo ? { tipo: d.tipo } : {}) })
    .where(eq(pagoForma.id, id));
  avisar();
}

/** El orden en que aparecen (los ids en el orden nuevo). */
export async function ordenarFormas(ids: number[]) {
  await db.transaction(async (tx) => {
    for (const [k, id] of ids.entries()) await tx.update(pagoForma).set({ orden: k + 1 }).where(eq(pagoForma.id, id));
  });
  avisar();
}

/**
 * Deja de aparecer en la lista. Si ya se usó en algún pago (o es de una tarjeta, que si no volvería sola), se archiva
 * para que el historial la siga mostrando; si no, se borra. Los fijos que la tenían quedan sin forma fija.
 */
export async function borrarForma(id: number) {
  const [f] = await db.select().from(pagoForma).where(eq(pagoForma.id, id));
  if (!f) return;
  if (f.personaId) throw new ErrorUsuario("Esta forma es de una persona: se saca borrando la persona en Pagos → Cuentas.");
  await db.update(pagoFijo).set({ formaId: null }).where(eq(pagoFijo.formaId, id));
  // Los pendientes que la tenían marcada dejan de sugerirla.
  await db
    .update(pagoMes)
    .set({ formaId: null })
    .where(and(eq(pagoMes.formaId, id), eq(pagoMes.estado, "pendiente")));
  const [{ usos }] = await db.select({ usos: count() }).from(pagoMes).where(eq(pagoMes.formaId, id));
  if (usos || f.tarjetaId) await db.update(pagoForma).set({ archivada: true }).where(eq(pagoForma.id, id));
  else await db.delete(pagoForma).where(eq(pagoForma.id, id));
  avisar();
}

/** Una forma que se puede usar (existe y no está archivada). */
export async function formaActiva(id: number) {
  const [f] = await db
    .select()
    .from(pagoForma)
    .where(and(eq(pagoForma.id, id), eq(pagoForma.archivada, false)));
  if (!f) throw new ErrorUsuario("Esa forma de pago ya no está: elegí otra.");
  return f;
}

/** Las que se pueden elegir, en orden. */
export async function formasActivas() {
  return (await listarFormas()).filter((f) => !f.archivada);
}

/** La forma que nombró ("con transferencia", "la visa", "en efectivo"): igual, contenida en el nombre o al revés, o una palabra. */
export function elegirForma<F extends { nombre: string }>(formas: F[], texto: string): F | undefined {
  const t = normalizar(texto);
  if (!t) return undefined;
  return (
    formas.find((f) => normalizar(f.nombre) === t) ??
    formas.find((f) => normalizar(f.nombre).includes(t)) ??
    formas.find((f) => t.includes(normalizar(f.nombre))) ??
    formas.find((f) => t.split(/\s+/).some((p) => p.length > 3 && normalizar(f.nombre).split(/\s+/).includes(p)))
  );
}

export const buscarForma = async (texto: string) => elegirForma(await formasActivas(), texto);

/** La forma de la tarjeta con que se paga una suscripción (si la tarjeta tiene su forma activa). */
export async function formaDeTarjeta(tarjetaId: number) {
  const [f] = await db
    .select({ id: pagoForma.id })
    .from(pagoForma)
    .where(and(eq(pagoForma.tarjetaId, tarjetaId), eq(pagoForma.archivada, false)));
  return f?.id ?? null;
}

/** Al borrar una tarjeta, su forma queda archivada (el historial la sigue nombrando). */
export async function archivarFormaDeTarjeta(tarjetaId: number) {
  await db.update(pagoForma).set({ archivada: true }).where(eq(pagoForma.tarjetaId, tarjetaId));
}
