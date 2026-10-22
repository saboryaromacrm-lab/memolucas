import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { entorno } from "../entorno.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({ connectionString: entorno.databaseUrl, max: 10 });
pool.on("error", (err) => console.error("[db] error en el pool:", err.message));

export const db = drizzle(pool, { schema });
export type Db = typeof db;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera a que PostgreSQL esté listo (útil al reiniciar el VPS). */
export async function esperarBase(intentosMax = 60): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query("select 1");
      return;
    } catch (err) {
      if (i >= intentosMax) throw err;
      const ms = Math.min(1000 * i, 10_000);
      console.warn(`[db] la base no responde (intento ${i}), reintento en ${ms / 1000}s`);
      await espera(ms);
    }
  }
}

export async function migrarBase(): Promise<void> {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  await migrate(db, { migrationsFolder: path.resolve(aqui, "../../drizzle") });
}

export async function baseOk(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
