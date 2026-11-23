import { asc, eq, isNotNull, or } from "drizzle-orm";
import { DateTime, type DurationLikeObject } from "luxon";
import { db } from "../db/index.js";
import { suscripcion, type Configuracion, type FrecuenciaSuscripcion, type Suscripcion } from "../db/schema.js";
import { sinFormato } from "../bot/frases.js";
import { bus } from "../lib/eventos.js";
import { ahora, parseHora } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { plata } from "../lib/textos.js";
import { obtenerConfig } from "./configuracion.js";
import { enFila } from "./disparador.js";
import { registrarEncuesta } from "./encuestas.js";
import { enviador } from "./enviador.js";
import { registrarMensaje } from "./mensajes.js";
import { ErrorUsuario } from "./recordatorios.js";
import { cuandoVence, momentoAviso, sePuedeAvisar } from "./vencimientos.js";

export type DatosSuscripcion = Pick<Suscripcion, "nombre" | "url" | "fechaInicio" | "fechaVto" | "monto" | "moneda" | "frecuencia" | "observacion"> &
  Partial<Pick<Suscripcion, "tarjetaId" | "sinTarjeta">>;

const PERIODOS: Record<FrecuenciaSuscripcion, DurationLikeObject> = { "7dias": { days: 7 }, quincenal: { days: 15 }, mensual: { months: 1 }, anual: { years: 1 } };

/** Renovar suma un período a la fecha de vencimiento (no a la de hoy). */
export const sumarPeriodo = (fecha: string, f: FrecuenciaSuscripcion) => DateTime.fromISO(fecha).plus(PERIODOS[f]).toISODate()!;

/** Los dos avisos de un vencimiento: X días antes y el mismo día, a la hora por defecto. */
const momentosAviso = (fechaVto: string, cfg: Configuracion) => ({ previo: momentoAviso(fechaVto, cfg.suscripcionesDiasAviso, cfg), dia: momentoAviso(fechaVto, 0, cfg) });

/** Con una fecha nueva, los avisos vuelven a empezar; los que ya deberían haber salido no se mandan (se ven en el panel). */
async function avisosDesde(fechaVto: string) {
  const m = momentosAviso(fechaVto, await obtenerConfig());
  const ya = new Date();
  return { avisoPrevioEnviado: m.previo <= ya, avisoDiaEnviado: m.dia <= ya, recordarEn: null };
}

async function obtener(id: number): Promise<Suscripcion> {
  const [s] = await db.select().from(suscripcion).where(eq(suscripcion.id, id));
  if (!s) throw new ErrorUsuario("Esa suscripción ya no existe.");
  return s;
}

export const listarSuscripciones = () => db.select().from(suscripcion).orderBy(asc(suscripcion.fechaVto), asc(suscripcion.id));

export async function crearSuscripcion(d: DatosSuscripcion): Promise<Suscripcion> {
  const [s] = await db
    .insert(suscripcion)
    .values({ ...d, ...(await avisosDesde(d.fechaVto)) })
    .returning();
  bus.avisar("suscripciones");
  return s;
}

export async function actualizarSuscripcion(id: number, d: DatosSuscripcion): Promise<Suscripcion> {
  const actual = await obtener(id);
  const avisos = d.fechaVto !== actual.fechaVto ? await avisosDesde(d.fechaVto) : {};
  const [s] = await db
    .update(suscripcion)
    .set({ ...d, ...avisos, actualizadoEn: new Date() })
    .where(eq(suscripcion.id, id))
    .returning();
  bus.avisar("suscripciones");
  return s;
}

export async function borrarSuscripcion(id: number) {
  await db.delete(suscripcion).where(eq(suscripcion.id, id));
  bus.avisar("suscripciones");
}

/** Con qué tarjeta se paga (null: con otro medio). */
export async function pagarSuscripcionCon(id: number, tarjetaId: number | null) {
  await obtener(id);
  await db
    .update(suscripcion)
    .set({ tarjetaId, sinTarjeta: tarjetaId === null, actualizadoEn: new Date() })
    .where(eq(suscripcion.id, id));
  bus.avisar("suscripciones");
}

/** Pasa al vencimiento siguiente (vencimiento actual + un período). */
export async function renovarSuscripcion(id: number): Promise<Suscripcion> {
  const s = await obtener(id);
  const fechaVto = sumarPeriodo(s.fechaVto, s.frecuencia);
  const [nueva] = await db
    .update(suscripcion)
    .set({ fechaVto, ...(await avisosDesde(fechaVto)), actualizadoEn: new Date() })
    .where(eq(suscripcion.id, id))
    .returning();
  bus.avisar("suscripciones");
  return nueva;
}

