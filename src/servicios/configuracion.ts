import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { configuracion, type Configuracion, type Plantillas } from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { fijarZona } from "../lib/fechas.js";

export const PLANTILLAS_DEFECTO: Plantillas = {
  confirmacion: "Listo ✅ Te recuerdo *{titulo}* {cuando}.",
  aviso: "⏰ *{titulo}*{descripcion}{ayuda}",
  previo: "🔔 En {falta}: *{titulo}* ({cuando}).{descripcion}{ayuda}",
  insistencia: "🔁 Te sigo recordando: *{titulo}*. Respondé *listo* cuando lo hagas. ({intento}/{tope})",
  atrasado: "⏰ Atrasado: *{titulo}* (era {cuando}).{descripcion}{ayuda}",
  resumen: "☀️ Buen día, {nombre}. Esto tenés para hoy:\n{lista}",
};

let cache: Configuracion | null = null;

export async function obtenerConfig(): Promise<Configuracion> {
  if (cache) return cache;
  const [fila] = await db.select().from(configuracion).where(eq(configuracion.id, 1));
  if (!fila) {
    await db.insert(configuracion).values({ id: 1 }).onConflictDoNothing();
    return obtenerConfig();
  }
  cache = fila;
  fijarZona(fila.zonaHoraria);
  return fila;
}

export function invalidarConfig() {
  cache = null;
}

export async function actualizarConfig(cambios: Partial<Omit<Configuracion, "id">>): Promise<Configuracion> {
  await db
    .update(configuracion)
    .set({ ...cambios, actualizadoEn: sql`now()` })
    .where(eq(configuracion.id, 1));
  cache = null;
  const cfg = await obtenerConfig();
  bus.avisar("configuracion");
  return cfg;
}

export function plantillasDe(cfg: Configuracion): Plantillas {
  return { ...PLANTILLAS_DEFECTO, ...Object.fromEntries(Object.entries(cfg.plantillas ?? {}).filter(([, v]) => v)) };
}

/** Reemplaza {variable} por su valor; las desconocidas quedan vacías. */
export function renderizar(plantilla: string, vars: Record<string, string | number | null | undefined>): string {
  return plantilla.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k];
    return v === null || v === undefined ? "" : String(v);
  });
}
