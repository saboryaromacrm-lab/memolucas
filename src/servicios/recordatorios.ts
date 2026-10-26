import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  ocurrencia,
  recordatorio,
  type Configuracion,
  type ModoInsistencia,
  type Ocurrencia,
  type Recordatorio,
} from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { instanciasEntre, normalizarRrule, siguienteInstancia } from "../lib/recurrencia.js";
import { obtenerConfig } from "./configuracion.js";

export class ErrorUsuario extends Error {}

export type DatosRecordatorio = {
  titulo: string;
  descripcion?: string | null;
  fechaHora: Date;
  rrule?: string | null;
  avisosPreviosMin?: number[];
  avisarEnHora?: boolean;
  insistenciaModo?: ModoInsistencia;
  insistenciaIntervaloMin?: number | null;
  insistenciaTope?: number | null;
  insistirPrevios?: boolean | null;
  origen?: "whatsapp" | "panel" | "foto" | "enlace";
  adjuntoId?: number | null;
  listaId?: number | null;
};

// El scheduler se registra acá para evitar dependencias circulares.
type Agendador = (ocurrenciaId: number, cuando: Date) => Promise<void>;
let agendador: Agendador = async () => {};
export const fijarAgendador = (fn: Agendador) => {
  agendador = fn;
};

const MARGEN_PASADO_MS = 60_000;

export function insistenciaEfectiva(rec: Recordatorio, cfg: Configuracion) {
  if (rec.insistenciaModo === "off") return { activa: false, intervalo: cfg.insistenciaIntervaloMin, tope: 0, previos: false };
  if (rec.insistenciaModo === "propia")
    return {
      activa: true,
      intervalo: rec.insistenciaIntervaloMin ?? cfg.insistenciaIntervaloMin,
      tope: rec.insistenciaTope ?? cfg.insistenciaTope,
      previos: rec.insistirPrevios ?? cfg.insistirPrevios,
    };
  return {
    activa: cfg.insistenciaActiva,
    intervalo: cfg.insistenciaIntervaloMin,
    tope: cfg.insistenciaTope,
    previos: rec.insistirPrevios ?? cfg.insistirPrevios,
  };
}

/** Primera instancia a avisar desde `desde` (para únicos, su fecha). */
export function instanciaDesde(rec: Pick<Recordatorio, "rrule" | "fechaHora">, desde: Date): Date | null {
  if (!rec.rrule) return rec.fechaHora;
  return siguienteInstancia(rec.rrule, rec.fechaHora, desde, true);
}

/** Cancela los avisos abiertos (pendientes y los que están insistiendo). */
async function cancelarAbiertas(recId: number) {
  await db
    .update(ocurrencia)
    .set({ estado: "cancelada", proximoEnvioEn: null })
    .where(
      and(
        eq(ocurrencia.recordatorioId, recId),
        or(eq(ocurrencia.estado, "pendiente"), and(eq(ocurrencia.estado, "enviada"), isNotNull(ocurrencia.proximoEnvioEn))),
      ),
    );
}

/** Crea los avisos (previos y principal) de una instancia y los agenda. */
export async function programarInstancia(rec: Recordatorio, instancia: Date, cfg?: Configuracion): Promise<Ocurrencia[]> {
  cfg ??= await obtenerConfig();
  const ins = insistenciaEfectiva(rec, cfg);
  const ahora = Date.now();
  const filas: (typeof ocurrencia.$inferInsert)[] = [];
  const previos = [...new Set(rec.avisosPreviosMin.filter((m) => m > 0))].sort((a, b) => b - a);
  for (const min of previos) {
    const cuando = new Date(instancia.getTime() - min * 60_000);
    if (cuando.getTime() < ahora - MARGEN_PASADO_MS) continue;
    filas.push({
      recordatorioId: rec.id,
      instancia,
      programadaPara: cuando,
      proximoEnvioEn: cuando,
      tipo: "previo",
      minutosAntes: min,
      insiste: ins.activa && ins.previos,
      intervaloMin: ins.intervalo,
      tope: ins.tope,
    });
  }
  if (rec.avisarEnHora || filas.length === 0) {
    filas.push({
      recordatorioId: rec.id,
      instancia,
      programadaPara: instancia,
      proximoEnvioEn: instancia,
      tipo: "principal",
      insiste: ins.activa,
      intervaloMin: ins.intervalo,
      tope: ins.tope,
    });
  }
  const creadas = filas.length ? await db.insert(ocurrencia).values(filas).returning() : [];
  await db.update(recordatorio).set({ proximaInstancia: instancia }).where(eq(recordatorio.id, rec.id));
  for (const oc of creadas) await agendador(oc.id, oc.proximoEnvioEn!);
  return creadas;
}

