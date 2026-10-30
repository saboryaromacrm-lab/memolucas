import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import type { WAMessage } from "baileys";
import { and, desc, eq, gt } from "drizzle-orm";
import { DateTime } from "luxon";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import {
  adjunto,
  borradorPendiente,
  mensaje,
  ocurrencia,
  type AccionEncuesta,
  type FilaComprobante,
  type Ocurrencia,
  type Recordatorio,
} from "../db/schema.js";
import { ahora, aLocal, formatearCuando } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { borrarAdjunto, guardarArchivo, guardarImagen, imagenParaComprobante, imagenParaIa, MIMES_IMAGEN } from "../servicios/adjuntos.js";
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
import { EMOJIS_CONFIRMACION, TEXTO_AYUDA, detectarComando, esAfirmativo, esNegativo } from "./comandos.js";
import { extraerUrls, leerEnlace, textoSinUrls, type VistaPreviaWa } from "../servicios/enlaces.js";
import { analizarEnlace, analizarFoto, ErrorIA, interpretar, responderConNotas, type Interpretacion } from "./ia.js";
import { ErrorAudio, transcribir } from "../servicios/audio.js";
import { actualizarNota, borrarNota, crearNota, obtenerNota, relacionadas, todasLasNotas } from "../servicios/notas.js";
import { obtenerAdjunto } from "../servicios/adjuntos.js";
import { normalizar } from "../lib/textos.js";
import {
  encuestaPorWaId,
  marcarRespondida,
  OPCIONES_COMPROBANTE,
  opcionElegida,
  opcionesAviso,
  OPCIONES_PROPUESTA,
  registrarEncuesta,
} from "../servicios/encuestas.js";
import { controlar, textoResumen, tituloComprobante, type Comprobante } from "../lib/comprobantes.js";
import {
  actualizarDatos,
  buscarDuplicado,
  comprobanteEnCorreccion,
  comprobantePorMensaje,
  confirmarComprobante,
  descartarComprobante,
  empezarCorreccion,
  esGrupoCompras,
  fijarMensaje,
  guardarComprobante,
  leerDatos,
  obtenerComprobante,
} from "../servicios/compras.js";
import { corregirComprobante, leerComprobantes, type ArchivoParaIa } from "./ia-compras.js";
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
  /** Reacción con un emoji (ej. 👀 al recibir un comprobante). */
  reaccionar(msg: WAMessage, emoji: string): Promise<void>;
}

/** De dónde vino el mensaje que se está procesando. */
export type OrigenMensaje = { grupo: { jid: string; nombre: string } | null; autor: string | null };
type Contexto = OrigenMensaje & { msg: WAMessage; compras: boolean };

// Cada mensaje se procesa con su propio contexto (privado o grupo), aunque lleguen varios a la vez.
const contexto = new AsyncLocalStorage<Contexto>();
const chat = (): string | null => contexto.getStore()?.grupo?.jid ?? null;
const enGrupo = () => !!contexto.getStore()?.grupo;
/** Grupo de compras: solo comprobantes, sin recordatorios. */
const enCompras = () => !!contexto.getStore()?.compras;

/** En privado, una foto con "factura", "remito"… en el pie va directo a compras. */
const PIDE_COMPRA = /\b(factura|facturas|remito|remitos|comprobante|comprobantes|ticket|nota de credito|nota de debito)\b/;

type ArchivoLote = { adjuntoId: number; nombre: string; mime: string };

function documentoDe(msg: WAMessage) {
  const m = msg.message;
  return m?.documentMessage ?? m?.documentWithCaptionMessage?.message?.documentMessage ?? null;
}


/** En grupos, fotos y links solo se procesan si se lo piden al bot. */
const PIDE_BOT = /\b(recorda|recordame|recordanos|recuerden|avisa|avisame|avisanos|anota|nota|agrega|guarda|guardalo|guardala|memo|memolucas|bot)\b/;
const MINUTOS_BORRADOR_GRUPO = 30;

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
};

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

