import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import type { WAMessage } from "baileys";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import {
  adjunto,
  borradorPendiente,
  grupo,
  iaPendiente,
  mensaje,
  ocurrencia,
  type AccionEncuesta,
  type MotivoFallaIA,
  type Ocurrencia,
  type Recordatorio,
} from "../db/schema.js";
import { ahora, aLocal, formatearCuando } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { borrarAdjunto, guardarImagen, imagenParaIa, MIMES_IMAGEN } from "../servicios/adjuntos.js";
import { actualizarConfig, obtenerConfig, plantillasDe, renderizar } from "../servicios/configuracion.js";
import { listarRango } from "./rangos.js";
import { rangoHoy, rangoManana, rangoSemana, textoListado, textoTodos } from "../servicios/listados.js";
import { mensajePorWaId, registrarMensaje, ultimosMensajes } from "../servicios/mensajes.js";
import {
  actualizarRecordatorio,
  borrarRecordatorio,
  cancelarInstancia,
  confirmarOcurrencia,
  crearRecordatorio,
  ErrorUsuario,
  filtroChat,
  marcarHecho,
  obtenerRecordatorio,
  pausarRecordatorio,
  pendientesSinConfirmar,
  posponerOcurrencia,
  proximaOcurrenciaPendiente,
  reanudarRecordatorio,
  recordatoriosActivos,
  ultimaOcurrenciaEnviada,
  type DatosRecordatorio,
} from "../servicios/recordatorios.js";
import { EMOJIS_CONFIRMACION, TEXTO_AYUDA, detectarComando, esAfirmativo, esNegativo, pedidoDeLinks, respuestaASuscripcion, type PedidoDeLinks } from "./comandos.js";
import { extraerUrls, leerEnlace, textoSinUrls, type VistaPreviaWa } from "../servicios/enlaces.js";
import { analizarEnlace, analizarFoto, interpretar, motivoFallaIA, responderConNotas, type AnalisisFoto, type Interpretacion } from "./ia.js";
import { actualizarPagoDelMes, buscarPendientes, guardarComprobante, pagosPendientes, registrarPago, type ItemPago } from "../servicios/pagos.js";
import { buscarForma, formasActivas } from "../servicios/pagos-formas.js";
import { cuandoVence, diaDe } from "../servicios/vencimientos.js";
import { anotarFallaIA, revisarIA, textoFallaIA } from "./estado-ia.js";
import { ErrorAudio, transcribir } from "../servicios/audio.js";
import { actualizarNota, borrarNota, crearNota, obtenerNota, relacionadas, todasLasNotas } from "../servicios/notas.js";
import { obtenerAdjunto } from "../servicios/adjuntos.js";
import { esSoloEmoji, preguntarAlAgente, textoTope } from "./agente.js";
import { resumirVideo } from "./resumir-video.js";
import { ErrorVideo, esLinkDeVideo, leerVideo, MAX_SEGUNDOS_VIDEO, textoErrorVideo, type FuenteVideo } from "../servicios/videos.js";
import { buscarLinks, crearLink, listarLinks, urlValida, type Link } from "../servicios/links.js";
import { recordarSuscripcionManana, renovarDesdeAviso } from "../servicios/suscripciones.js";
import { normalizar, plata } from "../lib/textos.js";
import { encuestaPorWaId, marcarRespondida, opcionElegida, OPCIONES_PROPUESTA, registrarEncuesta } from "../servicios/encuestas.js";
import { cuandoBonito, textoPrevios } from "./formato.js";
import { frases, sinFormato } from "./frases.js";

/** Lo que el procesador necesita de WhatsApp. */
export interface CanalBot {
  /** destino: grupo (null = privado del dueño). citar: mensaje al que responde (en grupos). */
  responder(texto: string, destino?: string | null, citar?: WAMessage): Promise<string | null>;
  responderImagen(ruta: string, mime: string, epigrafe: string, destino?: string | null): Promise<string | null>;
  /** Encuesta para tocar una opción. Devuelve su id y la clave para leer los votos. */
  responderEncuesta(nombre: string, opciones: string[], destino?: string | null): Promise<{ id: string | null; secreto: string }>;
  /** Opciones votadas (como hash), o null si no se pudo descifrar. */
  descifrarVoto(msg: WAMessage, secreto: string): Uint8Array[] | null;
  descargarMedia(msg: WAMessage): Promise<Buffer>;
  /** Reacción con un emoji (ej. ✅ al confirmar). */
  reaccionar(msg: WAMessage, emoji: string): Promise<void>;
}

/** De dónde vino el mensaje que se está procesando. */
export type OrigenMensaje = { grupo: { jid: string; nombre: string } | null; autor: string | null };
type Contexto = OrigenMensaje & { msg: WAMessage; compras: boolean };

// Cada mensaje se procesa con su propio contexto (privado o grupo), aunque lleguen varios a la vez.
const contexto = new AsyncLocalStorage<Contexto>();
const chat = (): string | null => contexto.getStore()?.grupo?.jid ?? null;
const enGrupo = () => !!contexto.getStore()?.grupo;
/** El que era el grupo de compras: la primera foto o PDF recibe el aviso de que las facturas ahora van al ERP. */
const enCompras = () => !!contexto.getStore()?.compras;

/** Las facturas de proveedores ya no se leen acá: se cargan en el ERP. */
const AVISO_FACTURAS = "🧾 Las facturas ahora se cargan en el ERP de Coffit: https://tiendacoffit.saboryaroma.com";

function documentoDe(msg: WAMessage) {
  const m = msg.message;
  return m?.documentMessage ?? m?.documentWithCaptionMessage?.message?.documentMessage ?? null;
}


/** Hasta cuánto después del aviso de una suscripción un "renovada" sin citarlo es la respuesta. */
const HORAS_RESPUESTA_A_SUSCRIPCION = 24;

/** En grupos, fotos y links solo se procesan si se lo piden al bot. */
const PIDE_BOT = /\b(recorda|recordame|recordanos|recuerden|avisa|avisame|avisanos|anota|nota|agrega|guarda|guardalo|guardala|memo|memolucas|bot)\b/;
const MINUTOS_BORRADOR_GRUPO = 30;
/** Hasta cuánto después de una pregunta del bot ("¿para qué día?") un "hoy" o "mañana" es la respuesta y no un comando. */
const MINUTOS_RESPUESTA_A_PREGUNTA = 30;
/** Si el asistente terminó con una pregunta, lo que se conteste en este rato es para él. */
const MINUTOS_RESPUESTA_AL_ASISTENTE = 30;
/** Un link de video con esto ("recordame ver esto el finde") va como link para agendar, no para resumir. */
const PIDE_RECORDAR = /\b(recorda|recordame|recordamelo|avisame|agenda|agendame|agendalo)\b/;
const PIDE_TEXTO_COMPLETO = /^(el |todo el )?(texto completo|transcripcion|texto|todo el texto|que dice)$/;
const TERMINA_EN_PREGUNTA = /\?[\s\p{Extended_Pictographic}\uFE0F\u200D]*$/u;

/** Registra un mensaje con el chat y el autor del contexto actual. */
const registrarAqui = (m: Parameters<typeof registrarMensaje>[0]) =>
  registrarMensaje({ chat: chat(), autor: m.direccion === "entrante" ? (contexto.getStore()?.autor ?? null) : null, ...m });

/** "guardala como nota", "anotá esto": la foto va a notas y no a recordatorios. */
const PIDE_NOTA = /\b(nota|anota|anotala|anotalo)\b/;

/** Si falta más que esto, al confirmar un evento se ofrece un aviso previo. */
const HORAS_OFRECER_PREVIO = 3;
const MAX_OPCIONES_ENCUESTA = 12;
const HORAS_BORRADOR = 24;

type DatosBorrador = {
  adjuntoId?: number | null;
  /** Link que mandó el usuario (va en el recordatorio para que el aviso lo traiga). */
  url?: string | null;
  titulo?: string | null;
  descripcion?: string;
  /** El link no se pudo leer y se pidió una captura: la próxima foto lo hereda. */
  esperaCaptura?: boolean;
  propuesta?: { titulo: string; fechaHora: string; avisosPreviosMin: number[]; descripcion: string | null } | null;
  /** Lo que se ofreció guardar del resumen de un video (los links en Mis links, o una nota). */
  guardar?: { links: { concepto: string; url: string }[]; nota: { titulo: string; contenido: string; categoria: string } | null };
  /** Todo lo que se dice en el video resumido (se manda si piden "texto completo"). */
  transcripcion?: string | null;
  /**
   * Un pago para marcar (de la foto de un comprobante o de «pagué la luz»): de cuál es (null: se preguntó cuál), cuánto
   * y cuándo. eligiendoForma: se preguntó con qué se pagó.
   */
  pago?: { registroId: number | null; monto: number; fecha: string | null; eligiendoForma?: boolean };
};

/** "¿Es el ABL de Casa?" después de la foto de un comprobante. */
const OPCIONES_PAGO = ["✅ Sí, es ese", "❌ No, es otro"];

/** El link normalizado, o null si no es un link web. */
function urlSegura(url: string): string | null {
  try {
    return urlValida(url);
  } catch {
    return null;
  }
}

/** Agrega el link al final de la descripción (si no está). */
function conLink(descripcion: string | null | undefined, url: string | null | undefined): string | null {
  const d = descripcion?.trim() || "";
  if (!url || d.includes(url)) return d || null;
  return d ? `${d}\n🔗 ${url}` : `🔗 ${url}`;
}

function vistaPrevia(msg: WAMessage): VistaPreviaWa | null {
  const e = msg.message?.extendedTextMessage;
  if (!e?.title && !e?.description && !e?.jpegThumbnail?.length) return null;
  return { titulo: e.title ?? null, descripcion: e.description ?? null, miniatura: e.jpegThumbnail?.length ? Buffer.from(e.jpegThumbnail) : null };
}

async function guardarBorrador(datos: DatosBorrador): Promise<number> {
  // Una sola propuesta abierta por chat. En grupos dura poco, para no tomar un "dale" de otra charla.
  await db.delete(borradorPendiente).where(filtroChat(borradorPendiente.chat, chat()));
  const ms = enGrupo() ? MINUTOS_BORRADOR_GRUPO * 60_000 : HORAS_BORRADOR * 3_600_000;
  const [b] = await db.insert(borradorPendiente).values({ tipo: "foto", datos, chat: chat(), expiraEn: new Date(Date.now() + ms) }).returning();
  return b.id;
}

/** Lo que falta pagar del mes, para que la IA reconozca una boleta o un comprobante en una foto. */
async function textoPagosPendientes(): Promise<string> {
  const pendientes = await pagosPendientes().catch(() => [] as ItemPago[]);
  return pendientes
    .slice(0, 60)
    .map((i) => `${i.id} | ${i.nombre} · ${i.lugar} | ${i.cuenta || "-"} | ${plata(i.falta || i.monto, i.moneda)} | ${i.vence ?? "sin vencimiento"}`)
    .join("\n");
}

