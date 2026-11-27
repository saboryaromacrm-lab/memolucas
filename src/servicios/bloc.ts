import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { blocImagen, blocPestana, blocVersion } from "../db/schema.js";
import { cifrar, descifrar } from "../lib/cifrado.js";
import { almacenCifrado, comoWebp } from "./archivos-cifrados.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { ErrorUsuario } from "./recordatorios.js";

// El Bloc: pestañas de texto que se guardan solas, como el Bloc de notas de la compu, pero en el panel (compu y
// celular a la vez). Nada se pierde: si dos dispositivos escriben la misma pestaña, lo pisado va al historial.

export const VERSIONES_MAX = 30;
/** Mientras escribís se guarda a cada rato; el historial toma una foto de lo anterior cada tanto. */
const MINUTOS_ENTRE_VERSIONES = 5;
export const DIAS_PAPELERA = 30;
const SIN_TITULO = "Sin título";

export type Resaltado = { desde: number; hasta: number };
export type Pestana = { id: number; titulo: string; texto: string; orden: number; version: number; fijada: boolean; resaltados: Resaltado[]; actualizadoEn: Date };
export type ImagenBloc = { id: number; ancho: number; alto: number };

const leer = (cifrado: string) => descifrar(cifrado) ?? "(no se pudo descifrar)";
const aPestana = (f: typeof blocPestana.$inferSelect): Pestana => ({
  id: f.id,
  titulo: leer(f.tituloCifrado),
  texto: leer(f.textoCifrado),
  orden: f.orden,
  version: f.version,
  fijada: f.fijada,
  resaltados: f.resaltados,
  actualizadoEn: f.actualizadoEn,
});

/** Las pestañas abiertas, en su orden, con sus imágenes. */
export async function listarBloc(): Promise<(Pestana & { imagenes: ImagenBloc[] })[]> {
  const filas = await db.select().from(blocPestana).where(isNull(blocPestana.cerradaEn)).orderBy(asc(blocPestana.orden), asc(blocPestana.id));
  const imagenes = filas.length
    ? await db
        .select()
        .from(blocImagen)
        .where(inArray(blocImagen.pestanaId, filas.map((f) => f.id)))
        .orderBy(asc(blocImagen.id))
    : [];
  return filas.map((f) => ({
    ...aPestana(f),
    imagenes: imagenes.filter((i) => i.pestanaId === f.id).map((i) => ({ id: i.id, ancho: i.ancho, alto: i.alto })),
  }));
}

/** Las cerradas (se borran solas a los 30 días). */
export async function papeleraBloc() {
  const filas = await db.select().from(blocPestana).where(isNotNull(blocPestana.cerradaEn)).orderBy(desc(blocPestana.cerradaEn));
  return filas.map((f) => ({ id: f.id, titulo: leer(f.tituloCifrado), caracteres: leer(f.textoCifrado).length, cerradaEn: f.cerradaEn! }));
}

async function obtener(id: number) {
  const [f] = await db.select().from(blocPestana).where(eq(blocPestana.id, id));
  if (!f) throw new ErrorUsuario("Esa pestaña ya no existe.");
  return f;
}

const alFinal = sql`(select coalesce(max(${blocPestana.orden}), 0) + 1 from ${blocPestana} where ${blocPestana.cerradaEn} is null)`;

export async function crearPestana(d: { titulo?: string; texto?: string } = {}): Promise<Pestana> {
  const [f] = await db
    .insert(blocPestana)
    .values({ tituloCifrado: cifrar(d.titulo?.trim() || SIN_TITULO), textoCifrado: cifrar(d.texto ?? ""), orden: alFinal })
    .returning();
  bus.avisar("bloc");
  return aPestana(f);
}

/** Deja como mucho las últimas 30 versiones de la pestaña. */
async function recortarVersiones(pestanaId: number) {
  const quedan = db.select({ id: blocVersion.id }).from(blocVersion).where(eq(blocVersion.pestanaId, pestanaId)).orderBy(desc(blocVersion.id)).limit(VERSIONES_MAX);
  await db.delete(blocVersion).where(and(eq(blocVersion.pestanaId, pestanaId), notInArray(blocVersion.id, quedan)));
}

/**
 * Guarda lo que se escribió. version: la que tenía la pantalla al empezar a escribir. Si en el medio otro dispositivo
 * guardó (la versión ya no coincide), lo que había va al historial y gana lo nuevo: conflicto = true para avisar.
 */
