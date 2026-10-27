import { and, eq, isNotNull, lt, lte, ne, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { adjunto, ocurrencia, recordatorio, type Configuracion, type Ocurrencia, type Recordatorio } from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { aLocal, finDeSilencio, formatearCuando, formatearHora } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { describirMinutos } from "../lib/textos.js";
import { obtenerConfig, plantillasDe, renderizar } from "./configuracion.js";
import { enviador } from "./enviador.js";
import { obtenerLista, textoLista } from "./listas.js";
import { registrarMensaje } from "./mensajes.js";
import { avanzarRecurrente, cerrarSiCorresponde } from "./recordatorios.js";

type Agendar = (ocurrenciaId: number, cuando: Date) => Promise<void>;
let reagendar: Agendar = async () => {};
export const fijarReagendador = (fn: Agendar) => {
  reagendar = fn;
};

// Todo envío pasa en fila, de a uno (un solo proceso, un solo número).
let cola: Promise<unknown> = Promise.resolve();
export function enFila<T>(fn: () => Promise<T>): Promise<T> {
  const r = cola.then(fn, fn);
  cola = r.catch(() => {});
  return r;
}

const MARGEN_MS = 5_000;

/** Cuándo se puede enviar: corre el envío si cae en silencio (horario o "silencio 2h"). */
export function postergarPorSilencio(cuando: Date, cfg: Configuracion): Date | null {
  let fin: Date | null = null;
  if (cfg.botSilenciadoHasta && cfg.botSilenciadoHasta > cuando) fin = cfg.botSilenciadoHasta;
  const horario = finDeSilencio(fin ?? cuando, {
    activo: cfg.silencioActivo,
    desde: cfg.silencioDesde,
    hasta: cfg.silencioHasta,
    dias: cfg.silencioDias,
  });
  return horario ?? fin;
}

export function textoAviso(oc: Ocurrencia, rec: Recordatorio, cfg: Configuracion, ahora = new Date()) {
  const p = plantillasDe(cfg);
  // Se compara con el envío que tocaba ahora (no con la fecha original: un pospuesto no está atrasado).
  const tocaba = oc.proximoEnvioEn ?? oc.programadaPara;
  const atrasada = oc.intentos === 0 && ahora.getTime() - tocaba.getTime() > cfg.minutosAtrasado * 60_000;
  const vars = {
    titulo: rec.titulo,
    descripcion: rec.descripcion ? `\n${rec.descripcion}` : "",
    hora: formatearHora(aLocal(oc.instancia)),
    fecha: aLocal(oc.instancia).toFormat("dd/MM"),
    cuando: formatearCuando(oc.tipo === "previo" && !atrasada ? oc.instancia : oc.programadaPara, aLocal(ahora)),
    falta: describirMinutos(oc.minutosAntes),
    intento: oc.intentos,
    tope: oc.tope,
    nombre: cfg.nombreUsuario,
    ayuda: oc.insiste ? "\n_Respondé *listo* cuando lo hagas o *posponé 15 min*._" : "",
  };
  if (oc.intentos > 0) return { texto: renderizar(p.insistencia, vars), atrasada: oc.atrasada };
  if (atrasada) return { texto: renderizar(p.atrasado, vars), atrasada };
  return { texto: renderizar(oc.tipo === "previo" ? p.previo : p.aviso, vars), atrasada };
}

/** Procesa un aviso si le toca: lo envía, programa la insistencia o lo cierra. */
export function procesarOcurrencia(id: number): Promise<void> {
  return enFila(() => procesar(id));
}

async function procesar(id: number): Promise<void> {
  const [fila] = await db
    .select({ oc: ocurrencia, rec: recordatorio })
    .from(ocurrencia)
    .innerJoin(recordatorio, eq(ocurrencia.recordatorioId, recordatorio.id))
    .where(eq(ocurrencia.id, id));
  if (!fila) return;
  const { oc, rec } = fila;
  const ahora = new Date();
  if (!["pendiente", "enviada"].includes(oc.estado) || !oc.proximoEnvioEn) return;
  if (oc.proximoEnvioEn.getTime() > ahora.getTime() + MARGEN_MS) return;
  if (rec.estado !== "activo") return;

  const cfg = await obtenerConfig();

  // Insistencia agotada: se marca como no confirmado y se deja de insistir.
  if (oc.estado === "enviada" && oc.intentos >= 1 + oc.tope) {
    await db.update(ocurrencia).set({ estado: "no_confirmada", proximoEnvioEn: null }).where(eq(ocurrencia.id, oc.id));
    await registrar("info", "scheduler", `Sin confirmar después de ${oc.tope} insistencias: ${rec.titulo}`);
    await cerrarSiCorresponde(rec.id);
    bus.avisar("recordatorios");
    return;
  }

  const fin = postergarPorSilencio(ahora, cfg);
  if (fin) {
    await db.update(ocurrencia).set({ proximoEnvioEn: fin }).where(eq(ocurrencia.id, oc.id));
    await reagendar(oc.id, fin);
    return;
  }

  const wa = enviador();
  if (!wa.conectado()) return; // Se reintenta al reconectar (barrido).

  const { texto: base, atrasada } = textoAviso(oc, rec, cfg, ahora);
  // Si el recordatorio tiene una lista, el primer aviso trae lo que falta en ese momento.
  let texto = base;
  if (oc.intentos === 0 && rec.listaId) {
    const l = await obtenerLista(rec.listaId);
    if (l) texto += `\n\n${textoLista(l)}`;
  }
  let waId: string | null = null;
  let adjuntoId: number | null = null;
  try {
    if (oc.intentos === 0 && rec.adjuntoId) {
      const [adj] = await db.select().from(adjunto).where(eq(adjunto.id, rec.adjuntoId));
      if (adj) {
        waId = await wa.enviarImagen(adj.rutaArchivo, adj.mime, texto, rec.chat);
        adjuntoId = adj.id;
      }
    }
    if (!waId) waId = await wa.enviarTexto(texto, rec.chat);
  } catch (err) {
    await registrar("error", "scheduler", `No se pudo enviar el aviso de "${rec.titulo}"`, err);
    return; // Queda pendiente; el barrido lo reintenta.
  }

  const intentos = oc.intentos + 1;
  const proximo = oc.insiste ? new Date(ahora.getTime() + oc.intervaloMin * 60_000) : null;
  await db
    .update(ocurrencia)
    .set({
      estado: "enviada",
      intentos,
      enviadaEn: oc.enviadaEn ?? ahora,
      ultimoEnvioEn: ahora,
      proximoEnvioEn: proximo,
      atrasada: oc.atrasada || atrasada,
      waMessageId: waId,
    })
    .where(eq(ocurrencia.id, oc.id));
  await registrarMensaje({
    direccion: "saliente",
    texto,
    tipo: adjuntoId ? "imagen" : "texto",
    waMessageId: waId,
    recordatorioId: rec.id,
    ocurrenciaId: oc.id,
    adjuntoId,
    chat: rec.chat,
    intencionDetectada: oc.intentos > 0 ? "insistencia" : oc.tipo === "previo" ? "aviso_previo" : "aviso",
  });
  if (proximo) await reagendar(oc.id, proximo);

  if (oc.tipo === "principal" && oc.intentos === 0) {
    // Un aviso nuevo deja sin efecto la insistencia de instancias anteriores del mismo recordatorio.
    await db
      .update(ocurrencia)
      .set({ estado: "no_confirmada", proximoEnvioEn: null })
      .where(
        and(
          eq(ocurrencia.recordatorioId, rec.id),
          eq(ocurrencia.estado, "enviada"),
          isNotNull(ocurrencia.proximoEnvioEn),
          lt(ocurrencia.instancia, oc.instancia),
        ),
      );
  }

  if (rec.rrule) {
    const [actual] = await db.select().from(recordatorio).where(eq(recordatorio.id, rec.id));
    if (actual) await avanzarRecurrente(actual);
  } else {
    await cerrarSiCorresponde(rec.id);
  }
  bus.avisar("recordatorios");
}

/** Ocurrencias vencidas que todavía hay que procesar (las usa el barrido). */
export async function ocurrenciasVencidas(): Promise<number[]> {
  const filas = await db
    .select({ id: ocurrencia.id })
    .from(ocurrencia)
    .innerJoin(recordatorio, eq(ocurrencia.recordatorioId, recordatorio.id))
    .where(
      and(
        inArray(ocurrencia.estado, ["pendiente", "enviada"]),
        lte(ocurrencia.proximoEnvioEn, new Date(Date.now() + MARGEN_MS)),
        ne(recordatorio.estado, "borrado"),
        eq(recordatorio.estado, "activo"),
      ),
    )
    .orderBy(ocurrencia.proximoEnvioEn);
  return filas.map((f) => f.id);
}
