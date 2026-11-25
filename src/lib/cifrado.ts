import crypto from "node:crypto";
import { entorno } from "../entorno.js";

const clave = () => crypto.createHash("sha256").update(`memolucas:${entorno.appSecret}`).digest();

export function cifrar(texto: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", clave(), iv);
  const datos = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), datos].map((b) => b.toString("base64")).join(".");
}

export function descifrar(cifrado: string): string | null {
  try {
    const [iv, tag, datos] = cifrado.split(".").map((p) => Buffer.from(p, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", clave(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(datos), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Un archivo cifrado (ej. una imagen del Bloc): iv (12) + etiqueta (16) + datos. */
export function cifrarArchivo(datos: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", clave(), iv);
  const cuerpo = Buffer.concat([c.update(datos), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), cuerpo]);
}

export function descifrarArchivo(cifrado: Buffer): Buffer | null {
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", clave(), cifrado.subarray(0, 12));
    d.setAuthTag(cifrado.subarray(12, 28));
    return Buffer.concat([d.update(cifrado.subarray(28)), d.final()]);
  } catch {
    return null;
  }
}

/** Un objeto cifrado como JSON (una fila con varios datos privados). */
export const sellar = (datos: object) => cifrar(JSON.stringify(datos));
/** Lo cifrado con sellar; si no se puede descifrar (¿cambió el APP_SECRET?), "vacio". */
export function abrir<T>(cifrado: string, vacio: T): T {
  const texto = descifrar(cifrado);
  return texto ? (JSON.parse(texto) as T) : vacio;
}