// ───────────── Helpers de texto ─────────────

/** "Agendado 👌 / 📌 *Título* / 🗓️ Viernes 30/10 · 9:00 / 🔔 También te aviso…". */
async function textoConfirmacion(r: Recordatorio, conIntro = true): Promise<string> {
  const cfg = await obtenerConfig();
  const texto = renderizar(plantillasDe(cfg).confirmacion, {
    intro: conIntro ? frases.intro() : "",
    titulo: r.titulo,
    cuando: cuandoBonito(r),
    previos: textoPrevios(r),
    hora: aLocal(r.proximaInstancia ?? r.fechaHora).toFormat("H:mm"),
    fecha: aLocal(r.proximaInstancia ?? r.fechaHora).toFormat("dd/MM"),
    descripcion: r.descripcion ?? "",
    nombre: cfg.nombreUsuario,
  });
  return texto.trim();
}

/** A un turno o evento sin aviso previo, y con tiempo, se le ofrece uno. */
function convieneOfrecerPrevio(r: Recordatorio, esEvento: boolean): boolean {
  if (!esEvento || r.rrule || r.avisosPreviosMin.some((m) => m > 0)) return false;
  return (r.proximaInstancia ?? r.fechaHora).getTime() - Date.now() > HORAS_OFRECER_PREVIO * 3_600_000;
}

function fechaDe(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = DateTime.fromISO(iso, { zone: ahora().zone });
  return d.isValid ? d.toJSDate() : null;
}

function textoMensaje(msg: WAMessage): string | null {
  const m = msg.message;
  return m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? null;
}

function idCitado(msg: WAMessage): string | null {
  const m = msg.message;
  return m?.extendedTextMessage?.contextInfo?.stanzaId ?? m?.imageMessage?.contextInfo?.stanzaId ?? m?.audioMessage?.contextInfo?.stanzaId ?? null;
}

// ───────────── Borradores (propuestas de fotos) ─────────────

async function borradorActivo(id?: number) {
  const [b] = await db
    .select()
    .from(borradorPendiente)
    .where(and(gt(borradorPendiente.expiraEn, new Date()), filtroChat(borradorPendiente.chat, chat()), id ? eq(borradorPendiente.id, id) : undefined))
    .orderBy(desc(borradorPendiente.id))
    .limit(1);
  return b ? { id: b.id, datos: b.datos as unknown as DatosBorrador } : null;
}

async function cerrarBorrador(id: number) {
  await db.delete(borradorPendiente).where(eq(borradorPendiente.id, id));
}

/** msg: el mensaje al que se reacciona con ✅ si se marca algo como hecho. */
type Ctx = { ocCitada: number | null; borrador: Awaited<ReturnType<typeof borradorActivo>>; msg: WAMessage };

/** Lo que necesita la IA para un mensaje (conIA). */
type DatosIA = Ctx & {
  texto: string;
  entranteId: number;
  historial: Awaited<ReturnType<typeof ultimosMensajes>>;
  citadoFila: typeof mensaje.$inferSelect | null;
  /** Lo que entendió de un audio, para mostrarlo en el grupo. */
  eco?: string;
  /** Es uno guardado mientras la IA no andaba que se hace ahora: cuándo llegó. */
  enviadoEn?: Date;
};

/** Lo guardado mientras la IA no andaba se hace solo si llegó hace menos de esto. */
const HORAS_PENDIENTE_IA = 24;

// ───────────── Procesador ─────────────

export class Procesador {
  constructor(private canal: CanalBot) {}

  private async decir(texto: string, extra: { recordatorioId?: number | null; intencion?: string } = {}): Promise<void> {
    await this.decirConId(texto, extra);
  }

  /** Como decir, pero devuelve el id del mensaje de WhatsApp (para poder reconocer las respuestas). */
  private async decirConId(texto: string, extra: { recordatorioId?: number | null; intencion?: string } = {}): Promise<string | null> {
    // En grupos se responde citando el mensaje, para que se entienda a quién.
    const id = await this.canal.responder(texto, chat(), enGrupo() ? contexto.getStore()?.msg : undefined);
    await registrarAqui({
      direccion: "saliente",
      texto,
      waMessageId: id,
      recordatorioId: extra.recordatorioId ?? null,
      intencionDetectada: extra.intencion ?? null,
    });
    return id;
  }

  /**
   * Una confirmación sin nada nuevo que contar ("guardé la nota"): solo una reacción a tu mensaje. En el historial queda
   * el emoji con qué se hizo; si WhatsApp no deja reaccionar, va el texto.
   */
  private async reaccionarODecir(emoji: string, que: string, texto: string, intencion: string) {
    const msg = contexto.getStore()?.msg;
    if (msg?.key.id)
      try {
        await this.canal.reaccionar(msg, emoji);
        await registrarAqui({ direccion: "saliente", tipo: "reaccion", texto: `${emoji} ${que}`, intencionDetectada: intencion });
        return;
      } catch (err) {
        await registrar("aviso", "bot", "No se pudo reaccionar: va el texto", err);
      }
    return this.decir(texto, { intencion });
  }

  /** Manda una encuesta (si están activadas). Devuelve false si no se pudo, para contestar con texto. */
  private async encuesta(nombre: string, opciones: string[], accion: AccionEncuesta, extra: { recordatorioId?: number | null } = {}): Promise<boolean> {
    const cfg = await obtenerConfig();
    if (!cfg.usarEncuestas || opciones.length < 2 || opciones.length > MAX_OPCIONES_ENCUESTA) return false;
    try {
      const r = await this.canal.responderEncuesta(sinFormato(nombre), opciones, chat());
      if (!r.id) return false;
      await registrarEncuesta({ waMessageId: r.id, chat: chat(), secreto: r.secreto, opciones, accion });
      await registrarAqui({
        direccion: "saliente",
        tipo: "encuesta",
        texto: `📊 ${sinFormato(nombre)}\n${opciones.map((o) => `• ${o}`).join("\n")}`,
        waMessageId: r.id,
        recordatorioId: extra.recordatorioId ?? null,
        ocurrenciaId: accion.tipo === "aviso" ? accion.ocurrenciaId : null,
        intencionDetectada: "encuesta",
      });
      return true;
    } catch (err) {
      await registrar("aviso", "bot", "No se pudo mandar la encuesta", err);
      return false;
    }
  }

  async procesar(msg: WAMessage, origen: OrigenMensaje = { grupo: null, autor: null }): Promise<void> {
    const [g] = origen.grupo ? await db.select({ compras: grupo.compras }).from(grupo).where(eq(grupo.jid, origen.grupo.jid)) : [];
    const compras = !!g?.compras;
    return contexto.run({ ...origen, msg, compras }, () => this.procesarAqui(msg));
  }

  private async procesarAqui(msg: WAMessage): Promise<void> {
    const m = msg.message;
    if (!m) return;
    if (m.reactionMessage) return this.reaccion(msg);
    if (m.pollUpdateMessage) return this.voto(msg);
    if (enCompras() && (m.imageMessage || documentoDe(msg))) return this.avisarFacturasEnErp(msg);
    if (m.imageMessage) return this.foto(msg);
    if (documentoDe(msg)) return this.documento(msg);
    if (m.audioMessage) return this.audio(msg);
    if (m.videoMessage && !enGrupo()) return this.videoArchivo(msg);
    const texto = textoMensaje(msg);
    if (texto?.trim()) return this.texto(msg, texto.trim());
    await registrarAqui({ direccion: "entrante", tipo: "otro", texto: null, waMessageId: msg.key.id });
    if (m.stickerMessage || enGrupo()) return;
    await this.decir("Por ahora entiendo texto, audios, fotos, videos y links 🙂");
  }

  /** Audio: se transcribe con Groq, se muestra lo entendido y se procesa como texto. */
  private async audio(msg: WAMessage) {
    const a = msg.message!.audioMessage!;
    const cfg = await obtenerConfig();
    const segundos = Number(a.seconds ?? 0);
    if (segundos > cfg.audioMaxSegundos) {
      if (enGrupo()) return; // En el grupo no se reclaman audios largos de la charla.
      await registrarAqui({ direccion: "entrante", tipo: "audio", texto: null, waMessageId: msg.key.id });
      const max = cfg.audioMaxSegundos >= 60 ? `${Math.round(cfg.audioMaxSegundos / 60)} min` : `${cfg.audioMaxSegundos} s`;
      return this.decir(`Ese audio es muy largo (máximo ${max}). ¿Me lo mandás más corto o por partes?`);
    }
    let transcripcion: string;
    try {
      const datos = await this.canal.descargarMedia(msg);
      transcripcion = await transcribir(cfg, datos, a.mimetype ?? "audio/ogg");
    } catch (err) {
      await registrarAqui({ direccion: "entrante", tipo: "audio", texto: null, waMessageId: msg.key.id });
      await registrar("error", "audio", "No se pudo transcribir el audio", err);
      if (enGrupo()) return;
      if (err instanceof ErrorAudio && /falta/i.test(err.message))
        return this.decir("Para entender audios falta cargar la clave de Groq en el panel (Configuración → Audios).");
      return this.decir("No pude entender el audio 😕. ¿Me lo repetís o me lo escribís?");
    }
    if (!transcripcion) {
      await registrarAqui({ direccion: "entrante", tipo: "audio", texto: null, waMessageId: msg.key.id });
      if (enGrupo()) return;
      return this.decir("No escuché nada en ese audio 🤔. ¿Me lo mandás de nuevo?");
    }
    const eco = `🎙️ Entendí: “${transcripcion}”`;
    // En el grupo, lo que entendió se muestra solo si el audio era para el bot.
    if (enGrupo()) return this.texto(msg, transcripcion, "audio", eco);
    await this.decir(eco, { intencion: "transcripcion" });
    return this.texto(msg, transcripcion, "audio");
  }

  private async reaccion(msg: WAMessage) {
    const r = msg.message!.reactionMessage!;
    const emoji = r.text ?? "";
    await registrarAqui({ direccion: "entrante", tipo: "reaccion", texto: emoji, waMessageId: msg.key.id });
    if (!EMOJIS_CONFIRMACION.includes(emoji) || !r.key?.id) return;
    const original = await mensajePorWaId(r.key.id);
    if (original?.suscripcionId) return this.contestarSuscripcion(original.suscripcionId, "renovar");
    // Su propia reacción ya muestra que quedó hecho: no se contesta.
    if (original?.ocurrenciaId) await confirmarOcurrencia(original.ocurrenciaId);
  }

