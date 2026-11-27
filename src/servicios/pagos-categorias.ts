import { asc, count, eq, max } from "drizzle-orm";
import { db } from "../db/index.js";
import { pagoCategoria, pagoFijo, pagoMes } from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { ErrorUsuario } from "./recordatorios.js";

// Las categorías de Pagos (Alquiler, Servicios, Impuestos…): las editás en Configuración. Los pagos guardan el nombre,
// así que renombrar o pasar a otra cambia también los pagos (los de todos los meses, también los viejos).

const avisar = () => bus.avisar("pagos");

/** En tu orden, con cuántos pagos (fijos y de cada mes) la usan. */
export async function listarCategorias() {
  const [categorias, fijos, meses] = await Promise.all([
    db.select().from(pagoCategoria).orderBy(asc(pagoCategoria.orden), asc(pagoCategoria.id)),
    db.select({ categoria: pagoFijo.categoria, n: count() }).from(pagoFijo).groupBy(pagoFijo.categoria),
    db.select({ categoria: pagoMes.categoria, n: count() }).from(pagoMes).groupBy(pagoMes.categoria),
  ]);
  const usos = (nombre: string) => [...fijos, ...meses].filter((u) => u.categoria === nombre).reduce((s, u) => s + u.n, 0);
  return categorias.map((c) => ({ id: c.id, nombre: c.nombre, orden: c.orden, fijos: fijos.find((u) => u.categoria === c.nombre)?.n ?? 0, usos: usos(c.nombre) }));
}

/** Los nombres, en orden (para la IA y los formularios). */
export const nombresDeCategorias = async () => (await listarCategorias()).map((c) => c.nombre);

const nombreValido = (nombre: string) => {
  const n = nombre.trim();
  if (!n) throw new ErrorUsuario("Falta el nombre de la categoría.");
  return n;
};

async function existente(nombre: string) {
  return (await db.select().from(pagoCategoria)).find((c) => normalizar(c.nombre) === normalizar(nombre));
}

export async function crearCategoria(nombre: string) {
  const n = nombreValido(nombre);
  const igual = await existente(n);
  if (igual) throw new ErrorUsuario(`Ya tenés la categoría «${igual.nombre}».`);
  const [{ ultimo }] = await db.select({ ultimo: max(pagoCategoria.orden) }).from(pagoCategoria);
  const [c] = await db
    .insert(pagoCategoria)
    .values({ nombre: n, orden: (ultimo ?? 0) + 1 })
    .returning();
  avisar();
  return c;
}

/**
 * La categoría con que se guarda un pago: la de tu lista con ese nombre (sin importar mayúsculas ni tildes) o, si no
 * está, se suma a la lista. Así la lista siempre tiene todas las que usás.
 */
export async function asegurarCategoria(nombre: string) {
  const n = nombre.trim() || "Otros";
  return (await existente(n))?.nombre ?? (await crearCategoria(n)).nombre;
}

/** Renombrar cambia el nombre en todos los pagos que la usan. */
export async function renombrarCategoria(id: number, nombre: string) {
  const n = nombreValido(nombre);
  const [c] = await db.select().from(pagoCategoria).where(eq(pagoCategoria.id, id));
  if (!c) throw new ErrorUsuario("Esa categoría ya no está.");
  const igual = await existente(n);
  if (igual && igual.id !== id) throw new ErrorUsuario(`Ya tenés la categoría «${igual.nombre}»: borrá esta y pasá sus pagos a esa.`);
  await db.transaction(async (tx) => {
    await tx.update(pagoCategoria).set({ nombre: n }).where(eq(pagoCategoria.id, id));
    await tx.update(pagoFijo).set({ categoria: n }).where(eq(pagoFijo.categoria, c.nombre));
    await tx.update(pagoMes).set({ categoria: n }).where(eq(pagoMes.categoria, c.nombre));
  });
  avisar();
}

export async function ordenarCategorias(ids: number[]) {
  await db.transaction(async (tx) => {
    for (const [k, id] of ids.entries()) await tx.update(pagoCategoria).set({ orden: k + 1 }).where(eq(pagoCategoria.id, id));
  });
  avisar();
}

/** Borrar: si tiene pagos, hay que decir a cuál categoría pasan. */
export async function borrarCategoria(id: number, pasarA?: number) {
  const categorias = await db.select().from(pagoCategoria);
  const c = categorias.find((x) => x.id === id);
  if (!c) return;
  const usos = (await listarCategorias()).find((x) => x.id === id)?.usos ?? 0;
  const destino = categorias.find((x) => x.id === pasarA && x.id !== id);
  if (usos && !destino) throw new ErrorUsuario(`«${c.nombre}» tiene pagos: elegí a qué categoría pasarlos.`);
  await db.transaction(async (tx) => {
    if (destino) {
      await tx.update(pagoFijo).set({ categoria: destino.nombre }).where(eq(pagoFijo.categoria, c.nombre));
      await tx.update(pagoMes).set({ categoria: destino.nombre }).where(eq(pagoMes.categoria, c.nombre));
    }
    await tx.delete(pagoCategoria).where(eq(pagoCategoria.id, id));
  });
  avisar();
}