/** Vuelve a calcular los avisos desde cero (al crear, editar o reanudar). */
async function reprogramar(rec: Recordatorio): Promise<Recordatorio> {
  await cancelarAbiertas(rec.id);
  if (rec.estado !== "activo") return rec;
  const instancia = instanciaDesde(rec, new Date(Date.now() - MARGEN_PASADO_MS));
  if (!instancia) {
    const [r] = await db.update(recordatorio).set({ estado: "cumplido", proximaInstancia: null }).where(eq(recordatorio.id, rec.id)).returning();
    return r;
  }
  await programarInstancia(rec, instancia);
  const [r] = await db.select().from(recordatorio).where(eq(recordatorio.id, rec.id));
  return r;
}

function validar(d: Pick<DatosRecordatorio, "titulo" | "fechaHora" | "rrule">, rruleNormal: string | null) {
  if (!d.titulo?.trim()) throw new ErrorUsuario("Falta el título.");
  if (!(d.fechaHora instanceof Date) || Number.isNaN(d.fechaHora.getTime())) throw new ErrorUsuario("La fecha no es válida.");
  if (d.rrule && !rruleNormal) throw new ErrorUsuario("La repetición no es válida.");
  if (!rruleNormal && d.fechaHora.getTime() < Date.now() - MARGEN_PASADO_MS)
    throw new ErrorUsuario("Esa fecha ya pasó. Elegí una fecha futura.");
}

export async function crearRecordatorio(d: DatosRecordatorio): Promise<Recordatorio> {
  const rr = normalizarRrule(d.rrule);
  validar(d, rr);
  const cfg = await obtenerConfig();
  const [rec] = await db
    .insert(recordatorio)
    .values({
      titulo: d.titulo.trim(),
      descripcion: d.descripcion?.trim() || null,
      fechaHora: d.fechaHora,
      rrule: rr,
      avisosPreviosMin: d.avisosPreviosMin ?? [],
      avisarEnHora: d.avisarEnHora ?? cfg.avisarEnHoraDefecto,
      insistenciaModo: d.insistenciaModo ?? "global",
      insistenciaIntervaloMin: d.insistenciaIntervaloMin ?? null,
      insistenciaTope: d.insistenciaTope ?? null,
      insistirPrevios: d.insistirPrevios ?? null,
      origen: d.origen ?? "panel",
      adjuntoId: d.adjuntoId ?? null,
      listaId: d.listaId ?? null,
    })
    .returning();
  const r = await reprogramar(rec);
  bus.avisar("recordatorios");
  return r;
}

export async function obtenerRecordatorio(id: number): Promise<Recordatorio | null> {
  const [r] = await db.select().from(recordatorio).where(and(eq(recordatorio.id, id), ne(recordatorio.estado, "borrado")));
  return r ?? null;
}

async function exigir(id: number): Promise<Recordatorio> {
  const r = await obtenerRecordatorio(id);
  if (!r) throw new ErrorUsuario("No encontré ese recordatorio.");
  return r;
}

