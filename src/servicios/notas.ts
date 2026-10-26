import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { nota, type Nota } from "../db/schema.js";
import { cifrar, descifrar } from "../lib/cifrado.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { borrarAdjunto } from "./adjuntos.js";
import { ErrorUsuario } from "./recordatorios.js";

export const CATEGORIAS = ["claves", "casa", "auto", "trabajo", "salud", "compras", "contactos", "ideas", "documentos", "otros"];

export type NotaClara = {
  id: number;
  titulo: string;
  contenido: string;
  categoria: string;
  adjuntoId: number | null;
  adjuntoUrl: string | null;
  creadoEn: Date;
  actualizadoEn: Date;
};

const ILEGIBLE = "(no se pudo descifrar: ¿cambió el APP_SECRET?)";

function aClara(n: Nota): NotaClara {
  return {
    id: n.id,
    titulo: descifrar(n.tituloCifrado) ?? ILEGIBLE,
    contenido: descifrar(n.contenidoCifrado) ?? ILEGIBLE,
    categoria: n.categoria,
    adjuntoId: n.adjuntoId,
    adjuntoUrl: n.adjuntoId ? `/api/adjuntos/${n.adjuntoId}` : null,
    creadoEn: n.creadoEn,
    actualizadoEn: n.actualizadoEn,
  };
}

const categoriaValida = (c: string | null | undefined) => {
  const n = normalizar(c ?? "");
  return CATEGORIAS.includes(n) ? n : n.replace(/[^a-z0-9 ]/g, "").slice(0, 30) || "otros";
};

export type DatosNota = { titulo: string; contenido: string; categoria?: string | null; adjuntoId?: number | null };

export async function crearNota(d: DatosNota): Promise<NotaClara> {
  const titulo = d.titulo.trim();
  const contenido = d.contenido.trim();
  if (!titulo && !contenido) throw new ErrorUsuario("La nota está vacía.");
  const [n] = await db
    .insert(nota)
    .values({
      tituloCifrado: cifrar(titulo || contenido.slice(0, 60)),
      contenidoCifrado: cifrar(contenido),
      categoria: categoriaValida(d.categoria),
      adjuntoId: d.adjuntoId ?? null,
    })
    .returning();
  bus.avisar("notas");
  return aClara(n);
}

export async function obtenerNota(id: number): Promise<NotaClara | null> {
  const [n] = await db.select().from(nota).where(eq(nota.id, id));
  return n ? aClara(n) : null;
}

export async function actualizarNota(id: number, c: Partial<DatosNota>): Promise<NotaClara> {
  const actual = await obtenerNota(id);
  if (!actual) throw new ErrorUsuario("No encontré esa nota.");
  const [n] = await db
    .update(nota)
    .set({
      tituloCifrado: cifrar((c.titulo ?? actual.titulo).trim()),
      contenidoCifrado: cifrar((c.contenido ?? actual.contenido).trim()),
      categoria: c.categoria !== undefined ? categoriaValida(c.categoria) : actual.categoria,
      adjuntoId: c.adjuntoId !== undefined ? c.adjuntoId : actual.adjuntoId,
      actualizadoEn: sql`now()`,
    })
    .where(eq(nota.id, id))
    .returning();
  bus.avisar("notas");
  return aClara(n);
}

export async function borrarNota(id: number) {
  const [n] = await db.delete(nota).where(eq(nota.id, id)).returning();
  if (n?.adjuntoId) await borrarAdjunto(n.adjuntoId).catch(() => {});
  bus.avisar("notas");
}

export async function todasLasNotas(): Promise<NotaClara[]> {
  return (await db.select().from(nota).orderBy(desc(nota.actualizadoEn))).map(aClara);
}

const palabras = (s: string) => normalizar(s).split(/[^a-z0-9ñ]+/).filter((p) => p.length > 2);

/** Las notas más relacionadas con una consulta (para no mandarle todas a la IA). */
export function relacionadas(notas: NotaClara[], consulta: string, max = 40): NotaClara[] {
  if (notas.length <= max) return notas;
  const buscadas = new Set(palabras(consulta));
  return notas
    .map((n) => ({ n, puntos: palabras(`${n.titulo} ${n.contenido} ${n.categoria}`).filter((p) => buscadas.has(p)).length }))
    .sort((a, b) => b.puntos - a.puntos)
    .slice(0, max)
    .map((x) => x.n);
}
