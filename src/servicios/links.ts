import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { linkGuardado } from "../db/schema.js";
import { cifrar, descifrar } from "../lib/cifrado.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { ErrorUsuario } from "./recordatorios.js";

export type Link = { id: number; concepto: string; url: string };

/** "home.banco.com" → "https://home.banco.com". Solo direcciones web. */
export function urlValida(texto: string): string {
  const t = texto.trim();
  try {
    const u = new URL(/^[a-z][a-z\d+.-]*:/i.test(t) ? t : `https://${t}`);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".")) return u.href;
  } catch {
    // Cae al error de abajo.
  }
  throw new ErrorUsuario("Esa dirección no parece un link (ej. https://www.ejemplo.com).");
}

const datos = (d: Omit<Link, "id">) => ({ datosCifrados: cifrar(JSON.stringify({ concepto: d.concepto.trim(), url: urlValida(d.url) })) });

/** En el orden elegido. */
export async function listarLinks(): Promise<Link[]> {
  const filas = await db.select().from(linkGuardado).orderBy(asc(linkGuardado.orden), asc(linkGuardado.id));
  return filas.map((f) => {
    const d = JSON.parse(descifrar(f.datosCifrados) ?? '{"concepto":"(no se pudo descifrar)","url":""}') as Omit<Link, "id">;
    return { id: f.id, ...d };
  });
}

/** Los nuevos van al final. */
export async function crearLink(d: Omit<Link, "id">): Promise<{ id: number }> {
  const [l] = await db
    .insert(linkGuardado)
    .values({ ...datos(d), orden: sql`(select coalesce(max(${linkGuardado.orden}), 0) + 1 from ${linkGuardado})` })
    .returning({ id: linkGuardado.id });
  bus.avisar("links");
  return l;
}

export async function actualizarLink(id: number, d: Omit<Link, "id">) {
  const filas = await db
    .update(linkGuardado)
    .set({ ...datos(d), actualizadoEn: new Date() })
    .where(eq(linkGuardado.id, id))
    .returning({ id: linkGuardado.id });
  if (!filas.length) throw new ErrorUsuario("Ese link ya no existe.");
  bus.avisar("links");
}

export async function borrarLink(id: number) {
  await db.delete(linkGuardado).where(eq(linkGuardado.id, id));
  bus.avisar("links");
}

/** Sube (-1) o baja (1) un lugar; de paso deja el orden numerado 1, 2, 3… */
export async function moverLink(id: number, paso: -1 | 1) {
  const lista = await db.select({ id: linkGuardado.id, orden: linkGuardado.orden }).from(linkGuardado).orderBy(asc(linkGuardado.orden), asc(linkGuardado.id));
  const i = lista.findIndex((l) => l.id === id);
  const j = i + paso;
  if (i < 0 || j < 0 || j >= lista.length) return;
  [lista[i], lista[j]] = [lista[j], lista[i]];
  await db.transaction(async (tx) => {
    for (const [n, l] of lista.entries()) if (l.orden !== n + 1) await tx.update(linkGuardado).set({ orden: n + 1 }).where(eq(linkGuardado.id, l.id));
  });
  bus.avisar("links");
}

/** Palabras de la pregunta que no ayudan a encontrar el link ("¿cuál era el link del home banking?" → home, banking). */
const VACIAS = new Set(["cual", "era", "es", "el", "la", "los", "las", "de", "del", "un", "una", "link", "links", "url", "pagina", "mi", "mis", "me", "pasame", "mandame", "dame", "tenes", "buscame", "que", "por", "favor", "para", "y", "en"]);

/** Los links que mejor coinciden con lo pedido (por concepto o dirección); vacío si no hay ninguno. */
export async function buscarLinks(consulta: string): Promise<Link[]> {
  const palabras = normalizar(consulta)
    .split(" ")
    .filter((p) => p.length > 1 && !VACIAS.has(p));
  if (!palabras.length) return [];
  const puntaje = (l: Link) => palabras.filter((p) => normalizar(`${l.concepto} ${l.url}`).includes(p)).length;
  const con = (await listarLinks()).map((l) => ({ l, p: puntaje(l) })).filter((x) => x.p > 0);
  const mejor = Math.max(0, ...con.map((x) => x.p));
  return con.filter((x) => x.p === mejor).map((x) => x.l);
}