  /** Voto en una encuesta del bot: se toma el primero y se responde corto. */
  private async voto(msg: WAMessage) {
    const pu = msg.message!.pollUpdateMessage!;
    const id = pu.pollCreationMessageKey?.id;
    if (!id || !pu.vote) return;
    const enc = await encuestaPorWaId(id);
    if (!enc || (enc.chat ?? null) !== chat()) return;
    const votadas = this.canal.descifrarVoto(msg, enc.secreto);
    if (!votadas) return void (await registrar("aviso", "bot", "No se pudo leer un voto de encuesta"));
    const elegida = opcionElegida(enc.opciones, votadas);
    if (elegida < 0) return; // Sacó el voto.
    if (!(await marcarRespondida(enc.id))) return; // Ya se había votado.
    await registrarAqui({ direccion: "entrante", tipo: "voto", texto: enc.opciones[elegida], waMessageId: msg.key.id, intencionDetectada: "voto" });
    const a = enc.accion;
    // Al votar no hay mensaje del usuario al que reaccionar: se reacciona sobre la encuesta.
    const encuesta: WAMessage = { key: { remoteJid: msg.key.remoteJid, id, fromMe: true } };
    switch (a.tipo) {
      case "aviso": {
        if (elegida === 0) return this.confirmar(a.ocurrenciaId, encuesta);
        const cfg = await obtenerConfig();
        const [h, mi] = cfg.horaDefecto.split(":").map(Number);
        const hasta =
          elegida === 1
            ? new Date(Date.now() + 15 * 60_000)
            : elegida === 2
              ? new Date(Date.now() + 60 * 60_000)
              : ahora().plus({ days: 1 }).set({ hour: h || 9, minute: mi || 0, second: 0, millisecond: 0 }).toJSDate();
        return this.posponerA(a.ocurrenciaId, hasta);
      }
      case "propuesta": {
        const b = await borradorActivo(a.borradorId);
        if (!b) return this.decir(frases.yaCerrado());
        if (elegida === 0 && b.datos.propuesta) return this.aceptarBorrador(b.id, b.datos);
        if (elegida === 2) return this.rechazarBorrador(b.id, b.datos);
        return this.decir(frases.otraFecha(), { intencion: "falta_info" }); // El borrador queda: la fecha que diga lo usa.
      }
      case "elegir": {
        const recId = a.ids[elegida];
        if (!recId) return;
        const interp = { ...(a.interpretacion as unknown as Interpretacion), recordatorio_ids: [recId] };
        return this.ejecutarSeguro(interp, { ocCitada: null, borrador: await borradorActivo(), msg: encuesta });
      }
      case "suscripcion":
        return this.contestarSuscripcion(a.suscripcionId, elegida === 0 ? "renovar" : "recordar");
      case "pago": {
        const b = await borradorActivo(a.borradorId);
        if (!b?.datos.pago) return this.decir(frases.yaCerrado());
        if (elegida === 0 && b.datos.pago.registroId) return this.pagoDeFoto(b.id, b.datos, b.datos.pago.registroId);
        await guardarBorrador({ ...b.datos, pago: { ...b.datos.pago, registroId: null } });
        return this.decir("Ok. ¿De cuál de tus pagos es? Decime, por ejemplo, «es la luz del Express 1».", { intencion: "falta_info" });
      }
      case "formaPago": {
        const b = await borradorActivo(a.borradorId);
        const registroId = b?.datos.pago?.registroId;
        if (!b || !registroId) return this.decir(frases.yaCerrado());
        return this.pagoDeFoto(b.id, b.datos, registroId, a.formaIds[elegida]);
      }
    }
  }

  /**
   * El que era el grupo de compras: a la primera foto o PDF se le avisa que las facturas ahora se cargan en el ERP,
   * y pasa a ser un grupo normal (solo responde si le piden algo).
   */
  private async avisarFacturasEnErp(msg: WAMessage) {
    await registrarAqui({ direccion: "entrante", tipo: msg.message!.imageMessage ? "imagen" : "otro", texto: null, waMessageId: msg.key.id });
    await db.update(grupo).set({ compras: false }).where(eq(grupo.jid, chat()!));
    return this.decir(AVISO_FACTURAS);
  }

  /** Documento: en privado, un PDF suele ser una factura (ahora van al ERP). En grupos no se usan. */
  private async documento(msg: WAMessage) {
    await registrarAqui({ direccion: "entrante", tipo: "otro", texto: null, waMessageId: msg.key.id });
    if (enGrupo()) return;
    return this.decir(AVISO_FACTURAS);
  }

  private async foto(msg: WAMessage) {
    const img = msg.message!.imageMessage!;
    const cfg = await obtenerConfig();
    const epigrafe = img.caption?.trim() || null;
    // En el grupo, solo las fotos que le piden al bot ("recordanos esto").
    if (enGrupo() && !(epigrafe && PIDE_BOT.test(normalizar(epigrafe)))) {
      await registrarAqui({ direccion: "entrante", tipo: "imagen", texto: epigrafe, waMessageId: msg.key.id });
      return;
    }
    const mime = (img.mimetype ?? "image/jpeg").split(";")[0];
    const tamano = Number(img.fileLength ?? 0);
    if (tamano > cfg.fotoMaxMb * 1024 * 1024) {
      await registrarAqui({ direccion: "entrante", tipo: "imagen", texto: epigrafe, waMessageId: msg.key.id });
      return this.decir(`Esa foto es muy pesada (máximo ${cfg.fotoMaxMb} MB). ¿Me la mandás más chica?`);
    }
    let datos: Buffer;
    try {
      datos = await this.canal.descargarMedia(msg);
    } catch (err) {
      await registrar("error", "bot", "No se pudo descargar la foto", err);
      return this.decir("No pude bajar la foto 😕. ¿Me la mandás de nuevo?");
    }
    const previo = await borradorActivo();
    const url = previo?.datos.esperaCaptura ? (previo.datos.url ?? null) : null;
    const mimeFoto = MIMES_IMAGEN.includes(mime) ? mime : "image/jpeg";
    const adj = await guardarImagen(datos, mimeFoto);
    await registrarAqui({ direccion: "entrante", tipo: "imagen", texto: epigrafe, waMessageId: msg.key.id, adjuntoId: adj.id });

    if (!enGrupo() && epigrafe && PIDE_NOTA.test(normalizar(epigrafe))) return this.fotoComoNota(adj.id, datos, epigrafe);

    let datosBorrador: DatosBorrador = { adjuntoId: adj.id, url };
    let respuesta: string;
    let a: AnalisisFoto | null = null;
    try {
      const liviana = await imagenParaIa(datos);
      a = await analizarFoto(cfg, liviana.datos, liviana.mime, epigrafe, enGrupo() ? "" : await textoPagosPendientes());
      await db.update(adjunto).set({ descripcionIa: a.descripcion, datosExtraidos: a }).where(eq(adjunto.id, adj.id));
    } catch {
      // Sin IA, se guarda igual y se pregunta cuándo recordarla.
    }
    // La boleta o el comprobante de uno de tus pagos del mes va a Pagos (no a recordatorios).
    if (a && !enGrupo() && (a.tipo === "comprobante" || (a.tipo === "factura" && a.pago_id))) return this.fotoDePago(a, adj.id);
    if (a) {
      const fecha = fechaDe(a.propuesta_fecha_hora);
      datosBorrador = {
        adjuntoId: adj.id,
        url,
        descripcion: a.descripcion,
        propuesta:
          a.util && fecha && fecha.getTime() > Date.now()
            ? {
                titulo: a.titulo ?? a.descripcion,
                fechaHora: fecha.toISOString(),
                avisosPreviosMin: a.propuesta_avisos_previos_min,
                descripcion: conLink([a.monto && `Monto: ${a.monto}`, a.lugar && `Lugar: ${a.lugar}`].filter(Boolean).join(" · "), url),
              }
            : null,
      };
      respuesta = a.mensaje;
    } else respuesta = "Guardé la foto 📎. ¿Cuándo querés que te la recuerde?";
    const borradorId = await guardarBorrador(datosBorrador);
    await this.proponer(respuesta, borradorId, !!datosBorrador.propuesta, "propuesta_foto");
  }

  /** Boleta: anota el monto y el vencimiento del mes. Comprobante: pregunta si es ese pago (o cuál es) y lo marca con la foto. */
  private async fotoDePago(a: AnalisisFoto, adjuntoId: number) {
    const p = (await pagosPendientes()).find((i) => i.id === a.pago_id);
    const fecha = fechaDe(a.fecha_evento);
    const fechaIso = fecha ? aLocal(fecha).toISODate() : null;
    if (a.tipo === "factura" && p) {
      const r = await actualizarPagoDelMes(p.id, { ...(a.monto_numero > 0 ? { monto: a.monto_numero } : {}), ...(fechaIso ? { vence: fechaIso } : {}) });
      await borrarAdjunto(adjuntoId);
      const cuando = r.vence ? `, ${cuandoVence(r.vence)}. Te aviso antes.` : ".";
      return this.decir(`📄 Anoté la boleta de *${r.nombre} · ${r.lugar}*: ${plata(r.monto, r.moneda)}${cuando}`, { intencion: "pago_boleta" });
    }
    const borradorId = await guardarBorrador({ adjuntoId, pago: { registroId: p?.id ?? null, monto: a.monto_numero, fecha: fechaIso } });
    const vi = `🧾 Veo un pago${a.monto_numero > 0 ? ` de ${plata(a.monto_numero)}` : ""}${fechaIso ? ` del ${diaDe(fechaIso).toFormat("dd/MM")}` : ""}.`;
    if (!p) return this.decir(`${vi} ¿De cuál de tus pagos es? Decime, por ejemplo, «es la luz del Express 1».`, { intencion: "falta_info" });
    const pregunta = `${vi} ¿Es ${p.nombre} · ${p.lugar} (${plata(p.falta || p.monto, p.moneda)})?`;
    if (await this.encuesta(pregunta, OPCIONES_PAGO, { tipo: "pago", borradorId })) return;
    return this.decir(`${pregunta} Respondé *sí* o decime cuál es.`, { intencion: "falta_info" });
  }

