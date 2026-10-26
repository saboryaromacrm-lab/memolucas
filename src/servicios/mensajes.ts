import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { mensaje } from "../db/schema.js";
import { bus } from "../lib/eventos.js";

export type NuevoMensaje = typeof mensaje.$inferInsert;

export async function registrarMensaje(m: NuevoMensaje) {
  const [fila] = await db.insert(mensaje).values(m).returning();
  bus.avisar("mensajes");
  return fila;
}

export async function ultimosMensajes(n = 5) {
  const filas = await db.select().from(mensaje).orderBy(desc(mensaje.id)).limit(n);
  return filas.reverse();
}

export async function mensajePorWaId(waId: string) {
  const [fila] = await db.select().from(mensaje).where(eq(mensaje.waMessageId, waId)).orderBy(desc(mensaje.id)).limit(1);
  return fila ?? null;
}

export async function ultimoEntrante() {
  const [fila] = await db.select().from(mensaje).where(eq(mensaje.direccion, "entrante")).orderBy(desc(mensaje.id)).limit(1);
  return fila ?? null;
}
