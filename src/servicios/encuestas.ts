import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { encuesta, type AccionEncuesta, type Configuracion } from "../db/schema.js";

/** Opciones de un aviso: hecho o posponer. */
export const opcionesAviso = (cfg: Configuracion) => ["✅ Hecho", "⏰ En 15 min", "⏰ En 1 h", `📅 Mañana a las ${cfg.horaDefecto}`];
export const OPCIONES_PROPUESTA = ["✅ Dale", "✏️ Otra fecha", "❌ No"];
export const OPCIONES_COMPROBANTE = ["✅ Confirmar", "✏️ Corregir", "❌ Descartar"];

export async function registrarEncuesta(e: { waMessageId: string; chat: string | null; secreto: string; opciones: string[]; accion: AccionEncuesta }) {
  const [fila] = await db.insert(encuesta).values(e).onConflictDoNothing().returning();
  return fila ?? null;
}

export async function encuestaPorWaId(waMessageId: string) {
  const [fila] = await db.select().from(encuesta).where(eq(encuesta.waMessageId, waMessageId));
  return fila ?? null;
}

/** Marca la encuesta como respondida. Devuelve false si ya lo estaba (se toma solo el primer voto). */
export async function marcarRespondida(id: number): Promise<boolean> {
  const filas = await db
    .update(encuesta)
    .set({ respondidaEn: new Date() })
    .where(and(eq(encuesta.id, id), isNull(encuesta.respondidaEn)))
    .returning({ id: encuesta.id });
  return filas.length > 0;
}

/** WhatsApp manda cada opción votada como el SHA-256 de su texto. */
export const hashOpcion = (texto: string) => crypto.createHash("sha256").update(texto).digest();

export function opcionElegida(opciones: string[], seleccionadas: Uint8Array[]): number {
  const votos = seleccionadas.map((s) => Buffer.from(s).toString("hex"));
  return opciones.findIndex((o) => votos.includes(hashOpcion(o).toString("hex")));
}