  /**
   * Marca el pago con el monto y la fecha (los de la foto, si vino de un comprobante, que se guarda cifrado). Si no se
   * sabe con qué se pagó (ni lo dijo ni el pago tiene una forma de siempre), primero lo pregunta.
   */
  private async pagoDeFoto(borradorId: number, d: DatosBorrador, registroId: number, formaElegida?: number) {
    const p = (await pagosPendientes()).find((i) => i.id === registroId);
    if (!p) return this.decir("🤔 Ese pago ya no está entre lo que falta pagar.");
    const formaId = formaElegida ?? p.formaId;
    if (!formaId) return this.preguntarForma(d, p);
    let hecho: ItemPago;
    try {
      hecho = await registrarPago(registroId, { formaId, ...(d.pago!.monto > 0 ? { monto: d.pago!.monto } : {}), ...(d.pago!.fecha ? { fecha: d.pago!.fecha } : {}) });
    } catch (err) {
      if (err instanceof ErrorUsuario) return this.decir(`🤔 ${err.message}`);
      throw err;
    }
    const adj = d.adjuntoId ? await obtenerAdjunto(d.adjuntoId) : null;
    if (adj) {
      await guardarComprobante(registroId, await fs.readFile(adj.rutaArchivo), adj.mime);
      await borrarAdjunto(adj.id);
    }
    await cerrarBorrador(borradorId);
    const faltan = (await pagosPendientes()).filter((i) => i.mesPago === hecho.mesPago);
    const parte = hecho.estado === "parcial" ? ` (en parte: faltan ${plata(hecho.falta, hecho.moneda)})` : "";
    const resto = faltan.length
      ? `Te falta: ${faltan
          .slice(0, 5)
          .map((i) => `${i.nombre} · ${i.lugar}`)
          .join(", ")}${faltan.length > 5 ? "…" : ""}.`
      : "Ya pagaste todo lo del mes 🙌";
    const con = [hecho.forma && `con ${hecho.forma}`, adj && "comprobante guardado"].filter(Boolean).join(", ");
    return this.decir(`✅ Anotado: *${hecho.nombre} · ${hecho.lugar}* ${plata(hecho.pagado, hecho.moneda)}${parte}${con ? ` (${con})` : ""}.\n${resto}`, { intencion: "pago_registrado" });
  }

  /** «¿Con qué pagaste…?»: una encuesta con las formas de pago (o la lista, si no hay encuestas o son muchas). */
  private async preguntarForma(d: DatosBorrador, p: ItemPago) {
    const formas = await formasActivas();
    if (!formas.length) return this.decir("🤔 Para anotarlo me falta con qué lo pagaste: cargá tus formas de pago en el panel, en Pagos → Configuración.");
    const borradorId = await guardarBorrador({ ...d, pago: { monto: 0, fecha: null, ...d.pago, registroId: p.id, eligiendoForma: true } });
    const pregunta = `💳 ¿Con qué pagaste ${p.nombre} · ${p.lugar}?`;
    // WhatsApp acepta hasta 12 opciones por encuesta.
    if (formas.length <= 12 && (await this.encuesta(pregunta, formas.map((f) => f.nombre), { tipo: "formaPago", borradorId, formaIds: formas.map((f) => f.id) }))) return;
    return this.decir(`${pregunta} Decime cuál: ${formas.map((f) => f.nombre).join(", ")}.`, { intencion: "falta_info" });
  }

  /** Mensaje con la propuesta y, si hay una fecha propuesta, la encuesta para responder con un toque. */
  private async proponer(texto: string, borradorId: number, conPropuesta: boolean, intencion: string) {
    await this.decir(texto, { intencion });
    if (conPropuesta) await this.encuesta("¿Lo agendo?", OPCIONES_PROPUESTA, { tipo: "propuesta", borradorId });
  }

  /** Foto con "guardala como nota": la IA lee el texto de la imagen y se guarda en notas. */
  private async fotoComoNota(adjuntoId: number, datos: Buffer, epigrafe: string) {
    const cfg = await obtenerConfig();
    let titulo = epigrafe.slice(0, 60);
    let contenido = epigrafe;
    let categoria = "otros";
    try {
      const liviana = await imagenParaIa(datos);
      const a = await analizarFoto(cfg, liviana.datos, liviana.mime, epigrafe);
      await db.update(adjunto).set({ descripcionIa: a.descripcion, datosExtraidos: a }).where(eq(adjunto.id, adjuntoId));
      titulo = a.titulo ?? a.descripcion;
      contenido = [epigrafe, a.descripcion, a.texto_visible].filter(Boolean).join("\n");
      categoria = { factura: "documentos", turno: "salud", entrada: "ideas", invitacion: "ideas", receta: "compras" }[a.tipo as string] ?? "otros";
    } catch {
      // Sin IA, se guarda igual con el texto del pie.
    }
    const n = await crearNota({ titulo, contenido, categoria, adjuntoId });
    return this.reaccionarODecir("🗒️", `Nota guardada: ${n.titulo}`, `🗒️ Guardé la nota *${n.titulo}* con la foto. Cuando la necesites, preguntame.`, "nota_guardar");
  }

  private async texto(msg: WAMessage, texto: string, tipo: "texto" | "audio" = "texto", eco?: string) {
    const historial = await ultimosMensajes(5, chat());
    const citado = idCitado(msg);
    const citadoFila = citado ? await mensajePorWaId(citado) : null;
    const ocCitada = citadoFila?.ocurrenciaId ?? null;
    const entrante = await registrarAqui({ direccion: "entrante", texto, tipo, waMessageId: msg.key.id });
    // ¿Contesta una pregunta del bot? Citándola, siempre; si no, si fue lo último que dijo el bot y hace poco.
    const ultimaDelBot = historial.findLast((m) => m.direccion === "saliente");
    const respondePregunta =
      citadoFila?.intencionDetectada === "falta_info" ||
      (!citadoFila &&
        ultimaDelBot?.intencionDetectada === "falta_info" &&
        entrante.creadoEn.getTime() - ultimaDelBot.creadoEn.getTime() <= MINUTOS_RESPUESTA_A_PREGUNTA * 60_000);
    const anotar = (intencion: string) =>
      db.update(mensaje).set({ intencionDetectada: intencion }).where(eq(mensaje.id, entrante.id));

    // 0) Respuesta al aviso de una suscripción ("renovada", "mañana"): citándolo, o si fue lo último que mandó el bot.
    const suscripcionId =
      citadoFila?.suscripcionId ??
      (!citadoFila && ultimaDelBot?.suscripcionId && entrante.creadoEn.getTime() - ultimaDelBot.creadoEn.getTime() <= HORAS_RESPUESTA_A_SUSCRIPCION * 3_600_000
        ? ultimaDelBot.suscripcionId
        : null);
    const accionSuscripcion = suscripcionId ? respuestaASuscripcion(texto) : null;
    if (suscripcionId && accionSuscripcion) {
      await anotar(accionSuscripcion === "renovar" ? "renovar_suscripcion" : "recordar_suscripcion");
      return this.contestarSuscripcion(suscripcionId, accionSuscripcion);
    }

    // 1) Respuesta a una pregunta del asistente ("¿Lo mando?" → "sí"): sigue la charla con él, sin pasar por los
    // comandos. Si fue lo último que dijo el bot y hace poco (o citándola). Un link de video no es una respuesta: se resume.
    const urls = extraerUrls(texto);
    const delAsistente = citadoFila ?? ultimaDelBot;
    if (
      !enGrupo() &&
      !(urls.length && esLinkDeVideo(urls[0])) &&
      delAsistente?.direccion === "saliente" &&
      delAsistente.intencionDetectada === "agente" &&
      TERMINA_EN_PREGUNTA.test(delAsistente.texto ?? "") &&
      (citadoFila || entrante.creadoEn.getTime() - delAsistente.creadoEn.getTime() <= MINUTOS_RESPUESTA_AL_ASISTENTE * 60_000)
    ) {
      await anotar("agente");
      if (eco) await this.decir(eco, { intencion: "transcripcion" });
      return this.consultarAgente(texto, entrante.id);
    }

    // 2) "Mis links" (en privado): guardar uno o buscarlo. Va antes que el análisis de links.
    const pedido = enGrupo() ? null : pedidoDeLinks(textoSinUrls(texto), urls.length > 0);
    if (pedido && (await this.misLinks(pedido, urls[0]))) return void (await anotar("links"));

    // 3) Links: se leen y se analizan.
    if (urls.length) {
      // En el grupo, un link compartido sin pedirle nada al bot es charla.
      if (enGrupo() && !PIDE_BOT.test(normalizar(textoSinUrls(texto)))) return void (await anotar("ignorar"));
      // Reels, TikTok, Shorts: en privado se resumen (salvo que pida agendarlo).
      if (!enGrupo() && esLinkDeVideo(urls[0]) && !PIDE_RECORDAR.test(normalizar(textoSinUrls(texto)))) {
        await anotar("video");
        return this.video({ url: urls[0] }, msg, urls[0]);
      }
      await anotar("enlace");
      return this.enlace(msg, urls[0], textoSinUrls(texto) || null);
    }

    // 4) Respuesta rápida a una propuesta (foto o link).
    const borrador = await borradorActivo();
    // Un pago para marcar: "sí" (es ese), "no" (pregunta cuál), cuál es ("es la luz del Express 1") o con qué se pagó.
    const pagoFoto = !enGrupo() ? borrador?.datos.pago : undefined;
    if (borrador && pagoFoto) {
      if (pagoFoto.eligiendoForma) {
        // Contestó con qué pagó (en lugar de votar la encuesta). Si no nombra una forma, sigue como un mensaje cualquiera.
        const forma = pagoFoto.registroId ? await buscarForma(texto) : undefined;
        if (forma) return void (await anotar("pago_registrado"), await this.pagoDeFoto(borrador.id, borrador.datos, pagoFoto.registroId!, forma.id));
      } else {
        if (pagoFoto.registroId && esAfirmativo(texto)) return void (await anotar("pago_registrado"), await this.pagoDeFoto(borrador.id, borrador.datos, pagoFoto.registroId));
        if (pagoFoto.registroId && esNegativo(texto)) {
          await anotar("falta_info");
          await guardarBorrador({ ...borrador.datos, pago: { ...pagoFoto, registroId: null } });
          return this.decir("Ok. ¿De cuál de tus pagos es? Decime, por ejemplo, «es la luz del Express 1».", { intencion: "falta_info" });
        }
        const candidatos = await buscarPendientes(texto);
        if (candidatos.length === 1) return void (await anotar("pago_registrado"), await this.pagoDeFoto(borrador.id, borrador.datos, candidatos[0].id));
        if (candidatos.length > 1)
          return this.decir(`¿Cuál de estos? ${candidatos.map((i) => `${i.nombre} · ${i.lugar}`).join(", ")}`, { intencion: "falta_info" });
        // No coincide con ninguno: sigue como un mensaje cualquiera.
      }
    }
    if (borrador?.datos.transcripcion && PIDE_TEXTO_COMPLETO.test(normalizar(texto))) {
      await anotar("texto_completo");
      return this.decir(`📝 *Lo que se dice en el video:*\n${borrador.datos.transcripcion}`, { intencion: "texto_completo" });
    }
    if (borrador?.datos.guardar && esAfirmativo(texto)) {
      await anotar("aceptar_propuesta");
      return this.guardarDelVideo(borrador.id, borrador.datos.guardar);
    }
    if (borrador?.datos.propuesta && esAfirmativo(texto)) {
      await anotar("aceptar_propuesta");
      return this.aceptarBorrador(borrador.id, borrador.datos);
    }
    if (borrador && esNegativo(texto)) {
      await anotar("rechazar_propuesta");
      return this.rechazarBorrador(borrador.id, borrador.datos);
    }

    // 5) Comandos rápidos sin IA. Si responde a un aviso ("mañana", "en 2 horas"), lo interpreta la IA como posponer;
    // si contesta una pregunta del bot ("¿para qué día?" → "hoy"), la IA lo toma como la respuesta.
    const comando = detectarComando(texto);
    // En el grupo, "hoy", "lista", etc. pueden ser charla: los interpreta la IA. "listo" confirma solo si hay un aviso esperando.
    let cmd = (ocCitada || respondePregunta) && comando?.tipo === "listar" ? null : comando;
    if (enGrupo() && cmd) {
      const esperando = cmd.tipo === "confirmar" && (ocCitada || (await ultimaOcurrenciaEnviada(undefined, chat(), true)));
      cmd = esperando ? cmd : null;
    }
    if (cmd) {
      await anotar(cmd.tipo);
      switch (cmd.tipo) {
        case "listar": {
          const t =
            cmd.rango === "todos"
              ? await textoTodos(chat())
              : await textoListado(cmd.rango === "hoy" ? rangoHoy() : cmd.rango === "manana" ? rangoManana() : rangoSemana(), chat());
          return this.decir(t, { intencion: "listar" });
        }
        case "ayuda":
          return this.decir(TEXTO_AYUDA, { intencion: "ayuda" });
        case "notas":
          return this.decir(await this.textoNotas(), { intencion: "nota_consultar" });
        case "silencio": {
          const hasta = new Date(Date.now() + cmd.minutos * 60_000);
          await actualizarConfig({ botSilenciadoHasta: hasta });
          return this.decir(
            `🤫 Listo, no te mando avisos hasta ${formatearCuando(hasta)}. Lo que venza en ese rato te llega después.`,
            { intencion: "silencio" },
          );
        }
        case "fin_silencio":
          await actualizarConfig({ botSilenciadoHasta: null });
          return this.decir("🔔 Listo, vuelvo a mandarte los avisos.", { intencion: "silencio" });
        case "confirmar": {
          const oc = ocCitada ? { id: ocCitada } : await ultimaOcurrenciaEnviada(undefined, chat());
          if (!oc) {
            if (cmd.explicito) return this.decir(frases.nadaPendiente());
            return; // "ok" suelto: no hace falta responder.
          }
          return this.confirmar(oc.id, msg);
        }
      }
    }

    // 6) IA.
    return this.conIA({ texto, entranteId: entrante.id, historial, citadoFila, ocCitada, borrador, msg, eco });
  }