/**
 * "Renovada" desde un aviso de WhatsApp: renueva solo si el vencimiento actual ya fue avisado
 * (si ya se renovó, por el panel o con otro mensaje, no la vuelve a renovar).
 */
export async function renovarDesdeAviso(id: number): Promise<{ renovada: boolean; s: Suscripcion }> {
  const s = await obtener(id);
  if (!s.avisoPrevioEnviado && !s.avisoDiaEnviado) return { renovada: false, s };
  return { renovada: true, s: await renovarSuscripcion(id) };
}

/** "Recordame mañana": vuelve a avisar mañana a la hora por defecto. */
export async function recordarSuscripcionManana(id: number): Promise<{ s: Suscripcion; cuando: DateTime }> {
  await obtener(id);
  const cfg = await obtenerConfig();
  const cuando = ahora().plus({ days: 1 }).set({ ...parseHora(cfg.horaDefecto), second: 0, millisecond: 0 });
  const [s] = await db.update(suscripcion).set({ recordarEn: cuando.toJSDate() }).where(eq(suscripcion.id, id)).returning();
  bus.avisar("suscripciones");
  return { s, cuando };
}

// ───────────── Avisos por WhatsApp ─────────────

export const OPCIONES_SUSCRIPCION = ["🔄 Renovada", "⏰ Recordame mañana"];

/** Lo llama el barrido cada minuto: manda los avisos que tocan (X días antes, el día y los "recordame mañana"). */
export async function avisarSuscripciones(): Promise<void> {
  const cfg = await obtenerConfig();
  if (!sePuedeAvisar(cfg)) return;
  const ya = new Date();
  const filas = await db
    .select()
    .from(suscripcion)
    .where(or(eq(suscripcion.avisoDiaEnviado, false), isNotNull(suscripcion.recordarEn)));
  for (const s of filas) {
    const m = momentosAviso(s.fechaVto, cfg);
    const dia = !s.avisoDiaEnviado && m.dia <= ya;
    const previo = !dia && cfg.suscripcionesDiasAviso > 0 && !s.avisoPrevioEnviado && m.previo <= ya;
    const recordar = !!s.recordarEn && s.recordarEn <= ya;
    if (!dia && !previo && !recordar) continue;
    try {
      await enFila(() => enviarAviso(s, cfg.usarEncuestas));
    } catch (err) {
      await registrar("error", "suscripciones", `No se pudo avisar el vencimiento de "${s.nombre}"`, err);
      continue;
    }
    await db
      .update(suscripcion)
      .set({ avisoPrevioEnviado: s.avisoPrevioEnviado || previo || dia, avisoDiaEnviado: s.avisoDiaEnviado || dia, recordarEn: recordar || dia ? null : s.recordarEn })
      .where(eq(suscripcion.id, s.id));
    bus.avisar("suscripciones");
  }
}

async function enviarAviso(s: Suscripcion, conEncuesta: boolean) {
  const wa = enviador();
  const texto = `🔔 *${s.nombre}* ${cuandoVence(s.fechaVto)}${s.monto ? ` · ${plata(s.monto, s.moneda)}` : ""}${s.url ? `\n${s.url}` : ""}`;
  const comun = { direccion: "saliente" as const, chat: null, suscripcionId: s.id };
  const waId = await wa.enviarTexto(conEncuesta ? texto : `${texto}\n_Respondé *renovada* o *mañana*._`);
  await registrarMensaje({ ...comun, texto, waMessageId: waId, intencionDetectada: "aviso_suscripcion" });
  if (!conEncuesta) return;
  const pregunta = `¿Renovaste ${sinFormato(s.nombre)}?`;
  const r = await wa.enviarEncuesta(pregunta, OPCIONES_SUSCRIPCION);
  if (!r.id) return;
  await registrarEncuesta({ waMessageId: r.id, chat: null, secreto: r.secreto, opciones: OPCIONES_SUSCRIPCION, accion: { tipo: "suscripcion", suscripcionId: s.id } });
  await registrarMensaje({ ...comun, tipo: "encuesta", texto: `📊 ${pregunta}`, waMessageId: r.id, intencionDetectada: "encuesta" });
}