export async function actualizarRecordatorio(id: number, cambios: Partial<DatosRecordatorio>): Promise<Recordatorio> {
  const actual = await exigir(id);
  const rr = cambios.rrule !== undefined ? normalizarRrule(cambios.rrule) : actual.rrule;
  const fechaHora = cambios.fechaHora ?? actual.fechaHora;
  const titulo = cambios.titulo ?? actual.titulo;
  const cambiaAgenda =
    cambios.fechaHora !== undefined ||
    cambios.rrule !== undefined ||
    cambios.avisosPreviosMin !== undefined ||
    cambios.avisarEnHora !== undefined ||
    cambios.insistenciaModo !== undefined ||
    cambios.insistenciaIntervaloMin !== undefined ||
    cambios.insistenciaTope !== undefined ||
    cambios.insistirPrevios !== undefined;
  if (cambiaAgenda) validar({ titulo, fechaHora, rrule: cambios.rrule ?? actual.rrule }, rr);
  let estado = actual.estado;
  // Un recordatorio terminado vuelve a estar activo si le cambiás la fecha.
  if (cambiaAgenda && (estado === "cumplido" || estado === "no_confirmado")) estado = "activo";
  const [rec] = await db
    .update(recordatorio)
    .set({
      titulo: titulo.trim(),
      descripcion: cambios.descripcion !== undefined ? cambios.descripcion?.trim() || null : actual.descripcion,
      fechaHora,
      rrule: rr,
      avisosPreviosMin: cambios.avisosPreviosMin ?? actual.avisosPreviosMin,
      avisarEnHora: cambios.avisarEnHora ?? actual.avisarEnHora,
      insistenciaModo: cambios.insistenciaModo ?? actual.insistenciaModo,
      insistenciaIntervaloMin: cambios.insistenciaIntervaloMin !== undefined ? cambios.insistenciaIntervaloMin : actual.insistenciaIntervaloMin,
      insistenciaTope: cambios.insistenciaTope !== undefined ? cambios.insistenciaTope : actual.insistenciaTope,
      insistirPrevios: cambios.insistirPrevios !== undefined ? cambios.insistirPrevios : actual.insistirPrevios,
      adjuntoId: cambios.adjuntoId !== undefined ? cambios.adjuntoId : actual.adjuntoId,
      listaId: cambios.listaId !== undefined ? cambios.listaId : actual.listaId,
      estado,
      actualizadoEn: sql`now()`,
    })
    .where(eq(recordatorio.id, id))
    .returning();
  const r = cambiaAgenda ? await reprogramar(rec) : rec;
  bus.avisar("recordatorios");
  return r;
}

export async function pausarRecordatorio(id: number) {
  await exigir(id);
  await db.update(recordatorio).set({ estado: "pausado", actualizadoEn: sql`now()` }).where(eq(recordatorio.id, id));
  await cancelarAbiertas(id);
  bus.avisar("recordatorios");
}

export async function reanudarRecordatorio(id: number) {
  const r = await exigir(id);
  if (!r.rrule && r.fechaHora.getTime() < Date.now() - MARGEN_PASADO_MS)
    throw new ErrorUsuario("La fecha de ese recordatorio ya pasó. Cambiale la fecha para reactivarlo.");
  const [rec] = await db
    .update(recordatorio)
    .set({ estado: "activo", actualizadoEn: sql`now()` })
    .where(eq(recordatorio.id, id))
    .returning();
  await reprogramar(rec);
  bus.avisar("recordatorios");
}

export async function borrarRecordatorio(id: number) {
  await exigir(id);
  await cancelarAbiertas(id);
  await db.update(recordatorio).set({ estado: "borrado", actualizadoEn: sql`now()` }).where(eq(recordatorio.id, id));
  bus.avisar("recordatorios");
}

export async function duplicarRecordatorio(id: number): Promise<Recordatorio> {
  const r = await exigir(id);
  let fecha = r.fechaHora;
  while (!r.rrule && fecha.getTime() < Date.now()) fecha = new Date(fecha.getTime() + 86_400_000);
  return crearRecordatorio({
    titulo: `${r.titulo} (copia)`,
    descripcion: r.descripcion,
    fechaHora: fecha,
    rrule: r.rrule,
    avisosPreviosMin: r.avisosPreviosMin,
    avisarEnHora: r.avisarEnHora,
    insistenciaModo: r.insistenciaModo,
    insistenciaIntervaloMin: r.insistenciaIntervaloMin,
    insistenciaTope: r.insistenciaTope,
    insistirPrevios: r.insistirPrevios,
    origen: "panel",
    adjuntoId: r.adjuntoId,
    listaId: r.listaId,
  });
}

/** Marca como hecho: confirma lo que está insistiendo y cierra la instancia actual. */
export async function marcarHecho(id: number) {
  const r = await exigir(id);
  await db
    .update(ocurrencia)
    .set({ estado: "confirmada", confirmadaEn: new Date(), proximoEnvioEn: null })
    .where(and(eq(ocurrencia.recordatorioId, id), eq(ocurrencia.estado, "enviada")));
  if (!r.rrule) {
    await cancelarAbiertas(id);
    await db.update(recordatorio).set({ estado: "cumplido", actualizadoEn: sql`now()` }).where(eq(recordatorio.id, id));
  } else if (r.proximaInstancia) {
    // Cierra la instancia actual y pasa a la siguiente.
    await db
      .update(ocurrencia)
      .set({ estado: "cancelada", proximoEnvioEn: null })
      .where(and(eq(ocurrencia.recordatorioId, id), eq(ocurrencia.estado, "pendiente")));
    const sig = siguienteInstancia(r.rrule, r.fechaHora, new Date(Math.max(r.proximaInstancia.getTime(), Date.now())));
    if (sig) await programarInstancia(r, sig);
    else await db.update(recordatorio).set({ estado: "cumplido" }).where(eq(recordatorio.id, id));
  }
  bus.avisar("recordatorios");
}