  /**
   * Lo que no es un comando lo interpreta la IA. Si la IA no anda (sin crédito, la clave, Anthropic caído), en privado
   * se guarda y se hace cuando vuelva (reanudarPendientes).
   */
  private async conIA(d: DatosIA): Promise<void> {
    const cfg = await obtenerConfig();
    // Con la IA caída se prueba si volvió (y se hace lo guardado, en orden); si no volvió, va directo a la cola.
    if (cfg.iaFalla && !enGrupo() && !d.enviadoEn && !(await revisarIA(true))) return this.guardarParaDespues(d, null);
    const texto = d.enviadoEn
      ? `${d.texto}\n\n(Esto lo mandé el ${aLocal(d.enviadoEn).toFormat("ccc dd/MM HH:mm", { locale: "es" })} y recién ahora lo podés hacer porque la IA no andaba: "hoy", "mañana" o "en una hora" cuentan desde ese momento.)`
      : d.texto;
    let interp: Interpretacion;
    try {
      interp = await interpretar(cfg, texto, await this.contexto(d.historial, d.borrador?.datos ?? null, d.citadoFila));
    } catch (err) {
      return this.falloIA(err, d);
    }
    await db.update(mensaje).set({ intencionDetectada: interp.intencion }).where(eq(mensaje.id, d.entranteId));
    if (interp.intencion === "ignorar") {
      if (enGrupo()) return; // Charla del grupo: no es para el bot.
      interp = { ...interp, intencion: "desconocido" }; // En privado siempre se contesta.
    }
    if (d.eco) await this.decir(d.eco, { intencion: "transcripcion" });
    // Lo que no es un pedido simple lo resuelve el asistente (solo en privado: en el grupo no ve tus cosas).
    if (interp.intencion === "consulta" && !enGrupo()) return this.consultarAgente(texto, d.entranteId, d);
    return this.ejecutarSeguro(interp, { ocCitada: d.ocCitada, borrador: d.borrador, msg: d.msg });
  }

  /**
   * La IA falló. En el grupo no se interrumpe la charla. En privado, si no depende del mensaje (sin crédito, la clave,
   * Anthropic caído), se explica la causa y, si viene de conIA (d), se guarda para cuando vuelva.
   */
  private async falloIA(err: unknown, d?: DatosIA, intencion = "error_ia"): Promise<void> {
    if (enGrupo()) return;
    const motivo = motivoFallaIA(err);
    if (!motivo) return this.decir(frases.errorTecnico(), { intencion });
    const nuevo = await anotarFallaIA(motivo);
    // Uno guardado que se estaba haciendo: queda guardado y se corta (reanudarPendientes).
    if (d?.enviadoEn) throw err;
    if (!d) return this.decir(textoFallaIA(motivo, false), { intencion });
    return this.guardarParaDespues(d, nuevo ? motivo : null);
  }

  /** Guarda el mensaje para cuando vuelva la IA. Con motivo, avisa la causa (una sola vez); si no, solo ⏳. */
  private async guardarParaDespues(d: DatosIA, motivo: MotivoFallaIA | null) {
    await db.insert(iaPendiente).values({ mensajeId: d.entranteId, clave: d.msg.key, ocurrenciaId: d.ocCitada, creadoEn: new Date() });
    await db.update(mensaje).set({ intencionDetectada: "pendiente_ia" }).where(eq(mensaje.id, d.entranteId));
    if (motivo) return this.decir(textoFallaIA(motivo, true), { intencion: "ia_caida" });
    return this.reaccionarODecir("⏳", "Guardado para cuando vuelva la IA", "⏳ Lo guardé: lo hago cuando vuelva la IA.", "pendiente_ia");
  }

  private reanudando: Promise<void> | null = null;
  /**
   * La IA volvió: hace en orden lo que llegó mientras no andaba y avisa lo que quedó viejo. Si se había terminado el
   * crédito, pregunta cuánto cargó (para el saldo y los avisos de que se acaba).
   */
  reanudarPendientes(motivoAnterior?: MotivoFallaIA): Promise<void> {
    this.reanudando ??= this.reanudarAqui(motivoAnterior === "sin_credito").finally(() => (this.reanudando = null));
    return this.reanudando;
  }

  private async reanudarAqui(preguntarCarga: boolean) {
    const filas = await db
      .select({ p: iaPendiente, m: mensaje })
      .from(iaPendiente)
      .innerJoin(mensaje, eq(mensaje.id, iaPendiente.mensajeId))
      .orderBy(asc(iaPendiente.id));
    if (!filas.length && !preguntarCarga) return;
    const limite = Date.now() - HORAS_PENDIENTE_IA * 3_600_000;
    const viejas = filas.filter((f) => f.p.creadoEn.getTime() < limite);
    const vigentes = filas.filter((f) => f.p.creadoEn.getTime() >= limite);
    const enPrivado = (msg: WAMessage, fn: () => Promise<void>) => contexto.run({ grupo: null, autor: null, msg, compras: false }, fn);
    await enPrivado({ key: filas[0]?.p.clave ?? {} }, async () => {
      if (vigentes.length)
        await this.decir(
          `✅ Volví a andar. Ahora hago ${vigentes.length === 1 ? "lo que me mandaste" : `las ${vigentes.length} cosas que me mandaste`} mientras no podía:`,
          { intencion: "ia_volvio" },
        );
      for (const f of vigentes) {
        const msg: WAMessage = { key: f.p.clave };
        try {
          await enPrivado(msg, async () => {
            await this.canal.reaccionar(msg, "").catch(() => {}); // Saca el ⏳.
            await this.conIA({
              texto: f.m.texto ?? "",
              entranteId: f.m.id,
              historial: await ultimosMensajes(5, null, "whatsapp", f.m.id),
              citadoFila: null,
              ocCitada: f.p.ocurrenciaId,
              borrador: null,
              msg,
              enviadoEn: f.p.creadoEn,
            });
          });
        } catch (err) {
          if (motivoFallaIA(err)) return; // Se volvió a caer: lo que falta queda guardado.
          await registrar("error", "bot", "Falló un mensaje guardado mientras no andaba la IA", err);
        }
        await db.delete(iaPendiente).where(eq(iaPendiente.id, f.p.id));
      }
      if (viejas.length) {
        const corto = (t: string) => (t.length > 80 ? `${t.slice(0, 79)}…` : t);
        const lista = viejas.map((f) => `• «${corto(f.m.texto ?? "")}» (${aLocal(f.p.creadoEn).toFormat("ccc dd/MM HH:mm", { locale: "es" })})`);
        await this.decir(
          `${vigentes.length ? "" : "✅ Volví a andar. "}Estos no los hice porque pasaron más de ${HORAS_PENDIENTE_IA} horas:\n${lista.join("\n")}\nSi todavía los necesitás, mandámelos de nuevo.`,
          { intencion: "ia_volvio" },
        );
        await db.delete(iaPendiente).where(inArray(iaPendiente.id, viejas.map((f) => f.p.id)));
      }
      // Como pregunta del asistente: la respuesta ("10 dólares") la anota él (herramienta credito_claude).
      if (preguntarCarga)
        await this.decir(
          "💳 Volvió el crédito de Claude. Para avisarte antes de que se vuelva a terminar, decime cuánto cargaste (por ejemplo «cargué 10 dólares»). ¿Cuánto fue?",
          { intencion: "agente" },
        );
    });
  }

  private async consultarAgente(texto: string, entranteId: number, d?: DatosIA) {
    try {
      const r = await preguntarAlAgente(texto, "whatsapp", entranteId);
      if ("tope" in r) return this.decir(textoTope(r.tope), { intencion: "agente_tope" });
      // Si solo confirma lo que hizo, contesta con un emoji: va como reacción.
      if (esSoloEmoji(r.texto)) await this.reaccionarODecir(r.texto.trim(), "Hecho", `${r.texto.trim()} Listo.`, "agente");
      else await this.decir(r.texto, { intencion: "agente" });
      // «Pagué la luz» sin decir con qué: va la encuesta de la forma de pago.
      const p = r.pedirForma && (await pagosPendientes()).find((i) => i.id === r.pedirForma!.registroId);
      if (p) await this.preguntarForma({ pago: r.pedirForma }, p);
    } catch (err) {
      if (!motivoFallaIA(err)) await registrar("error", "agente", "Falló el asistente", err);
      return this.falloIA(err, d);
    }
  }

  private async ejecutarSeguro(interp: Interpretacion, ctx: Ctx) {
    try {
      await this.ejecutar(interp, ctx);
    } catch (err) {
      if (err instanceof ErrorUsuario) return this.decir(`🤔 ${err.message}`);
      if (motivoFallaIA(err)) return this.falloIA(err);
      await registrar("error", "bot", "Error ejecutando la intención", err);
      return this.decir(frases.errorTecnico());
    }
  }

