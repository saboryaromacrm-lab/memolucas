import pino from "pino";
import { desc, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { logSistema } from "../db/schema.js";
import { entorno } from "../entorno.js";
import { bus } from "./eventos.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: entorno.produccion ? undefined : { target: "pino-pretty", options: { colorize: true } },
});

type Nivel = "info" | "aviso" | "error";

/** Registra en el log del sistema (se ve en el panel) y en la consola. */
export async function registrar(nivel: Nivel, origen: string, mensaje: string, detalle?: unknown) {
  const datos = detalle instanceof Error ? { error: detalle.message, stack: detalle.stack } : detalle;
  const fn = nivel === "error" ? logger.error : nivel === "aviso" ? logger.warn : logger.info;
  fn.call(logger, { origen, detalle: datos }, mensaje);
  try {
    await db.insert(logSistema).values({ nivel, origen, mensaje, detalle: datos ?? null });
    bus.avisar("logs");
  } catch {
    // Si la base no está disponible, alcanza con la consola.
  }
}

/** Deja solo las últimas N entradas. */
export async function recortarLogs(max = 500) {
  const filas = await db.select({ id: logSistema.id }).from(logSistema).orderBy(desc(logSistema.id)).offset(max).limit(1);
  if (filas[0]) await db.delete(logSistema).where(lt(logSistema.id, filas[0].id + 1));
}