/** Crea un aviso extra para enviarlo ya, sin tocar la agenda. */
export async function crearEnvioInmediato(id: number): Promise<Ocurrencia> {
  const r = await exigir(id);
  const ahora = new Date();
  const [oc] = await db
    .insert(ocurrencia)
    .values({
      recordatorioId: r.id,
      instancia: r.proximaInstancia ?? r.fechaHora,
      programadaPara: ahora,
      proximoEnvioEn: ahora,
      tipo: "principal",
      insiste: false,
    })
    .returning();
  return oc;
}

// ───────────── Confirmar / posponer ─────────────

export async function confirmarOcurrencia(ocId: number): Promise<Ocurrencia | null> {
  const [oc] = await db
    .update(ocurrencia)
    .set({ estado: "confirmada", confirmadaEn: new Date(), proximoEnvioEn: null })
    .where(and(eq(ocurrencia.id, ocId), inArray(ocurrencia.estado, ["enviada", "no_confirmada", "pendiente"])))
    .returning();
  if (oc) {
    await cerrarSiCorresponde(oc.recordatorioId);
    bus.avisar("recordatorios");
  }
  return oc ?? null;
}

export async function posponerOcurrencia(ocId: number, hasta: Date): Promise<Ocurrencia | null> {
  const [oc] = await db
    .update(ocurrencia)
    .set({ estado: "pendiente", proximoEnvioEn: hasta, pospuestaHasta: hasta, intentos: 0 })
    .where(and(eq(ocurrencia.id, ocId), inArray(ocurrencia.estado, ["enviada", "no_confirmada", "pendiente"])))
    .returning();
  if (!oc) return null;
  // Si ya estaba cerrado como no confirmado, vuelve a estar activo.
  await db
    .update(recordatorio)
    .set({ estado: "activo" })
    .where(and(eq(recordatorio.id, oc.recordatorioId), inArray(recordatorio.estado, ["cumplido", "no_confirmado"])));
  await agendador(oc.id, hasta);
  bus.avisar("recordatorios");
  return oc;
}

/** El aviso que espera confirmación más reciente (para "listo" o "posponé 15 min"). */
export async function ultimaOcurrenciaEnviada(recId?: number): Promise<Ocurrencia | null> {
  const filtros = [inArray(ocurrencia.estado, ["enviada", "no_confirmada"]), isNotNull(ocurrencia.ultimoEnvioEn)];
  if (recId) filtros.push(eq(ocurrencia.recordatorioId, recId));
  // Primero las que están insistiendo; si no hay, la última enviada en las últimas 24 h.
  const [insistiendo] = await db
    .select()
    .from(ocurrencia)
    .where(and(...filtros, eq(ocurrencia.estado, "enviada"), isNotNull(ocurrencia.proximoEnvioEn)))
    .orderBy(desc(ocurrencia.ultimoEnvioEn))
    .limit(1);
  if (insistiendo) return insistiendo;
  const [ultima] = await db
    .select()
    .from(ocurrencia)
    .where(and(...filtros, sql`${ocurrencia.ultimoEnvioEn} > now() - interval '24 hours'`))
    .orderBy(desc(ocurrencia.ultimoEnvioEn))
    .limit(1);
  return ultima ?? null;
}

/** El próximo aviso sin enviar de un recordatorio (para posponer algo que todavía no llegó). */
export async function proximaOcurrenciaPendiente(recId: number): Promise<Ocurrencia | null> {
  const [oc] = await db
    .select()
    .from(ocurrencia)
    .where(and(eq(ocurrencia.recordatorioId, recId), eq(ocurrencia.estado, "pendiente")))
    .orderBy(asc(ocurrencia.proximoEnvioEn))
    .limit(1);
  return oc ?? null;
}