  /** Qué mensaje cita el usuario: un aviso, otro mensaje del bot (con su recordatorio, si tiene) o uno suyo. */
  private async respondiendoA(citado: typeof mensaje.$inferSelect): Promise<string> {
    const [oc] = citado.ocurrenciaId ? await db.select().from(ocurrencia).where(eq(ocurrencia.id, citado.ocurrenciaId)) : [];
    const recordatorioId = oc?.recordatorioId ?? citado.recordatorioId;
    const r = recordatorioId ? await obtenerRecordatorio(recordatorioId) : null;
    if (oc && r)
      return `El usuario está respondiendo al aviso de "${r.titulo}" (ID ${r.id}${r.rrule ? ", se repite" : ""}). Si dice solo un momento ("mañana", "en 2 horas", "a las 18"), es posponer ese aviso. Si dice que no va o que se suspendió, es cancelar_aviso. Si dice que lo cambiaron de día u hora, es editar.`;
    const quien = citado.direccion === "saliente" ? "un mensaje tuyo" : "un mensaje suyo anterior";
    const cita = `El usuario está respondiendo citando ${quien}: "${citado.texto ?? "(sin texto)"}".`;
    if (r)
      return `${cita} Es del recordatorio "${r.titulo}" (ID ${r.id}, ${aLocal(r.proximaInstancia ?? r.fechaHora).toFormat("ccc dd/MM HH:mm", { locale: "es" })}). Lo que pida es sobre ese recordatorio: cambiarlo, borrarlo o avisos antes. Si pide que también le recuerdes a otra hora o día ("a las 17 también"), es crear otro recordatorio con el mismo título a esa hora, sin tocar el original.`;
    return `${cita} Usalo para entender a qué se refiere. Si cita una lista con varios recordatorios y no queda claro de cuál habla, preguntale cuál.`;
  }

  /** citado: el mensaje que el usuario cita al responder (del bot o suyo), si cita alguno. */
  private async contexto(historial: Awaited<ReturnType<typeof ultimosMensajes>>, borrador: DatosBorrador | null, citado: typeof mensaje.$inferSelect | null) {
    const activos = await recordatoriosActivos(chat());
    const esperando = await pendientesSinConfirmar(chat());
    const ultima = await ultimaOcurrenciaEnviada(undefined, chat());
    const lineaRec = (r: Recordatorio) =>
      `${r.id} | ${r.titulo} | ${aLocal(r.proximaInstancia ?? r.fechaHora).toFormat("ccc dd/MM HH:mm", { locale: "es" })} | ${
        r.rrule ? `${r.rrule}` : "única"
      }${r.estado === "pausado" ? " | PAUSADO" : ""}`;
    const esperandoTxt = esperando.map((e) => `rec ${e.recordatorio.id} | ${e.recordatorio.titulo} | enviado ${aLocal(e.ocurrencia.ultimoEnvioEn!).toFormat("dd/MM HH:mm")}`);
    if (ultima && !esperando.some((e) => e.ocurrencia.id === ultima.id)) {
      const r = await obtenerRecordatorio(ultima.recordatorioId);
      if (r) esperandoTxt.push(`rec ${r.id} | ${r.titulo} | último aviso enviado ${aLocal(ultima.ultimoEnvioEn!).toFormat("dd/MM HH:mm")}`);
    }
    const historialIa: Anthropic.MessageParam[] = historial
      .filter((h) => h.texto)
      .map((h) => ({
        role: h.direccion === "entrante" ? "user" : "assistant",
        content: enGrupo() && h.direccion === "entrante" && h.autor ? `[${h.autor}] ${h.texto}` : h.texto!,
      }));
    let propuesta: string | null = null;
    const origen = borrador?.url ? `Link ${borrador.url}${borrador.titulo ? ` ("${borrador.titulo}")` : ""}` : "Foto";
    const adjunta = borrador?.url ? "este link (y su imagen si tiene)" : "esta foto";
    if (borrador?.propuesta)
      propuesta = `${origen}: ${borrador.descripcion ?? ""}. Propuesta: "${borrador.propuesta.titulo}" el ${aLocal(borrador.propuesta.fechaHora).toFormat("dd/MM HH:mm")}${
        borrador.propuesta.avisosPreviosMin.length ? ` con avisos previos ${borrador.propuesta.avisosPreviosMin.join(", ")} min` : ""
      }. Si el usuario crea un recordatorio ahora, se le adjunta ${adjunta}.`;
    else if (borrador?.transcripcion !== undefined)
      propuesta = `${borrador.descripcion} (ya se lo mandaste${borrador.guardar ? " y ofreciste guardarlo" : ""}).`;
    else if (borrador)
      propuesta = `${origen} recibido sin propuesta (${borrador.descripcion ?? "sin datos"}). Si el usuario dice cuándo, crear_recordatorio (usá un título que describa el contenido) y se le adjunta ${adjunta}.`;
    const respondiendoA = citado ? await this.respondiendoA(citado) : null;
    // Las notas son personales: en el grupo no se muestran.
    const notas = (enGrupo() ? [] : await todasLasNotas())
      .slice(0, 100)
      .map((n) => `${n.id} | ${n.titulo} | ${n.categoria}`)
      .join("\n");
    const g = contexto.getStore();
    return {
      grupo: g?.grupo ? { nombre: g.grupo.nombre, autor: g.autor } : null,
      respondiendoA,
      notas,
      recordatoriosActivos: activos.slice(0, 80).map(lineaRec).join("\n"),
      esperandoConfirmacion: esperandoTxt.join("\n"),
      propuestaPendiente: propuesta,
      historial: historialIa,
    };
  }

  /** Link: lo lee, saca una conjetura y crea, propone o pregunta. */
  private async enlace(msg: WAMessage, url: string, textoUsuario: string | null) {
    const cfg = await obtenerConfig();
    let contenido: Awaited<ReturnType<typeof leerEnlace>> | null = null;
    try {
      contenido = await leerEnlace(url, vistaPrevia(msg));
    } catch (err) {
      await registrar("aviso", "enlaces", `No se pudo leer ${url}`, err);
    }

    if (!contenido?.legible) {
      await guardarBorrador({ url, adjuntoId: null, descripcion: "link que no se pudo leer", esperaCaptura: true });
      const motivo = contenido?.esInstagram ? " Instagram no deja ver los posts sin iniciar sesión." : "";
      return this.decir(
        `No pude leer ese link 😕${motivo}\n¿Me mandás una *captura de pantalla*? O decime cuándo te lo recuerdo y te mando el link en el aviso.`,
        { intencion: "enlace_ilegible" },
      );
    }

    // La imagen de portada queda como adjunto: se reenvía con el aviso.
    let adjuntoId: number | null = null;
    if (contenido.imagen) {
      try {
        adjuntoId = (await guardarImagen(contenido.imagen.datos, contenido.imagen.mime)).id;
      } catch {
        adjuntoId = null;
      }
    }

    let a: Awaited<ReturnType<typeof analizarEnlace>>;
    try {
      a = await analizarEnlace(cfg, { ...contenido, url }, textoUsuario);
    } catch {
      await guardarBorrador({ url, adjuntoId, titulo: contenido.titulo, descripcion: contenido.descripcion ?? "" });
      return this.decir(`Leí el link${contenido.titulo ? ` (*${contenido.titulo}*)` : ""}. ¿Cuándo querés que te lo recuerde? 🗓️`, {
        intencion: "enlace",
      });
    }
    if (adjuntoId) await db.update(adjunto).set({ descripcionIa: a.resumen, datosExtraidos: { url, ...a } }).where(eq(adjunto.id, adjuntoId));

    const fecha = fechaDe(a.propuesta_fecha_hora);
    const futura = fecha && fecha.getTime() > Date.now() ? fecha : null;
    const descripcion = conLink(a.lugar ? `Lugar: ${a.lugar}` : null, url);

    if (a.accion === "crear" && futura) {
      try {
        const rec = await crearRecordatorio({
          chat: chat(),
          titulo: a.titulo,
          descripcion,
          fechaHora: futura,
          avisosPreviosMin: a.propuesta_avisos_previos_min,
          origen: "enlace",
          adjuntoId,
        });
        return this.decir(`${a.resumen}\n\n${await textoConfirmacion(rec)}`, { recordatorioId: rec.id, intencion: "crear_recordatorio" });
      } catch (err) {
        if (!(err instanceof ErrorUsuario)) throw err;
      }
    }

    const conPropuesta = a.accion !== "preguntar" && !!futura;
    const borradorId = await guardarBorrador({
      url,
      adjuntoId,
      titulo: a.titulo,
      descripcion: a.resumen,
      propuesta: conPropuesta
        ? { titulo: a.titulo, fechaHora: futura!.toISOString(), avisosPreviosMin: a.propuesta_avisos_previos_min, descripcion: a.lugar ? `Lugar: ${a.lugar}` : null }
        : null,
    });
    return this.proponer(a.mensaje, borradorId, conPropuesta, "propuesta_enlace");
  }

  private async textoNotas(): Promise<string> {
    const ns = await todasLasNotas();
    if (!ns.length) return "Todavía no tenés notas. Probá: _anotá que la clave del wifi es…_ 🗒️";
    const lineas = ns.slice(0, 40).map((n) => `• ${n.titulo} _(${n.categoria})_${n.adjuntoId ? " 📎" : ""}`);
    return `🗒️ Tus notas (${ns.length}):\n${lineas.join("\n")}${ns.length > 40 ? "\n…y más en el panel." : ""}\n\nPreguntame: _¿cuál era la clave del wifi?_`;
  }

  /** Guarda o busca en "Mis links". Devuelve false si la búsqueda no encontró nada (puede ser otra cosa: sigue el flujo normal). */
  private async misLinks(p: PedidoDeLinks, url: string | undefined): Promise<boolean> {
    const mostrar = (l: Link) => `🔗 *${l.concepto}*\n${l.url}`;
    if (p.tipo === "guardar") {
      const concepto = p.concepto || new URL(url!).hostname.replace(/^www\./, "");
      await crearLink({ concepto, url: url! });
      await this.reaccionarODecir("🔗", `Link guardado: ${concepto}`, `Guardado en tus links 👌\n${mostrar({ id: 0, concepto, url: url! })}`, "link_guardado");
      return true;
    }
    if (p.tipo === "todos") {
      const todos = await listarLinks();
      await this.decir(
        todos.length
          ? `🔗 Tus links (${todos.length}):\n${todos.slice(0, 30).map((l) => `• *${l.concepto}*: ${l.url}`).join("\n")}${todos.length > 30 ? "\n…y más en el panel." : ""}`
          : "Todavía no guardaste links. Probá: _guardá en mis links el home banking: https://…_",
        { intencion: "links" },
      );
      return true;
    }
    const encontrados = await buscarLinks(p.consulta);
    if (!encontrados.length) return false;
    await this.decir(encontrados.slice(0, 5).map(mostrar).join("\n\n"), { intencion: "links" });
    return true;
  }

