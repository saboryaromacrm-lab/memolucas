import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { rutas } from "../entorno.js";
import { cifrarArchivo, descifrarArchivo } from "../lib/cifrado.js";

// Archivos privados (imágenes del Bloc, comprobantes de Pagos): cifrados en MEDIA/<carpeta> como <nombre>.bin. Nunca
// se sirven directo: pasan por una ruta con sesión que los descifra.

export function almacenCifrado(carpeta: string) {
  const dir = () => path.join(rutas.media, carpeta);
  const ruta = (nombre: string) => path.join(dir(), `${nombre}.bin`);
  return {
    nuevoNombre: () => `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`,
    async guardar(nombre: string, datos: Buffer) {
      await fs.mkdir(dir(), { recursive: true });
      await fs.writeFile(ruta(nombre), cifrarArchivo(datos));
    },
    /** null si no está o no se puede descifrar. */
    async leer(nombre: string): Promise<Buffer | null> {
      return descifrarArchivo(await fs.readFile(ruta(nombre)).catch(() => Buffer.alloc(0)));
    },
    async borrar(nombres: string[]) {
      for (const n of nombres) await fs.rm(ruta(n), { force: true });
    },
    /** Los nombres guardados (para borrar los que quedaron sin fila). */
    async nombres(): Promise<string[]> {
      return (await fs.readdir(dir()).catch(() => [] as string[])).filter((n) => n.endsWith(".bin")).map((n) => n.slice(0, -4));
    },
  };
}

/** Una imagen girada según el celular y achicada (sin agrandar) a la caja, en WebP. Error si no es una imagen. */
export function comoWebp(datos: Buffer, caja: { ancho: number; alto: number }, calidad = 82) {
  return sharp(datos).rotate().resize({ width: caja.ancho, height: caja.alto, fit: "inside", withoutEnlargement: true }).webp({ quality: calidad }).toBuffer({ resolveWithObject: true });
}