type Ctx = { ocCitada: number | null; borrador: Awaited<ReturnType<typeof borradorActivo>> };

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
    const compras = await esGrupoCompras(origen.grupo?.jid ?? null);
    return contexto.run({ ...origen, msg, compras }, () => this.procesarAqui(msg));
  }

  private async procesarAqui(msg: WAMessage): Promise<void> {
    const m = msg.message;
    if (!m) return;
    if (m.reactionMessage) return this.reaccion(msg);
    if (m.pollUpdateMessage) return this.voto(msg);
    if (enCompras()) return this.mensajeCompras(msg);
    if (m.imageMessage) return this.foto(msg);
    if (documentoDe(msg)) return this.documento(msg);
    if (m.audioMessage) return this.audio(msg);
    const texto = textoMensaje(msg);
    if (texto?.trim()) return this.texto(msg, texto.trim());
    await registrarAqui({ direccion: "entrante", tipo: "otro", texto: null, waMessageId: msg.key.id });
    if (m.stickerMessage || enGrupo()) return;
    await this.decir("Por ahora entiendo texto, audios, fotos y links 🙂");
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
    const comp = await comprobantePorMensaje(r.key.id, chat());
    if (comp) return this.confirmarCompra(comp.id);
    const original = await mensajePorWaId(r.key.id);
    if (!original?.ocurrenciaId) return;
    const oc = await confirmarOcurrencia(original.ocurrenciaId);
    if (!oc) return;
    const rec = await obtenerRecordatorio(oc.recordatorioId);
    await this.decir(frases.hecho(rec?.titulo ?? "el recordatorio"), { recordatorioId: oc.recordatorioId, intencion: "confirmar" });
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
    switch (a.tipo) {
      case "aviso": {
        if (elegida === 0) return this.confirmar(a.ocurrenciaId);
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
        return this.ejecutarSeguro(interp, { ocCitada: null, borrador: await borradorActivo() });
      }
      case "comprobante":
        if (elegida === 0) return this.confirmarCompra(a.comprobanteId);
        if (elegida === 2) return this.descartarCompra(a.comprobanteId);
        return this.pedirCorreccion(a.comprobanteId);
    }
  }

  // ───────────── Compras (comprobantes de proveedores) ─────────────

  private lotes = new Map<string, { archivos: ArchivoLote[]; timer?: NodeJS.Timeout; ctx: Contexto }>();
  private leyendo = new Set<Promise<void>>();

  /** En el grupo de compras: fotos y PDF son comprobantes; el texto solo cuenta si responde a uno. */
  private async mensajeCompras(msg: WAMessage) {
    const m = msg.message!;
    if (m.imageMessage || documentoDe(msg)) return this.archivoCompra(msg);
    const texto = textoMensaje(msg)?.trim();
    if (!texto) return void (await registrarAqui({ direccion: "entrante", tipo: m.audioMessage ? "audio" : "otro", texto: null, waMessageId: msg.key.id }));
    const entrante = await registrarAqui({ direccion: "entrante", texto, waMessageId: msg.key.id });
    const respondio = await this.respuestaCompra(msg, texto);
    await db.update(mensaje).set({ intencionDetectada: respondio ? "comprobante" : "ignorar" }).where(eq(mensaje.id, entrante.id));
  }

  /** Documento en privado: un PDF es un comprobante. En el grupo de la familia no se usan. */
  private async documento(msg: WAMessage) {
    if (enGrupo()) return void (await registrarAqui({ direccion: "entrante", tipo: "otro", texto: null, waMessageId: msg.key.id }));
    return this.archivoCompra(msg);
  }

  /** Guarda la foto o el PDF y lo junta con los que lleguen enseguida (varias hojas del mismo comprobante). */
  private async archivoCompra(msg: WAMessage) {
    const img = msg.message!.imageMessage;
    const doc = documentoDe(msg);
    const cfg = await obtenerConfig();
    const mime = (img?.mimetype ?? doc?.mimetype ?? "").split(";")[0];
    const texto = img?.caption ?? doc?.caption ?? null;
    const registrarEntrante = (adjuntoId: number | null = null) =>
      registrarAqui({ direccion: "entrante", tipo: img ? "imagen" : "otro", texto, waMessageId: msg.key.id, adjuntoId, intencionDetectada: "comprobante" });
    if (!img && mime !== "application/pdf" && !MIMES_IMAGEN.includes(mime)) {
      await registrarEntrante();
      return this.decir("Ese archivo no lo puedo leer 😕. Mandame una foto o un PDF del comprobante.");
    }
    if (Number(img?.fileLength ?? doc?.fileLength ?? 0) > cfg.fotoMaxMb * 1024 * 1024) {
      await registrarEntrante();
      return this.decir(`Ese archivo es muy pesado (máximo ${cfg.fotoMaxMb} MB). ¿Me lo mandás más liviano?`);
    }
    let datos: Buffer;
    try {
      datos = await this.canal.descargarMedia(msg);
    } catch (err) {
      await registrarEntrante();
      await registrar("error", "compras", "No se pudo descargar el comprobante", err);
      return this.decir("No pude bajar el archivo 😕. ¿Me lo mandás de nuevo?");
    }
    const tipo = img && !MIMES_IMAGEN.includes(mime) ? "image/jpeg" : mime;
    const adj = await guardarArchivo(datos, tipo);
    await registrarEntrante(adj.id);
    await this.canal.reaccionar(msg, "👀").catch(() => {});
    const nombre = doc?.fileName?.trim() || `${tipo === "application/pdf" ? "documento" : "foto"}-${adj.id}.${tipo === "application/pdf" ? "pdf" : "jpg"}`;
    this.encolarCompra({ adjuntoId: adj.id, nombre, mime: tipo }, cfg.comprasEsperaSeg);
  }

  private encolarCompra(archivo: ArchivoLote, esperaSeg: number) {
    const ctx = contexto.getStore()!;
    const clave = `${chat() ?? ""}|${ctx.autor ?? ""}`;
    const lote = this.lotes.get(clave) ?? { archivos: [], ctx };
    clearTimeout(lote.timer);
    lote.archivos.push(archivo);
    lote.ctx = ctx; // Se responde citando el último archivo.
    lote.timer = setTimeout(() => this.cerrarLote(clave), Math.max(0, esperaSeg) * 1000);
    this.lotes.set(clave, lote);
  }

  private cerrarLote(clave: string) {
    const lote = this.lotes.get(clave);
    if (!lote) return;
    clearTimeout(lote.timer);
    this.lotes.delete(clave);
    const p: Promise<void> = contexto
      .run(lote.ctx, () => this.leerLote(lote.archivos))
      .catch((err) => void registrar("error", "compras", "Falló la lectura de un comprobante", err))
      .finally(() => this.leyendo.delete(p));
    this.leyendo.add(p);
  }

  /** Lee ya lo que está esperando y espera a que termine (para pruebas y para apagar prolijo). */
  async terminarCompras() {
    for (const clave of [...this.lotes.keys()]) this.cerrarLote(clave);
    await Promise.all([...this.leyendo]);
  }

  private async archivosParaIa(archivos: { adjuntoId: number; nombre: string }[]): Promise<ArchivoParaIa[]> {
    const salida: ArchivoParaIa[] = [];
    for (const a of archivos) {
      const adj = await obtenerAdjunto(a.adjuntoId);
      if (!adj) continue;
      const datos = await fs.readFile(adj.rutaArchivo).catch(() => null);
      if (!datos) continue;
      if (adj.mime === "application/pdf") salida.push({ nombre: a.nombre, mime: adj.mime, datos });
      else salida.push({ nombre: a.nombre, ...(await imagenParaComprobante(datos)) });
    }
    return salida;
  }

  private async leerLote(archivos: ArchivoLote[]) {
    const cfg = await obtenerConfig();
    const paraIa = await this.archivosParaIa(archivos);
    let lectura: ReturnType<typeof controlar>[];
    let modelo = cfg.comprasModelo;
    try {
      lectura = (await leerComprobantes(cfg, paraIa, modelo)).map(controlar);
    } catch (err) {
      if (err instanceof ErrorIA && /API key/i.test(err.message))
        return this.decir("Me falta la clave de Claude para leer comprobantes. Cargala en el panel (Configuración → IA).");
      return this.decir("No pude leer el comprobante 😕. ¿Me lo mandás de nuevo? Que se vea entero, derecho y con buena luz.", { intencion: "error_ia" });
    }
    // Si las cuentas no cierran, se vuelve a leer con el modelo más potente y queda la lectura con menos diferencias.
    const fallas = (l: typeof lectura) => l.reduce((t, x) => t + x.fallas, 0);
    if (lectura.some((x) => !x.cierra) && cfg.comprasModeloReintento) {
      const aviso = lectura.flatMap((x) => (x.cierra ? [] : [x.comprobante.controles.diferencias])).join(". ");
      try {
        const otra = (await leerComprobantes(cfg, paraIa, cfg.comprasModeloReintento, aviso)).map(controlar);
        if (otra.length && fallas(otra) <= fallas(lectura)) {
          lectura = otra;
          modelo = cfg.comprasModeloReintento;
        }
      } catch {
        // Queda la primera lectura.
      }
    }
    if (!lectura.length) {
      for (const a of archivos) await borrarAdjunto(a.adjuntoId);
      return this.decir("No encontré ningún comprobante en eso 🤔. Mandame la foto o el PDF de la factura, remito o ticket.");
    }
    const usados = new Set<number>();
    for (const x of lectura) {
      const repetido = await buscarDuplicado(x.comprobante);
      if (repetido) {
        const d = leerDatos(repetido);
        await this.decir(
          `⚠️ Ese comprobante ya estaba cargado: *${tituloComprobante(d)}* de ${d.encabezado.razonSocialEmisor || "proveedor sin nombre"}${
            repetido.autor ? `, lo mandó ${repetido.autor}` : ""
          } el ${aLocal(repetido.creadoEn).toFormat("dd/MM")}. No lo cargo de nuevo.`,
          { intencion: "comprobante_repetido" },
        );
        continue;
      }
      const propios = archivos.filter((a) => x.comprobante.archivo.includes(a.nombre));
      const ids = (propios.length ? propios : archivos).map((a) => a.adjuntoId);
      ids.forEach((id) => usados.add(id));
      const fila = await guardarComprobante({ chat: chat(), autor: contexto.getStore()?.autor ?? null, datos: x.comprobante, cierra: x.cierra, modelo, adjuntoIds: ids });
      await this.mostrarComprobante(fila, x.comprobante);
    }
    for (const a of archivos) if (!usados.has(a.adjuntoId)) await borrarAdjunto(a.adjuntoId);
  }

  /** Resumen del comprobante y la encuesta para confirmarlo. */
  private async mostrarComprobante(fila: FilaComprobante, datos: Comprobante) {
    const cfg = await obtenerConfig();
    const ayuda = "Respondé a este mensaje con *confirmar*, *descartar* o lo que haya que corregir.";
    const resumen = textoResumen(datos, fila.cierra);
    const id = await this.decirConId(cfg.usarEncuestas ? resumen : `${resumen}\n\n_${ayuda}_`, { intencion: "comprobante" });
    await fijarMensaje(fila.id, id);
    if (!cfg.usarEncuestas) return;
    const conEncuesta = await this.encuesta(`${tituloComprobante(datos)}: ¿lo confirmo?`, OPCIONES_COMPROBANTE, { tipo: "comprobante", comprobanteId: fila.id });
    if (!conEncuesta) await this.decir(ayuda);
  }

  private async confirmarCompra(id: number) {
    const r = await confirmarComprobante(id);
    if (!r) return this.decir(frases.yaCerrado());
    const ojo = r.fila.cierra ? "" : " (ojo: las cuentas no cerraban)";
    if (r.envio?.ok) return this.decir(`✅ Confirmado y enviado al ERP${ojo}.`, { intencion: "comprobante_confirmado" });
    if (r.envio) return this.decir(`✅ Confirmado${ojo}, pero no lo pude mandar al ERP (${r.envio.mensaje}). Reintentalo desde el panel.`);
    const cfg = await obtenerConfig();
    return this.decir(`✅ Confirmado${ojo}. ${cfg.erpUrl ? "Mandalo al ERP desde el panel cuando quieras." : "Queda en el panel, en Compras."}`, {
      intencion: "comprobante_confirmado",
    });
  }

  private async descartarCompra(id: number) {
    if (!(await descartarComprobante(id))) return this.decir(frases.yaCerrado());
    return this.decir("🗑️ Listo, lo descarté.", { intencion: "comprobante_descartado" });
  }

  private async pedirCorreccion(id: number) {
    const c = await obtenerComprobante(id);
    if (!c || c.fila.estado === "confirmado" || c.fila.estado === "descartado") return this.decir(frases.yaCerrado());
    await empezarCorreccion(id);
    return this.decir("✏️ Dale, decime qué corrijo. Por ejemplo: _el renglón 3 son 12 unidades_ o _el total es 15.300,50_. También lo podés editar en el panel.");
  }

  /** Respuesta a un comprobante (citando el resumen, o después de tocar "Corregir"). Devuelve false si no era eso. */
  private async respuestaCompra(msg: WAMessage, texto: string): Promise<boolean> {
    const citado = idCitado(msg);
    let fila = citado ? await comprobantePorMensaje(citado, chat()) : null;
    const corrigiendo = fila ? null : await comprobanteEnCorreccion(chat());
    fila ??= corrigiendo;
    if (!fila) return false;
    const t = normalizar(texto);
    if (!corrigiendo) {
      if (esAfirmativo(texto) || /^(confirmar|confirmo|confirmalo|confirmado)$/.test(t)) {
        await this.confirmarCompra(fila.id);
        return true;
      }
      if (/^(descartar|descartalo|descartala|borrar|borralo|anular|anulalo)$/.test(t)) {
        await this.descartarCompra(fila.id);
        return true;
      }
    }
    if (fila.estado === "confirmado" || fila.estado === "descartado") {
      await this.decir(fila.estado === "confirmado" ? "Ese ya está confirmado. Si hay que cambiarlo, hacelo en el ERP." : "Ese ya está descartado. Si te sirve, mandalo de nuevo.");
      return true;
    }
    await this.corregirCompra(fila, texto);
    return true;
  }

  private async corregirCompra(fila: FilaComprobante, correccion: string) {
    const cfg = await obtenerConfig();
    const archivos = fila.archivosBorrados ? [] : await this.archivosParaIa(fila.adjuntoIds.map((id) => ({ adjuntoId: id, nombre: `archivo-${id}` })));
    let nuevo: Comprobante;
    try {
      nuevo = await corregirComprobante(cfg, leerDatos(fila), correccion, archivos);
    } catch {
      return this.decir(frases.errorTecnico());
    }
    const r = await actualizarDatos(fila.id, nuevo);
    await this.mostrarComprobante(r.fila, r.datos);
  }

  private async foto(msg: WAMessage) {
    const img = msg.message!.imageMessage!;
    const cfg = await obtenerConfig();
    const epigrafe = img.caption?.trim() || null;
    if (!enGrupo() && epigrafe && PIDE_COMPRA.test(normalizar(epigrafe))) return this.archivoCompra(msg);
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
    try {
      const liviana = await imagenParaIa(datos);
      const a = await analizarFoto(cfg, liviana.datos, liviana.mime, epigrafe);
      await db.update(adjunto).set({ descripcionIa: a.descripcion, datosExtraidos: a }).where(eq(adjunto.id, adj.id));
      // Un comprobante de un proveedor va a compras (en privado).
      if (a.tipo === "compra" && !enGrupo()) return this.encolarCompra({ adjuntoId: adj.id, nombre: `foto-${adj.id}.jpg`, mime: mimeFoto }, 0);
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
    } catch {
      respuesta = "Guardé la foto 📎. ¿Cuándo querés que te la recuerde?";
    }
    const borradorId = await guardarBorrador(datosBorrador);
    await this.proponer(respuesta, borradorId, !!datosBorrador.propuesta, "propuesta_foto");
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
    return this.decir(`🗒️ Guardé la nota *${n.titulo}* con la foto. Cuando la necesites, preguntame.`, { intencion: "nota_guardar" });
  }

  private async texto(msg: WAMessage, texto: string, tipo: "texto" | "audio" = "texto", eco?: string) {
    const historial = await ultimosMensajes(5, chat());
    const citado = idCitado(msg);
    const ocCitada = citado ? (await mensajePorWaId(citado))?.ocurrenciaId ?? null : null;
    const entrante = await registrarAqui({ direccion: "entrante", texto, tipo, waMessageId: msg.key.id });
    const anotar = (intencion: string) =>
      db.update(mensaje).set({ intencionDetectada: intencion }).where(eq(mensaje.id, entrante.id));

    // 0) Respuesta a un comprobante de compra.
    if (await this.respuestaCompra(msg, texto)) return void (await anotar("comprobante"));

    // 1) Links: se leen y se analizan.
    const urls = extraerUrls(texto);
    if (urls.length) {
      // En el grupo, un link compartido sin pedirle nada al bot es charla.
      if (enGrupo() && !PIDE_BOT.test(normalizar(textoSinUrls(texto)))) return void (await anotar("ignorar"));
      await anotar("enlace");
      return this.enlace(msg, urls[0], textoSinUrls(texto) || null);
    }

    // 2) Respuesta rápida a una propuesta (foto o link).
    const borrador = await borradorActivo();
    if (borrador?.datos.propuesta && esAfirmativo(texto)) {
      await anotar("aceptar_propuesta");
      return this.aceptarBorrador(borrador.id, borrador.datos);
    }
    if (borrador && esNegativo(texto)) {
      await anotar("rechazar_propuesta");
      return this.rechazarBorrador(borrador.id, borrador.datos);
    }

    // 3) Comandos rápidos sin IA. Si responde a un aviso ("mañana", "en 2 horas"), lo interpreta la IA como posponer.
    const comando = detectarComando(texto);
    // En el grupo, "hoy", "lista", etc. pueden ser charla: los interpreta la IA. "listo" confirma solo si hay un aviso esperando.
    let cmd = ocCitada && comando?.tipo === "listar" ? null : comando;
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
          return this.confirmar(oc.id);
        }
      }
    }

    // 4) IA.
    const cfg = await obtenerConfig();
    let interp: Interpretacion;
    try {
      interp = await interpretar(cfg, texto, await this.contexto(historial, borrador?.datos ?? null, ocCitada));
    } catch (err) {
      if (enGrupo()) return; // En el grupo no se interrumpe la charla con errores.
      if (err instanceof ErrorIA && /clave/i.test(err.message))
        return this.decir("Me falta la clave de Claude para entenderte. Cargala en el panel (Configuración → IA).", { intencion: "error_ia" });
      return this.decir(frases.errorTecnico(), { intencion: "error_ia" });
    }
    await anotar(interp.intencion);
    if (interp.intencion === "ignorar") {
      if (enGrupo()) return; // Charla del grupo: no es para el bot.
      interp = { ...interp, intencion: "desconocido" }; // En privado siempre se contesta.
    }
    if (eco) await this.decir(eco, { intencion: "transcripcion" });
    return this.ejecutarSeguro(interp, { ocCitada, borrador });
  }

  private async ejecutarSeguro(interp: Interpretacion, ctx: Ctx) {
    try {
      await this.ejecutar(interp, ctx);
    } catch (err) {
      if (err instanceof ErrorUsuario) return this.decir(`🤔 ${err.message}`);
      await registrar("error", "bot", "Error ejecutando la intención", err);
      return this.decir(frases.errorTecnico());
    }
  }

  private async contexto(historial: Awaited<ReturnType<typeof ultimosMensajes>>, borrador: DatosBorrador | null, ocCitada: number | null) {
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
    else if (borrador)
      propuesta = `${origen} recibido sin propuesta (${borrador.descripcion ?? "sin datos"}). Si el usuario dice cuándo, crear_recordatorio (usá un título que describa el contenido) y se le adjunta ${adjunta}.`;
    let respondiendoA: string | null = null;
    if (ocCitada) {
      const [oc] = await db.select().from(ocurrencia).where(eq(ocurrencia.id, ocCitada));
      const r = oc ? await obtenerRecordatorio(oc.recordatorioId) : null;
      if (r)
        respondiendoA = `El usuario está respondiendo al aviso de "${r.titulo}" (ID ${r.id}${r.rrule ? ", se repite" : ""}). Si dice solo un momento ("mañana", "en 2 horas", "a las 18"), es posponer ese aviso. Si dice que no va o que se suspendió, es cancelar_aviso. Si dice que lo cambiaron de día u hora, es editar.`;
    }
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

  private async confirmar(ocId: number) {
    const oc = await confirmarOcurrencia(ocId);
    if (!oc) return this.decir(frases.yaCerrado());
    const rec = await obtenerRecordatorio(oc.recordatorioId);
    return this.decir(frases.hecho(rec?.titulo ?? "el recordatorio"), { recordatorioId: oc.recordatorioId, intencion: "confirmar" });
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
    await this.decir(frases.rechazado(), { intencion: "rechazar_propuesta" });
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
        const respuestas: string[] = [];
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
          conFoto = null; // La foto y el link van solo con el primero.
          link = null;
          respuestas.push(await textoConfirmacion(rec, !respuestas.length));
          ofrecer ||= items.length === 1 && convieneOfrecerPrevio(rec, it.es_evento);
        }
        if (ctx.borrador) await cerrarBorrador(ctx.borrador.id);
        if (ofrecer) respuestas.push("¿Querés que te avise antes también? Decime, por ejemplo, *1 hora antes* o *el día anterior*.");
        return this.decir(respuestas.join("\n\n"), { intencion: "crear_recordatorio" });
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
        return this.confirmar(oc.id);
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
        return this.decir(`🗒️ Anotado: *${n.titulo}*${b?.datos.adjuntoId ? " (con la foto)" : ""}. Cuando lo necesites, preguntame.`, {
          intencion: "nota_guardar",
        });
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