  /** "Renovada" o "Recordame mañana" sobre el aviso de vencimiento de una suscripción. */
  private async contestarSuscripcion(id: number, accion: "renovar" | "recordar") {
    try {
      if (accion === "recordar") {
        const { s, cuando } = await recordarSuscripcionManana(id);
        return this.decir(`⏰ Dale, te recuerdo *${s.nombre}* mañana a las ${cuando.toFormat("H:mm")}.`, { intencion: "recordar_suscripcion" });
      }
      const { renovada, s } = await renovarDesdeAviso(id);
      const vence = DateTime.fromISO(s.fechaVto).setLocale("es").toFormat("cccc dd/MM/yyyy");
      if (!renovada) return this.decir(`*${s.nombre}* ya estaba renovada: vence el ${vence}.`, { intencion: "renovar_suscripcion" });
      return this.reaccionarODecir("🔄", `${s.nombre} renovada (vence el ${vence})`, `🔄 Listo: *${s.nombre}* renovada. Ahora vence el ${vence}.`, "renovar_suscripcion");
    } catch (err) {
      if (err instanceof ErrorUsuario) return this.decir(err.message);
      throw err;
    }
  }

  /** Marca el aviso como hecho en silencio: sin mensaje, solo una reacción ✅ (queda en el historial). */
  private async confirmar(ocId: number, reaccionarA: WAMessage) {
    const oc = await confirmarOcurrencia(ocId);
    if (!oc) return this.decir(frases.yaCerrado());
    await this.canal.reaccionar(reaccionarA, "✅").catch(() => {});
    await registrarAqui({ direccion: "saliente", tipo: "reaccion", texto: "✅", recordatorioId: oc.recordatorioId, intencionDetectada: "confirmar" });
  }

  private async posponerA(ocId: number, hasta: Date) {
    const pos = await posponerOcurrencia(ocId, hasta);
    if (!pos) return this.decir(frases.yaCerrado());
    const rec = await obtenerRecordatorio(pos.recordatorioId);
    return this.decir(frases.pospuesto(rec?.titulo ?? "el recordatorio", formatearCuando(hasta)), {
      recordatorioId: pos.recordatorioId,
      intencion: "posponer",
    });
  }

  private async aceptarBorrador(id: number, d: DatosBorrador) {
    const p = d.propuesta!;
    const rec = await crearRecordatorio({
      chat: chat(),
      titulo: p.titulo,
      descripcion: conLink(p.descripcion, d.url),
      fechaHora: new Date(p.fechaHora),
      avisosPreviosMin: p.avisosPreviosMin,
      origen: d.url ? "enlace" : "foto",
      adjuntoId: d.adjuntoId ?? null,
    });
    await cerrarBorrador(id);
    await this.decir(await textoConfirmacion(rec), { recordatorioId: rec.id, intencion: "crear_recordatorio" });
  }

  private async rechazarBorrador(id: number, d: DatosBorrador) {
    await cerrarBorrador(id);
    if (d.adjuntoId) await borrarAdjunto(d.adjuntoId);
    await this.decir(d.guardar ? "Ok, no lo guardo 👍" : frases.rechazado(), { intencion: "rechazar_propuesta" });
  }

  // ───────────── Videos (reels, TikTok, Shorts) ─────────────

  /** Un video que mandaste como archivo (por ejemplo, uno que no se pudo bajar del link). */
  private async videoArchivo(msg: WAMessage) {
    const v = msg.message!.videoMessage!;
    await registrarAqui({ direccion: "entrante", tipo: "otro", texto: v.caption ? `🎬 ${v.caption}` : "🎬 Video", waMessageId: msg.key.id, intencionDetectada: "video" });
    if (Number(v.seconds ?? 0) > MAX_SEGUNDOS_VIDEO) return this.decir(textoErrorVideo("largo"), { intencion: "video_error" });
    let datos: Buffer;
    try {
      datos = await this.canal.descargarMedia(msg);
    } catch (err) {
      await registrar("error", "videos", "No se pudo descargar un video de WhatsApp", err);
      return this.decir("No pude abrir ese video 😕. ¿Me lo mandás de nuevo?", { intencion: "video_error" });
    }
    return this.video({ datos, mime: v.mimetype ?? "video/mp4", epigrafe: v.caption }, msg, null);
  }

  /** Baja el video, lo resume y ofrece guardar lo útil. Mientras trabaja, el mensaje queda con ⏳. */
  private async video(fuente: FuenteVideo, msg: WAMessage, url: string | null) {
    const reaccion = (emoji: string) => this.canal.reaccionar(msg, emoji).catch(() => {});
    await reaccion("⏳");
    const cfg = await obtenerConfig();
    try {
      const v = await leerVideo(cfg, fuente);
      const r = await resumirVideo(cfg, v);
      if ("tope" in r) {
        await reaccion("😕");
        return this.decir(textoTope(r.tope), { intencion: "agente_tope" });
      }
      const { titulo, resumen, nota } = r.resumen;
      const recursos = r.resumen.recursos.map((x) => ({ ...x, url: x.url ? urlSegura(x.url) : null }));
      const links = recursos.flatMap((x) => (x.url ? [{ concepto: x.nombre, url: x.url }] : []));
      const lista = recursos.map((x, i) => `${i + 1}. *${x.nombre}* — ${x.para_que}${x.url ? `\n${x.url}` : ""}`).join("\n");
      const oferta = links.length ? `¿${links.length > 1 ? "Las guardo" : "La guardo"} en tus links?` : nota ? "¿Lo guardo en tus notas?" : null;
      const pie = [
        v.transcripcion && "_Respondé *texto completo* para ver todo lo que se dice._",
        v.faltaGroq && "_No escuché el audio: falta la clave de Groq (Configuración → Audios)._",
      ].filter(Boolean);
      const texto = [`🎬 *${titulo}*${v.autor ? ` · ${v.autor}` : ""}`, resumen, lista, oferta, pie.join("\n")].filter(Boolean).join("\n\n");
      await guardarBorrador({
        url,
        titulo,
        descripcion: `Resumen de un video: ${titulo}`,
        guardar: oferta ? { links, nota: links.length ? null : nota } : undefined,
        transcripcion: v.transcripcion,
      });
      await reaccion("✅");
      return this.decir(texto, { intencion: "resumen_video" });
    } catch (err) {
      await reaccion("😕");
      if (err instanceof ErrorVideo) return this.decir(textoErrorVideo(err.motivo), { intencion: "video_error" });
      if (!motivoFallaIA(err)) await registrar("error", "videos", "No se pudo resumir un video", err);
      return this.falloIA(err, undefined, "video_error");
    }
  }

  private async guardarDelVideo(id: number, g: NonNullable<DatosBorrador["guardar"]>) {
    await cerrarBorrador(id);
    for (const l of g.links) await crearLink(l);
    if (g.links.length) {
      const que = g.links.length > 1 ? `guardé las ${g.links.length} en tus links` : "la guardé en tus links";
      return this.reaccionarODecir("🔗", `Links guardados: ${g.links.map((l) => l.concepto).join(", ")}`, `🔗 Listo, ${que}.`, "links");
    }
    const n = await crearNota(g.nota!);
    return this.reaccionarODecir("🗒️", `Nota guardada: ${n.titulo}`, `🗒️ Guardé la nota *${n.titulo}*.`, "nota_guardar");
  }

  /** Si hay uno solo, lo devuelve. Si hay varios, pregunta cuál (encuesta o lista) y devuelve null. */
  private async elegir(ids: number[], accion: string, interp?: Interpretacion): Promise<Recordatorio | null> {
    const recs = (await Promise.all([...new Set(ids)].map((i) => obtenerRecordatorio(i)))).filter(
      (r): r is Recordatorio => !!r && r.estado !== "borrado" && (r.chat ?? null) === chat(),
    );
    if (recs.length === 1) return recs[0];
    if (!recs.length) {
      await this.decir(`No encontré cuál querés ${accion} 🤔. ¿Me decís el nombre? (Con *lista* te muestro todos)`);
      return null;
    }
    if (interp) {
      const opciones = recs.map((r, k) => `${k + 1}) ${sinFormato(r.titulo)} · ${cuandoBonito(r)}`.slice(0, 95));
      const guardada = { ...interp, recordatorio_ids: [] } as unknown as Record<string, unknown>;
      if (await this.encuesta(`Encontré varios. ¿Cuál querés ${accion}?`, opciones, { tipo: "elegir", ids: recs.map((r) => r.id), interpretacion: guardada }))
        return null;
    }
    const opciones = recs.map((r, k) => `${k + 1}) *${r.titulo}* — ${cuandoBonito(r)}`).join("\n");
    await this.decir(`Encontré varios:\n${opciones}\n\n¿Cuál querés ${accion}?`);
    return null;
  }

