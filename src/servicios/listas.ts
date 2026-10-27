import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { lista, listaItem, type Lista, type ListaItem } from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { ErrorUsuario, filtroChat, type Ambito } from "./recordatorios.js";

export type ListaConItems = Lista & { items: ListaItem[] };
export type ItemNuevo = { texto: string; cantidad?: string | null };

export const claveLista = (nombre: string) => normalizar(nombre).replace(/^(la |el |mi )?(lista (de |del )?)?/, "").trim();

const capitalizar = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function todasLasListas(ambito?: Ambito): Promise<ListaConItems[]> {
  const ls = await db.select().from(lista).where(filtroChat(lista.chat, ambito)).orderBy(asc(lista.nombre));
  if (!ls.length) return [];
  const items = await db
    .select()
    .from(listaItem)
    .where(inArray(listaItem.listaId, ls.map((l) => l.id)))
    .orderBy(asc(listaItem.id));
  return ls.map((l) => ({ ...l, items: items.filter((i) => i.listaId === l.id) }));
}

export async function obtenerLista(id: number): Promise<ListaConItems | null> {
  const [l] = await db.select().from(lista).where(eq(lista.id, id));
  if (!l) return null;
  const items = await db.select().from(listaItem).where(eq(listaItem.listaId, id)).orderBy(asc(listaItem.id));
  return { ...l, items };
}

/** Busca por nombre: exacto, o una que contenga el nombre ("súper" encuentra "Súper chino"). */
export async function buscarLista(nombre: string, ambito: Ambito = null): Promise<Lista | null> {
  const clave = claveLista(nombre);
  if (!clave) return null;
  const ls = await db.select().from(lista).where(filtroChat(lista.chat, ambito));
  return ls.find((l) => l.clave === clave) ?? ls.find((l) => l.clave.includes(clave) || clave.includes(l.clave)) ?? null;
}

export async function obtenerOCrearLista(nombre: string, chat: string | null = null): Promise<Lista> {
  const existente = await buscarLista(nombre, chat);
  if (existente) return existente;
  const limpio = nombre.trim().replace(/^(la |el |mi )?(lista (de |del )?)?/i, "").trim() || "Pendientes";
  const [l] = await db
    .insert(lista)
    .values({ nombre: capitalizar(limpio), clave: claveLista(limpio), chat })
    .returning();
  bus.avisar("listas");
  return l;
}

/** Agrega ítems; si ya estaba, actualiza la cantidad. */
export async function agregarItems(listaId: number, items: ItemNuevo[]) {
  const actuales = await db.select().from(listaItem).where(eq(listaItem.listaId, listaId));
  const agregados: ListaItem[] = [];
  for (const it of items) {
    const texto = it.texto.trim();
    if (!texto) continue;
    const cantidad = it.cantidad?.trim() || null;
    const igual = actuales.find((a) => normalizar(a.texto) === normalizar(texto));
    if (igual) {
      if (cantidad && cantidad !== igual.cantidad) await db.update(listaItem).set({ cantidad }).where(eq(listaItem.id, igual.id));
      continue;
    }
    const [nuevo] = await db.insert(listaItem).values({ listaId, texto, cantidad }).returning();
    actuales.push(nuevo);
    agregados.push(nuevo);
  }
  await db.update(lista).set({ actualizadoEn: sql`now()` }).where(eq(lista.id, listaId));
  bus.avisar("listas");
  return agregados;
}

export async function quitarItems(ids: number[]): Promise<ListaItem[]> {
  if (!ids.length) return [];
  const borrados = await db.delete(listaItem).where(inArray(listaItem.id, ids)).returning();
  bus.avisar("listas");
  return borrados;
}

export async function vaciarLista(id: number) {
  await db.delete(listaItem).where(eq(listaItem.listaId, id));
  bus.avisar("listas");
}

export async function borrarLista(id: number) {
  await db.delete(lista).where(eq(lista.id, id));
  bus.avisar("listas");
}

export async function renombrarLista(id: number, nombre: string) {
  const limpio = nombre.trim();
  if (!limpio) throw new ErrorUsuario("Poné un nombre.");
  const clave = claveLista(limpio);
  const [actual] = await db.select().from(lista).where(eq(lista.id, id));
  const [otra] = await db
    .select()
    .from(lista)
    .where(and(eq(lista.clave, clave), filtroChat(lista.chat, actual?.chat ?? null)));
  if (otra && otra.id !== id) throw new ErrorUsuario("Ya hay una lista con ese nombre.");
  await db.update(lista).set({ nombre: capitalizar(limpio), clave, actualizadoEn: sql`now()` }).where(eq(lista.id, id));
  bus.avisar("listas");
}

export const lineaItem = (i: Pick<ListaItem, "texto" | "cantidad">) => `• ${i.texto}${i.cantidad ? ` (${i.cantidad})` : ""}`;

export function textoLista(l: ListaConItems): string {
  if (!l.items.length) return `📝 *${l.nombre}*: vacía 🙌`;
  return `📝 *${l.nombre}* (${l.items.length}):\n${l.items.map(lineaItem).join("\n")}`;
}
