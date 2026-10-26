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