export async function guardarPestana(id: number, d: { texto?: string; titulo?: string; resaltados?: Resaltado[]; version: number }): Promise<{ version: number; conflicto: boolean }> {
  const r = await db.transaction(async (tx) => {
    const [f] = await tx.select().from(blocPestana).where(eq(blocPestana.id, id)).for("update");
    if (!f) throw new ErrorUsuario("Esa pestaña ya no existe.");
    if (f.cerradaEn) throw new ErrorUsuario("Esa pestaña está en la papelera: restaurala para seguir escribiendo.");
    const conflicto = f.version !== d.version;
    const cambiaTexto = d.texto !== undefined && d.texto !== leer(f.textoCifrado);
    if (conflicto && cambiaTexto) await tx.insert(blocVersion).values({ pestanaId: id, textoCifrado: f.textoCifrado, motivo: "otro_dispositivo", creadoEn: new Date() });
    else if (cambiaTexto) {
      const [ultima] = await tx.select({ creadoEn: blocVersion.creadoEn }).from(blocVersion).where(eq(blocVersion.pestanaId, id)).orderBy(desc(blocVersion.id)).limit(1);
      const hace = ultima ? Date.now() - ultima.creadoEn.getTime() : Infinity;
      if (hace > MINUTOS_ENTRE_VERSIONES * 60_000 && leer(f.textoCifrado)) await tx.insert(blocVersion).values({ pestanaId: id, textoCifrado: f.textoCifrado, motivo: "guardado", creadoEn: new Date() });
    }
    const [n] = await tx
      .update(blocPestana)
      .set({
        ...(d.texto !== undefined ? { textoCifrado: cifrar(d.texto) } : {}),
        ...(d.titulo !== undefined ? { tituloCifrado: cifrar(d.titulo.trim() || SIN_TITULO) } : {}),
        ...(d.resaltados !== undefined ? { resaltados: d.resaltados } : {}),
        version: f.version + 1,
        actualizadoEn: new Date(),
      })
      .where(eq(blocPestana.id, id))
      .returning({ version: blocPestana.version });
    return { version: n.version, conflicto: conflicto && cambiaTexto };
  });
  await recortarVersiones(id);
  bus.avisar("bloc");
  return r;
}

/** El orden nuevo de las pestañas abiertas (arrastrándolas). */
export async function ordenarBloc(ids: number[]) {
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.update(blocPestana).set({ orden: i + 1 }).where(eq(blocPestana.id, id));
  });
  bus.avisar("bloc");
}

/** Fijar en pantalla (o soltarla). No cambia la versión: no es escribir. */
export async function fijarPestana(id: number, fijada: boolean) {
  await obtener(id);
  await db.update(blocPestana).set({ fijada }).where(eq(blocPestana.id, id));
  bus.avisar("bloc");
}

/** Cerrar = a la papelera. */
export async function cerrarPestana(id: number) {
  await obtener(id);
  await db.update(blocPestana).set({ cerradaEn: new Date() }).where(eq(blocPestana.id, id));
  bus.avisar("bloc");
}

export async function restaurarPestana(id: number) {
  await obtener(id);
  await db.update(blocPestana).set({ cerradaEn: null, orden: alFinal }).where(eq(blocPestana.id, id));
  bus.avisar("bloc");
}

export async function borrarPestana(id: number) {
  const borradas = await db.delete(blocPestana).where(and(eq(blocPestana.id, id), isNotNull(blocPestana.cerradaEn))).returning({ id: blocPestana.id });
  if (borradas.length) await borrarArchivosSinImagen();
  bus.avisar("bloc");
}

/** Mantenimiento: lo que lleva más de 30 días en la papelera. */
export async function purgarBloc() {
  const borradas = await db
    .delete(blocPestana)
    .where(lt(blocPestana.cerradaEn, new Date(Date.now() - DIAS_PAPELERA * 86_400_000)))
    .returning({ id: blocPestana.id });
  if (borradas.length) await borrarArchivosSinImagen();
}

export async function versionesPestana(id: number) {
  await obtener(id);
  const filas = await db.select().from(blocVersion).where(eq(blocVersion.pestanaId, id)).orderBy(desc(blocVersion.id));
  return filas.map((v) => {
    const texto = leer(v.textoCifrado);
    return { id: v.id, creadoEn: v.creadoEn, motivo: v.motivo, caracteres: texto.length, texto };
  });
}

/** Vuelve a una versión anterior (lo de ahora queda en el historial, así se puede deshacer). */
export async function restaurarVersion(id: number, versionId: number): Promise<Pestana> {
  const f = await obtener(id);
  const [v] = await db.select().from(blocVersion).where(and(eq(blocVersion.id, versionId), eq(blocVersion.pestanaId, id)));
  if (!v) throw new ErrorUsuario("Esa versión ya no está.");
  await db.insert(blocVersion).values({ pestanaId: id, textoCifrado: f.textoCifrado, motivo: "antes_de_restaurar", creadoEn: new Date() });
  const [n] = await db
    .update(blocPestana)
    // Con otro texto, lo resaltado ya no coincide: se saca.
    .set({ textoCifrado: v.textoCifrado, resaltados: [], version: f.version + 1, actualizadoEn: new Date() })
    .where(eq(blocPestana.id, id))
    .returning();
  await recortarVersiones(id);
  bus.avisar("bloc");
  return aPestana(n);
}

