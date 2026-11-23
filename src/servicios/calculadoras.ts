import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notaCalculadora } from "../db/schema.js";
import { cifrar, descifrar } from "../lib/cifrado.js";

/** La nota de una calculadora (vacía si todavía no se escribió nada). */
export async function obtenerNotaCalculadora(clave: string): Promise<{ texto: string; actualizadoEn: Date | null }> {
  const [n] = await db.select().from(notaCalculadora).where(eq(notaCalculadora.clave, clave));
  return { texto: (n && descifrar(n.textoCifrado)) ?? "", actualizadoEn: n?.actualizadoEn ?? null };
}

export async function guardarNotaCalculadora(clave: string, texto: string): Promise<{ actualizadoEn: Date }> {
  const valores = { textoCifrado: cifrar(texto), actualizadoEn: new Date() };
  const [n] = await db
    .insert(notaCalculadora)
    .values({ clave, ...valores })
    .onConflictDoUpdate({ target: notaCalculadora.clave, set: valores })
    .returning({ actualizadoEn: notaCalculadora.actualizadoEn });
  return n;
}
