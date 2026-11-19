import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../db/index.js";
import { adjunto } from "../db/schema.js";
import { rutas } from "../entorno.js";

const EXTENSIONES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
export const MIMES_IMAGEN = Object.keys(EXTENSIONES);

export async function guardarImagen(datos: Buffer, mime: string) {
  if (!EXTENSIONES[mime]) throw new Error("Formato de imagen no soportado");
  await fs.mkdir(rutas.media, { recursive: true });
  const nombre = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${EXTENSIONES[mime]}`;
  const ruta = path.join(rutas.media, nombre);
  await fs.writeFile(ruta, datos);
  const [fila] = await db.insert(adjunto).values({ rutaArchivo: ruta, mime, tamano: datos.length }).returning();
  return fila;
}

/** Versión liviana para mandarle a la IA (menos tokens). */
export async function imagenParaIa(datos: Buffer): Promise<{ datos: Buffer; mime: string }> {
  try {
    const salida = await sharp(datos).rotate().resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { datos: salida, mime: "image/jpeg" };
  } catch {
    return { datos, mime: "image/jpeg" };
  }
}

export async function obtenerAdjunto(id: number) {
  const [fila] = await db.select().from(adjunto).where(eq(adjunto.id, id));
  return fila ?? null;
}

export async function borrarAdjunto(id: number) {
  const a = await obtenerAdjunto(id);
  if (!a) return;
  await db.delete(adjunto).where(eq(adjunto.id, id));
  await fs.rm(a.rutaArchivo, { force: true });
}