// ───────────── Imágenes ─────────────

export const IMAGENES_MAX = 30;
/** Lo que se acepta al pegar (después se comprime: lado largo hasta 1600 px). */
export const IMAGEN_MAX_BYTES = 15 * 1024 * 1024;
const LADO_MAX = 1600;
/** Las miniaturas se ven de 80 px de alto: se guardan al doble para pantallas nítidas. */
const ALTO_MINI = 160;

const archivos = almacenCifrado("bloc");
/** Cada imagen son dos archivos: la grande y la miniatura. */
const nombreMini = (archivo: string) => `${archivo}-mini`;

/** Pega una imagen en la pestaña: se gira según el celular, se comprime en WebP y se guarda cifrada con su miniatura. */
export async function agregarImagen(pestanaId: number, datos: Buffer): Promise<ImagenBloc> {
  const p = await obtener(pestanaId);
  if (p.cerradaEn) throw new ErrorUsuario("Esa pestaña está en la papelera: restaurala para agregarle imágenes.");
  const [{ n }] = await db.select({ n: count() }).from(blocImagen).where(eq(blocImagen.pestanaId, pestanaId));
  if (n >= IMAGENES_MAX) throw new ErrorUsuario(`Cada pestaña lleva hasta ${IMAGENES_MAX} imágenes: borrá alguna o pegala en otra pestaña.`);
  const [grande, mini] = await Promise.all([comoWebp(datos, { ancho: LADO_MAX, alto: LADO_MAX }), comoWebp(datos, { ancho: ALTO_MINI * 3, alto: ALTO_MINI }, 75)]).catch(() => {
    throw new ErrorUsuario("No pude leer esa imagen: probá con una captura, un JPG o un PNG.");
  });
  const archivo = archivos.nuevoNombre();
  await archivos.guardar(archivo, grande.data);
  await archivos.guardar(nombreMini(archivo), mini.data);
  const [f] = await db
    .insert(blocImagen)
    .values({ pestanaId, archivo, ancho: grande.info.width, alto: grande.info.height, bytes: grande.data.length })
    .returning();
  bus.avisar("bloc");
  return { id: f.id, ancho: f.ancho, alto: f.alto };
}

async function obtenerImagen(id: number) {
  const [f] = await db.select().from(blocImagen).where(eq(blocImagen.id, id));
  if (!f) throw new ErrorUsuario("Esa imagen ya no está.");
  return f;
}

/** La imagen (o su miniatura) en WebP, descifrada. */
export async function leerImagen(id: number, mini: boolean): Promise<Buffer> {
  const f = await obtenerImagen(id);
  const datos = await archivos.leer(mini ? nombreMini(f.archivo) : f.archivo);
  if (!datos) throw new ErrorUsuario("No se pudo abrir esa imagen.");
  return datos;
}

export async function borrarImagen(id: number) {
  const f = await obtenerImagen(id);
  await db.delete(blocImagen).where(eq(blocImagen.id, id));
  await archivos.borrar([f.archivo, nombreMini(f.archivo)]);
  bus.avisar("bloc");
}

/**
 * Después de borrar pestañas (sus imágenes se van de la base en cascada): borra los archivos que quedaron sin imagen.
 */
async function borrarArchivosSinImagen() {
  const usados = new Set((await db.select({ archivo: blocImagen.archivo }).from(blocImagen)).map((i) => i.archivo));
  await archivos.borrar((await archivos.nombres()).filter((n) => !usados.has(n.replace(/-mini$/, ""))));
}

// ───────────── Para el asistente ─────────────

/** La pestaña abierta cuyo título coincide (o contiene lo buscado). */
async function buscarPestana(titulo: string): Promise<Pestana | null> {
  const buscado = normalizar(titulo);
  const todas = await listarBloc();
  return todas.find((p) => normalizar(p.titulo) === buscado) ?? todas.find((p) => normalizar(p.titulo).includes(buscado)) ?? null;
}

/** Sin título: la lista de pestañas (con el tamaño). Con título: el texto de esa pestaña. */
export async function verBloc(titulo?: string) {
  if (!titulo) return (await listarBloc()).map((p) => ({ titulo: p.titulo, caracteres: p.texto.length, actualizado: p.actualizadoEn }));
  const p = await buscarPestana(titulo);
  if (!p) throw new ErrorUsuario(`No hay una pestaña «${titulo}» en el Bloc.`);
  return { titulo: p.titulo, texto: p.texto };
}

/** Suma un texto al final de la pestaña (si no existe, la crea). */
export async function agregarAlBloc(titulo: string, texto: string) {
  const p = await buscarPestana(titulo);
  if (!p) return { titulo: (await crearPestana({ titulo, texto })).titulo, creada: true };
  await guardarPestana(p.id, { texto: p.texto ? `${p.texto.replace(/\s+$/, "")}\n${texto}` : texto, version: p.version });
  return { titulo: p.titulo, creada: false };
}
