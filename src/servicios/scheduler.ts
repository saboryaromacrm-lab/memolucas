import fs from "node:fs/promises";
import path from "node:path";
import { and, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { db } from "../db/index.js";
import { adjunto, borradorPendiente, recordatorio } from "../db/schema.js";
import { entorno, rutas } from "../entorno.js";
import { recortarLogs, registrar } from "../lib/log.js";
import { obtenerConfig } from "./configuracion.js";
import { fijarReagendador, ocurrenciasVencidas, procesarOcurrencia } from "./disparador.js";
import { avanzarRecurrente, fijarAgendador, recurrentesParaAvanzar } from "./recordatorios.js";
import { revisarResumenDiario } from "./resumen.js";
import { avisarSuscripciones } from "./suscripciones.js";
import { avisarTarjetas } from "./tarjetas.js";

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
    await avisarSuscripciones();
    await avisarTarjetas();
    await db.delete(borradorPendiente).where(lt(borradorPendiente.expiraEn, new Date()));
    ultimoBarrido = new Date();
  } catch (err) {
    await registrar("error", "scheduler", "Falló el barrido", err);
  } finally {
    barriendo = false;
  }
}

/** Mantenimiento una vez por hora: recorta logs, borra los archivos sueltos y, si está activado, las fotos viejas. */
async function mantenimiento() {
  await recortarLogs(500);
  await borrarArchivosSueltos();
  const cfg = await obtenerConfig();
  if (!cfg.limpiezaFotosActiva) return;
  const limite = new Date(Date.now() - cfg.limpiezaFotosDias * 86_400_000);
  // Fotos de recordatorios terminados y sin cambios desde hace N días.
  const enUso = db
    .select({ id: recordatorio.adjuntoId })
    .from(recordatorio)
    .where(and(isNotNull(recordatorio.adjuntoId), inArray(recordatorio.estado, ["activo", "pausado"])));
  const viejos = await db
    .select()
    .from(adjunto)
    .where(
      and(
        lt(adjunto.creadoEn, limite),
        notInArray(adjunto.id, sql`(${enUso})`),
      ),
    );
  for (const a of viejos) {
    await fs.rm(a.rutaArchivo, { force: true });
    await db.delete(adjunto).where(sql`${adjunto.id} = ${a.id}`);
  }
  if (viejos.length) await registrar("info", "mantenimiento", `Se borraron ${viejos.length} fotos viejas`);
}

/**
 * Los archivos de la carpeta de fotos que ya no son de ningún adjunto (por ejemplo, los de las facturas de compras,
 * que ahora están en el ERP). Solo los de más de una hora, por si alguno se está guardando justo ahora.
 */
export async function borrarArchivosSueltos(): Promise<number> {
  const nombres = await fs.readdir(rutas.media).catch(() => [] as string[]);
  if (!nombres.length) return 0;
  const usados = new Set((await db.select({ ruta: adjunto.rutaArchivo }).from(adjunto)).map((a) => path.basename(a.ruta)));
  const limite = Date.now() - 3_600_000;
  let borrados = 0;
  for (const nombre of nombres) {
    if (usados.has(nombre)) continue;
    const ruta = path.join(rutas.media, nombre);
    const info = await fs.stat(ruta).catch(() => null);
    if (!info?.isFile() || info.mtimeMs > limite) continue;
    await fs.rm(ruta, { force: true });
    borrados++;
  }
  if (borrados) await registrar("info", "mantenimiento", `Se borraron ${borrados} archivos sueltos`);
  return borrados;
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