  private async ejecutar(i: Interpretacion, ctx: Ctx) {
    switch (i.intencion) {
      case "crear_recordatorio": {
        const items = i.recordatorios.filter((r) => r.titulo && fechaDe(r.fecha_hora));
        if (i.falta_info || !items.length) return this.decir(i.respuesta ?? "¿Para cuándo te lo recuerdo? 🗓️", { intencion: "falta_info" });
        // Una hora que ya pasó no va a sonar nunca: se pregunta en vez de agendarla.
        if (items.some((it) => !it.recurrencia && fechaDe(it.fecha_hora)! <= new Date())) return this.decir(frases.horaPasada(), { intencion: "falta_info" });
        const respuestas: string[] = [];
        const creados: number[] = [];
        let ofrecer = false;
        let conFoto = ctx.borrador?.datos.adjuntoId ?? null;
        let link = ctx.borrador?.datos.url ?? null;
        for (const it of items) {
          const datos: DatosRecordatorio = {
            chat: chat(),
            titulo: it.titulo!,
            descripcion: conLink(it.descripcion, link),
            fechaHora: fechaDe(it.fecha_hora)!,
            rrule: it.recurrencia,
            avisosPreviosMin: it.avisos_previos_min ?? [],
            origen: link ? "enlace" : conFoto ? "foto" : "whatsapp",
            adjuntoId: conFoto,
          };
          const rec = await crearRecordatorio(datos);
          creados.push(rec.id);
          conFoto = null; // La foto y el link van solo con el primero.
          link = null;
          respuestas.push(await textoConfirmacion(rec, !respuestas.length));
          ofrecer ||= items.length === 1 && convieneOfrecerPrevio(rec, it.es_evento);
        }
        if (ctx.borrador) await cerrarBorrador(ctx.borrador.id);
        if (ofrecer) respuestas.push("¿Querés que te avise antes también? Decime, por ejemplo, *1 hora antes* o *el día anterior*.");
        // Con uno solo, el mensaje queda unido a él: si lo citan después, se sabe de cuál hablan.
        return this.decir(respuestas.join("\n\n"), { recordatorioId: creados.length === 1 ? creados[0] : null, intencion: "crear_recordatorio" });
      }
      case "aceptar_propuesta":
        if (ctx.borrador?.datos.propuesta) return this.aceptarBorrador(ctx.borrador.id, ctx.borrador.datos);
        return this.decir(i.respuesta ?? "¿Qué querés que te recuerde y cuándo?");
      case "rechazar_propuesta":
        if (ctx.borrador) return this.rechazarBorrador(ctx.borrador.id, ctx.borrador.datos);
        return this.decir(frases.rechazado());
      case "listar": {
        const desde = fechaDe(i.listar_desde);
        const hasta = fechaDe(i.listar_hasta);
        if (!desde && !hasta) return this.decir(await textoTodos(chat()), { intencion: "listar" });
        return this.decir(await textoListado(listarRango(desde, hasta), chat()), { intencion: "listar" });
      }
      case "confirmar": {
        let oc: Pick<Ocurrencia, "id"> | null = ctx.ocCitada ? { id: ctx.ocCitada } : null;
        if (!oc && i.recordatorio_ids.length === 1) oc = await ultimaOcurrenciaEnviada(i.recordatorio_ids[0], chat());
        oc ??= await ultimaOcurrenciaEnviada(undefined, chat());
        if (!oc) return this.decir(frases.nadaPendiente());
        return this.confirmar(oc.id, ctx.msg);
      }
      case "posponer": {
        const hasta = fechaDe(i.posponer_hasta) ?? (i.posponer_minutos ? new Date(Date.now() + i.posponer_minutos * 60_000) : null);
        if (!hasta || hasta.getTime() <= Date.now()) return this.decir(i.respuesta ?? "¿Para cuándo lo pospongo?");
        let oc: Pick<Ocurrencia, "id"> | null = ctx.ocCitada ? { id: ctx.ocCitada } : null;
        if (!oc && i.recordatorio_ids.length === 1)
          oc = (await ultimaOcurrenciaEnviada(i.recordatorio_ids[0], chat())) ?? (await proximaOcurrenciaPendiente(i.recordatorio_ids[0]));
        if (!oc && i.recordatorio_ids.length > 1) {
          await this.elegir(i.recordatorio_ids, "posponer", i);
          return;
        }
        oc ??= await ultimaOcurrenciaEnviada(undefined, chat());
        if (!oc) return this.decir("No encontré qué posponer 🤔. ¿Me decís cuál?");
        return this.posponerA(oc.id, hasta);
      }
      case "cancelar_aviso":
        return this.cancelarAviso(i, ctx);
      case "editar": {
        let ids = i.recordatorio_ids;
        if (!ids.length && ctx.ocCitada) ids = [(await this.ocurrencia(ctx.ocCitada))?.recordatorioId ?? 0];
        const rec = await this.elegir(ids, "cambiar", i);
        if (!rec || !i.cambios) return rec ? this.decir(i.respuesta ?? "¿Qué querés cambiarle?") : undefined;
        const c = i.cambios;
        const cambios: Partial<DatosRecordatorio> = {};
        if (c.titulo) cambios.titulo = c.titulo;
        if (c.descripcion) cambios.descripcion = c.descripcion;
        const f = fechaDe(c.fecha_hora);
        if (f) cambios.fechaHora = f;
        if (c.recurrencia) cambios.rrule = c.recurrencia;
        if (c.quitar_recurrencia) cambios.rrule = null;
        if (c.avisos_previos_min) cambios.avisosPreviosMin = c.avisos_previos_min;
        if (!Object.keys(cambios).length) return this.decir(i.respuesta ?? "¿Qué querés cambiarle?");
        // Un aviso que ya llegó y se movió de fecha deja de insistir.
        if (cambios.fechaHora && ctx.ocCitada) {
          const oc = await this.ocurrencia(ctx.ocCitada);
          if (oc?.recordatorioId === rec.id && oc.estado === "enviada") await cancelarInstancia(oc);
        }
        const nuevo = await actualizarRecordatorio(rec.id, cambios);
        return this.decir(`${frases.editado(nuevo.titulo)}\n📌 *${nuevo.titulo}*\n🗓️ ${cuandoBonito(nuevo)}${textoPrevios(nuevo)}`, {
          recordatorioId: rec.id,
          intencion: "editar",
        });
      }
      case "borrar": {
        const rec = await this.elegir(i.recordatorio_ids, "borrar", i);
        if (!rec) return;
        await borrarRecordatorio(rec.id);
        return this.decir(frases.borrado(rec.titulo), { recordatorioId: rec.id, intencion: "borrar" });
      }
      case "pausar": {
        const rec = await this.elegir(i.recordatorio_ids, "pausar", i);
        if (!rec) return;
        await pausarRecordatorio(rec.id);
        return this.decir(frases.pausado(rec.titulo), { recordatorioId: rec.id, intencion: "pausar" });
      }
      case "reanudar": {
        const rec = await this.elegir(i.recordatorio_ids, "reanudar", i);
        if (!rec) return;
        await reanudarRecordatorio(rec.id);
        const r = (await obtenerRecordatorio(rec.id))!;
        return this.decir(frases.reanudado(r.titulo, cuandoBonito(r)), { recordatorioId: rec.id, intencion: "reanudar" });
      }
      case "nota_guardar":
      case "nota_consultar":
      case "nota_editar":
      case "nota_borrar":
        if (enGrupo()) return this.decir("Las notas son personales 🔒. Eso pedímelo por privado.", { intencion: i.intencion });
        return this.notas(i, ctx);
      case "ayuda":
        return this.decir(TEXTO_AYUDA, { intencion: "ayuda" });
      default:
        return this.decir(i.respuesta ?? frases.noEntendi(), { intencion: i.intencion });
    }
  }

  private async ocurrencia(id: number): Promise<Ocurrencia | null> {
    const [oc] = await db.select().from(ocurrencia).where(eq(ocurrencia.id, id));
    return oc ?? null;
  }

  /** "No voy", "se suspendió": un único se borra; de un recurrente se saltea esa vez. */
  private async cancelarAviso(i: Interpretacion, ctx: Ctx) {
    let oc: Ocurrencia | null = ctx.ocCitada ? await this.ocurrencia(ctx.ocCitada) : null;
    let ids = oc ? [oc.recordatorioId] : i.recordatorio_ids;
    if (!ids.length) {
      oc = await ultimaOcurrenciaEnviada(undefined, chat());
      ids = oc ? [oc.recordatorioId] : [];
    }
    if (!ids.length) return this.decir(i.respuesta ?? "¿Cuál querés cancelar? Decime el nombre 🙂");
    const rec = await this.elegir(ids, "cancelar", i);
    if (!rec) return;
    if (!rec.rrule) {
      await borrarRecordatorio(rec.id);
      return this.decir(frases.cancelado(rec.titulo), { recordatorioId: rec.id, intencion: "cancelar_aviso" });
    }
    oc ??= await ultimaOcurrenciaEnviada(rec.id, chat());
    // Si esa vez ya pasó (el aviso llegó), se cierra; si todavía no, se saltea la próxima.
    if (oc && oc.recordatorioId === rec.id && oc.instancia.getTime() <= Date.now()) await cancelarInstancia(oc);
    else await marcarHecho(rec.id);
    const r = (await obtenerRecordatorio(rec.id))!;
    const proximo = r.estado === "activo" ? cuandoBonito(r) : "no hay más";
    return this.decir(frases.salteado(r.titulo, proximo), { recordatorioId: rec.id, intencion: "cancelar_aviso" });
  }

  private async notas(i: Interpretacion, ctx: Ctx) {
    switch (i.intencion) {
      case "nota_guardar": {
        if (!i.nota || !(i.nota.contenido.trim() || i.nota.titulo.trim())) return this.decir(i.respuesta ?? "¿Qué querés que anote?");
        // Si hay una foto esperando, va con la nota.
        const b = ctx.borrador && !ctx.borrador.datos.url ? ctx.borrador : null;
        let contenido = i.nota.contenido;
        if (b?.datos.adjuntoId) {
          const adj = await obtenerAdjunto(b.datos.adjuntoId);
          const visible = (adj?.datosExtraidos as { texto_visible?: string | null } | null)?.texto_visible;
          if (visible && !contenido.includes(visible)) contenido = `${contenido}\n${visible}`;
        }
        const n = await crearNota({ ...i.nota, contenido, adjuntoId: b?.datos.adjuntoId ?? null });
        if (b) await cerrarBorrador(b.id);
        return this.reaccionarODecir(
          "🗒️",
          `Nota guardada: ${n.titulo}`,
          `🗒️ Anotado: *${n.titulo}*${b?.datos.adjuntoId ? " (con la foto)" : ""}. Cuando lo necesites, preguntame.`,
          "nota_guardar",
        );
      }
      case "nota_consultar": {
        const todas = await todasLasNotas();
        if (!todas.length) return this.decir("Todavía no tenés notas. Probá: _anotá que la clave del wifi es…_");
        const consulta = i.consulta ?? i.referencia ?? "";
        const r = await responderConNotas(await obtenerConfig(), consulta, relacionadas(todas, consulta));
        await this.decir(r.respuesta, { intencion: "nota_consultar" });
        // Si la nota usada tiene foto, se manda también.
        const conFoto = todas.find((n) => r.nota_ids.includes(n.id) && n.adjuntoId);
        if (conFoto?.adjuntoId) {
          const adj = await obtenerAdjunto(conFoto.adjuntoId);
          if (adj) await this.canal.responderImagen(adj.rutaArchivo, adj.mime, `🗒️ ${conFoto.titulo}`);
        }
        return;
      }
      case "nota_editar":
      case "nota_borrar": {
        const notas = (await Promise.all(i.nota_ids.map((id) => obtenerNota(id)))).filter((n) => !!n);
        if (!notas.length) return this.decir("No encontré esa nota 🤔. Escribí *notas* para verlas.");
        if (notas.length > 1)
          return this.decir(`Encontré varias:\n${notas.map((n, k) => `${k + 1}) *${n.titulo}*`).join("\n")}\n\n¿Cuál?`);
        const n = notas[0];
        if (i.intencion === "nota_borrar") {
          await borrarNota(n.id);
          return this.decir(`🗑️ Borré la nota *${n.titulo}*.`, { intencion: "nota_borrar" });
        }
        if (!i.nota) return this.decir("¿Qué le cambio a la nota?");
        const nueva = await actualizarNota(n.id, { titulo: i.nota.titulo || n.titulo, contenido: i.nota.contenido || n.contenido, categoria: i.nota.categoria || n.categoria });
        return this.decir(`✏️ Actualicé la nota *${nueva.titulo}*.`, { intencion: "nota_editar" });
      }
    }
  }
}
