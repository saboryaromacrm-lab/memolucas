import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { mensaje, type Canal } from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { filtroChat, type Ambito } from "./recordatorios.js";

export type NuevoMensaje = typeof mensaje.$inferInsert;

export async function registrarMensaje(m: NuevoMensaje) {
  const [fila] = await db.insert(mensaje).values(m).returning();
  bus.avisar("mensajes");
  return fila;
}

/** Los últimos mensajes de un chat (por defecto, el privado de WhatsApp), del más viejo al más nuevo. */
export async function ultimosMensajes(n = 5, ambito: Ambito = null, canal: Canal = "whatsapp") {
  const filas = await db
    .select()
    .from(mensaje)
    .where(and(filtroChat(mensaje.chat, ambito), eq(mensaje.canal, canal)))
    .orderBy(desc(mensaje.id))
    .limit(n);
  return filas.reverse();
}

export async function mensajePorWaId(waId: string) {
  const [fila] = await db.select().from(mensaje).where(eq(mensaje.waMessageId, waId)).orderBy(desc(mensaje.id)).limit(1);
  return fila ?? null;
}

/** El último mensaje que llegó por WhatsApp. */
export async function ultimoEntrante() {
  const [fila] = await db
    .select()
    .from(mensaje)
    .where(and(eq(mensaje.direccion, "entrante"), eq(mensaje.canal, "whatsapp")))
    .orderBy(desc(mensaje.id))
    .limit(1);
  return fila ?? null;
}
