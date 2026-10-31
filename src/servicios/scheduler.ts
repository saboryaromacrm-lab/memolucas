import fs from "node:fs/promises";
import { and, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { db } from "../db/index.js";
import { adjunto, borradorPendiente, recordatorio } from "../db/schema.js";
import { entorno } from "../entorno.js";
import { recortarLogs, registrar } from "../lib/log.js";
import { obtenerConfig } from "./configuracion.js";
import { fijarReagendador, ocurrenciasVencidas, procesarOcurrencia } from "./disparador.js";
import { avanzarRecurrente, fijarAgendador, recurrentesParaAvanzar } from "./recordatorios.js";
import { limpiarArchivosViejos } from "./compras.js";
import { revisarResumenDiario } from "./resumen.js";

const COLA_DISPARO = "disparo";
const COLA_BARRIDO = "barrido";

let boss: PgBoss | null = null;
let ultimoBarrido: Date | null = null;

export const estadoScheduler = () => ({ activo: !!boss, ultimoBarrido });

async function agendar(ocurrenciaId: number, cuando: Date) {
  if (!boss) return;
  await boss.send(COLA_DISPARO, { ocurrenciaId }, { startAfter: cuando });
}

let barriendo = false;

/** Revisa todo lo que venció (incluye lo atrasado mientras la app o WhatsApp estaban caídos). */
export async function barrer(): Promise<void> {
  if (barriendo) return;
  barriendo = true;
  try {
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    for (const rec of await recurrentesParaAvanzar()) await avanzarRecurrente(rec);
    await revisarResumenDiario();
    await db.delete(borradorPendiente).where(lt(borradorPendiente.expiraEn, new Date()));
    ultimoBarrido = new Date();
  } catch (err) {
    await registrar("error", "scheduler", "Falló el barrido", err);
  } finally {
    barriendo = false;
  }
}

/** Mantenimiento una vez por hora: recorta logs, borra los escaneos de compras viejos y, si está activado, las fotos viejas. */
async function mantenimiento() {
  await recortarLogs(500);
  const cfg = await obtenerConfig();
  const compras = await limpiarArchivosViejos(cfg.comprasDiasArchivo);
  if (compras) await registrar("info", "mantenimiento", `Se borraron los archivos de ${compras} comprobantes de más de ${cfg.comprasDiasArchivo} días`);
  if (!cfg.limpiezaFotosActiva) return;
  const limite = new Date(Date.now() - cfg.limpiezaFotosDias * 86_400_000);
  // Fotos de recordatorios terminados y sin cambios desde hace N días.
  const enUso = db
    .select({ id: recordatorio.adjuntoId })
    .from(recordatorio)
    .where(and(isNotNull(recordatorio.adjuntoId), inArray(recordatorio.estado, ["activo", "pausado"])));
  // Los archivos de compras tienen su propio plazo, y el logo del panel de compras no se borra.
  const deCompras = sql`select unnest(adjunto_ids) from comprobante union select unnest(adjunto_ids) from lectura_compras`;
  const viejos = await db
    .select()
    .from(adjunto)
    .where(
      and(
        lt(adjunto.creadoEn, limite),
        notInArray(adjunto.id, sql`(${enUso})`),
        notInArray(adjunto.id, sql`(${deCompras})`),
        cfg.comprasLogoAdjuntoId ? ne(adjunto.id, cfg.comprasLogoAdjuntoId) : undefined,
      ),
    );
  for (const a of viejos) {
    await fs.rm(a.rutaArchivo, { force: true });
    await db.delete(adjunto).where(sql`${adjunto.id} = ${a.id}`);
  }
  if (viejos.length) await registrar("info", "mantenimiento", `Se borraron ${viejos.length} fotos viejas`);
}

export async function iniciarScheduler(): Promise<void> {
  boss = new PgBoss({ connectionString: entorno.databaseUrl, schema: "pgboss" });
  boss.on("error", (err: Error) => void registrar("error", "scheduler", "Error de pg-boss", err));
  await boss.start();
  await boss.createQueue(COLA_DISPARO);
  await boss.createQueue(COLA_BARRIDO);
  await boss.createQueue("mantenimiento");

  fijarAgendador(agendar);
  fijarReagendador(agendar);

  await boss.work<{ ocurrenciaId: number }>(COLA_DISPARO, { pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) await procesarOcurrencia(job.data.ocurrenciaId);
  });
  await boss.work(COLA_BARRIDO, async () => barrer());
  await boss.work("mantenimiento", async () => mantenimiento());

  await boss.schedule(COLA_BARRIDO, "* * * * *");
  await boss.schedule("mantenimiento", "17 * * * *");
}

export async function detenerScheduler(): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = null;
  await b.stop({ graceful: true, timeout: 10_000 });
}