/** Recordatorio único: si ya no queda nada abierto, lo marca cumplido o no confirmado. */
export async function cerrarSiCorresponde(recId: number) {
  const r = await obtenerRecordatorio(recId);
  if (!r || r.rrule || r.estado !== "activo") return;
  const ocs = await db.select().from(ocurrencia).where(eq(ocurrencia.recordatorioId, recId));
  const abiertas = ocs.filter((o) => o.estado === "pendiente" || (o.estado === "enviada" && o.proximoEnvioEn));
  if (abiertas.length) return;
  const algunaConfirmada = ocs.some((o) => o.estado === "confirmada");
  const algunaNoConfirmada = ocs.some((o) => o.estado === "no_confirmada");
  const estado = !algunaConfirmada && algunaNoConfirmada ? "no_confirmado" : "cumplido";
  await db.update(recordatorio).set({ estado, actualizadoEn: sql`now()` }).where(eq(recordatorio.id, recId));
  bus.avisar("recordatorios");
}

/** Recurrente: cuando la instancia actual ya pasó y se envió, programa la siguiente. */
export async function avanzarRecurrente(rec: Recordatorio): Promise<void> {
  if (!rec.rrule || rec.estado !== "activo") return;
  const actual = rec.proximaInstancia;
  if (actual && actual.getTime() > Date.now()) return;
  if (actual) {
    const [sinEnviar] = await db
      .select({ id: ocurrencia.id })
      .from(ocurrencia)
      .where(
        and(
          eq(ocurrencia.recordatorioId, rec.id),
          eq(ocurrencia.instancia, actual),
          eq(ocurrencia.estado, "pendiente"),
          isNull(ocurrencia.enviadaEn),
        ),
      )
      .limit(1);
    if (sinEnviar) return;
  }
  const base = new Date(Math.max(actual?.getTime() ?? 0, Date.now() - MARGEN_PASADO_MS));
  const sig = siguienteInstancia(rec.rrule, rec.fechaHora, base);
  if (sig) await programarInstancia(rec, sig);
  else await db.update(recordatorio).set({ estado: "cumplido", proximaInstancia: null }).where(eq(recordatorio.id, rec.id));
  bus.avisar("recordatorios");
}

export async function recurrentesParaAvanzar(): Promise<Recordatorio[]> {
  return db
    .select()
    .from(recordatorio)
    .where(
      and(
        eq(recordatorio.estado, "activo"),
        isNotNull(recordatorio.rrule),
        or(isNull(recordatorio.proximaInstancia), lte(recordatorio.proximaInstancia, new Date())),
      ),
    );
}

// ───────────── Consultas ─────────────

export type Evento = { recordatorio: Recordatorio; cuando: Date };

/** Instancias de los recordatorios activos entre dos fechas (expande los recurrentes). */
export async function eventosEntre(desde: Date, hasta: Date, estados: string[] = ["activo"]): Promise<Evento[]> {
  const recs = await db
    .select()
    .from(recordatorio)
    .where(inArray(recordatorio.estado, estados as Recordatorio["estado"][]));
  const eventos: Evento[] = [];
  for (const r of recs) {
    if (r.rrule) {
      for (const cuando of instanciasEntre(r.rrule, r.fechaHora, desde, hasta)) eventos.push({ recordatorio: r, cuando });
    } else if (r.fechaHora >= desde && r.fechaHora <= hasta) {
      eventos.push({ recordatorio: r, cuando: r.fechaHora });
    }
  }
  return eventos.sort((a, b) => a.cuando.getTime() - b.cuando.getTime());
}

export async function recordatoriosActivos(): Promise<Recordatorio[]> {
  return db
    .select()
    .from(recordatorio)
    .where(inArray(recordatorio.estado, ["activo", "pausado"]))
    .orderBy(asc(recordatorio.proximaInstancia), asc(recordatorio.fechaHora));
}

/** Avisos enviados que esperan confirmación. */
export async function pendientesSinConfirmar() {
  return db
    .select({ ocurrencia, recordatorio })
    .from(ocurrencia)
    .innerJoin(recordatorio, eq(ocurrencia.recordatorioId, recordatorio.id))
    .where(and(eq(ocurrencia.estado, "enviada"), isNotNull(ocurrencia.proximoEnvioEn), ne(recordatorio.estado, "borrado")))
    .orderBy(desc(ocurrencia.ultimoEnvioEn));
}
