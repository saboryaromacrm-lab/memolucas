import type { WAMessage } from "baileys";
import { desc, eq, gt } from "drizzle-orm";
import { DateTime } from "luxon";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import { adjunto, borradorPendiente, mensaje, ocurrencia, type Ocurrencia, type Recordatorio } from "../db/schema.js";
import { ahora, aLocal, formatearCuando } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { describirRrule } from "../lib/recurrencia.js";
import { describirMinutos } from "../lib/textos.js";
import { borrarAdjunto, guardarImagen, imagenParaIa, MIMES_IMAGEN } from "../servicios/adjuntos.js";
import { actualizarConfig, obtenerConfig, plantillasDe, renderizar } from "../servicios/configuracion.js";
import { listarRango } from "./rangos.js";
import { rangoHoy, rangoManana, rangoSemana, textoListado, textoTodos } from "../servicios/listados.js";
import { mensajePorWaId, registrarMensaje, ultimosMensajes } from "../servicios/mensajes.js";
import {
  actualizarRecordatorio,
  borrarRecordatorio,
  confirmarOcurrencia,
  crearRecordatorio,
  ErrorUsuario,
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
import { analizarEnlace, analizarFoto, interpretar, responderConNotas, type Interpretacion } from "./ia.js";
import { ErrorAudio, transcribir } from "../servicios/audio.js";
import {
  agregarItems,
  borrarLista,
  buscarLista,
  obtenerLista,
  obtenerOCrearLista,
  quitarItems,
  textoLista,
  todasLasListas,
  vaciarLista,
} from "../servicios/listas.js";
import { actualizarNota, borrarNota, crearNota, obtenerNota, relacionadas, todasLasNotas } from "../servicios/notas.js";
import { obtenerAdjunto } from "../servicios/adjuntos.js";
import { normalizar } from "../lib/textos.js";

/** Lo que el procesador necesita de WhatsApp. */
export interface CanalBot {
  responder(texto: string): Promise<string | null>;
  responderImagen(ruta: string, mime: string, epigrafe: string): Promise<string | null>;
  descargarMedia(msg: WAMessage): Promise<Buffer>;
}

/** "guardala como nota", "anotá esto": la foto va a notas y no a recordatorios. */
const PIDE_NOTA = /\b(nota|anota|anotala|anotalo)\b/;

const ERROR_IA = "Uy, no pude procesar eso. ¿Me lo repetís?";
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

async function guardarBorrador(datos: DatosBorrador) {
  // Una sola propuesta abierta por vez.
  await db.delete(borradorPendiente);
  await db.insert(borradorPendiente).values({ tipo: "foto", datos, expiraEn: new Date(Date.now() + HORAS_BORRADOR * 3_600_000) });
}

// ───────────── Helpers de texto ─────────────

export function describirCuando(r: Pick<Recordatorio, "rrule" | "fechaHora" | "proximaInstancia" | "avisosPreviosMin">): string {
  let texto = r.rrule ? describirRrule(r.rrule, r.fechaHora) : formatearCuando(r.proximaInstancia ?? r.fechaHora);
  const previos = r.avisosPreviosMin.filter((m) => m > 0).sort((a, b) => a - b);
  if (previos.length) texto += ` (con aviso ${previos.map((m) => `${describirMinutos(m)} antes`).join(" y ")})`;
  return texto;
}

async function textoConfirmacion(r: Recordatorio): Promise<string> {
  const cfg = await obtenerConfig();
  return renderizar(plantillasDe(cfg).confirmacion, {
    titulo: r.titulo,
    cuando: describirCuando(r),
    hora: aLocal(r.proximaInstancia ?? r.fechaHora).toFormat("H:mm"),
    fecha: aLocal(r.proximaInstancia ?? r.fechaHora).toFormat("dd/MM"),
    descripcion: r.descripcion ?? "",
    nombre: cfg.nombreUsuario,
  });
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

async function borradorActivo() {
  const [b] = await db
    .select()
    .from(borradorPendiente)
    .where(gt(borradorPendiente.expiraEn, new Date()))
    .orderBy(desc(borradorPendiente.id))
    .limit(1);
  return b ? { id: b.id, datos: b.datos as unknown as DatosBorrador } : null;
}

async function cerrarBorrador(id: number) {
  await db.delete(borradorPendiente).where(eq(borradorPendiente.id, id));
}

// ───────────── Procesador ─────────────

export class Procesador {
  constructor(private canal: CanalBot) {}

  private async decir(texto: string, extra: { recordatorioId?: number | null; intencion?: string } = {}) {
    const id = await this.canal.responder(texto);
    await registrarMensaje({
      direccion: "saliente",
      texto,
      waMessageId: id,
      recordatorioId: extra.recordatorioId ?? null,
      intencionDetectada: extra.intencion ?? null,
    });
  }

  async procesar(msg: WAMessage): Promise<void> {
    const m = msg.message;
    if (!m) return;
    if (m.reactionMessage) return this.reaccion(msg);
    if (m.imageMessage) return this.foto(msg);
    if (m.audioMessage) return this.audio(msg);
    const texto = textoMensaje(msg);
    if (texto?.trim()) return this.texto(msg, texto.trim());
    await registrarMensaje({ direccion: "entrante", tipo: "otro", texto: null, waMessageId: msg.key.id });
    if (m.stickerMessage) return;
    await this.decir("Por ahora entiendo texto, audios, fotos y links 🙂");
  }

  /** Audio: se transcribe con Groq, se muestra lo entendido y se procesa como texto. */
  private async audio(msg: WAMessage) {
    const a = msg.message!.audioMessage!;
    const cfg = await obtenerConfig();
    const segundos = Number(a.seconds ?? 0);
    if (segundos > cfg.audioMaxSegundos) {
      await registrarMensaje({ direccion: "entrante", tipo: "audio", texto: null, waMessageId: msg.key.id });
      const max = cfg.audioMaxSegundos >= 60 ? `${Math.round(cfg.audioMaxSegundos / 60)} min` : `${cfg.audioMaxSegundos} s`;
      return this.decir(`Ese audio es muy largo (máximo ${max}). ¿Me lo mandás más corto o por partes?`);
    }
    let transcripcion: string;
    try {
      const datos = await this.canal.descargarMedia(msg);
      transcripcion = await transcribir(cfg, datos, a.mimetype ?? "audio/ogg");
    } catch (err) {
      await registrarMensaje({ direccion: "entrante", tipo: "audio", texto: null, waMessageId: msg.key.id });
      await registrar("error", "audio", "No se pudo transcribir el audio", err);
      if (err instanceof ErrorAudio && /falta/i.test(err.message))
        return this.decir("Para entender audios falta cargar la clave de Groq en el panel (Configuración → Audios).");
      return this.decir("No pude entender el audio 😕. ¿Me lo repetís o me lo escribís?");
    }
    if (!transcripcion) {
      await registrarMensaje({ direccion: "entrante", tipo: "audio", texto: null, waMessageId: msg.key.id });
      return this.decir("No escuché nada en ese audio 🤔. ¿Me lo mandás de nuevo?");
    }
    await this.decir(`🎙️ Entendí: “${transcripcion}”`, { intencion: "transcripcion" });
    return this.texto(msg, transcripcion, "audio");
  }

  private async reaccion(msg: WAMessage) {
    const r = msg.message!.reactionMessage!;
    const emoji = r.text ?? "";
    await registrarMensaje({ direccion: "entrante", tipo: "reaccion", texto: emoji, waMessageId: msg.key.id });
    if (!EMOJIS_CONFIRMACION.includes(emoji) || !r.key?.id) return;
    const original = await mensajePorWaId(r.key.id);
    if (!original?.ocurrenciaId) return;
    const oc = await confirmarOcurrencia(original.ocurrenciaId);
    if (!oc) return;
    const rec = await obtenerRecordatorio(oc.recordatorioId);
    await this.decir(`Listo ✅ Marqué *${rec?.titulo ?? "el recordatorio"}* como hecho.`, { recordatorioId: oc.recordatorioId, intencion: "confirmar" });
  }

  private async foto(msg: WAMessage) {
    const img = msg.message!.imageMessage!;
    const cfg = await obtenerConfig();
    const epigrafe = img.caption?.trim() || null;
    const mime = (img.mimetype ?? "image/jpeg").split(";")[0];
    const tamano = Number(img.fileLength ?? 0);
    if (tamano > cfg.fotoMaxMb * 1024 * 1024) {
      await registrarMensaje({ direccion: "entrante", tipo: "imagen", texto: epigrafe, waMessageId: msg.key.id });
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
    const adj = await guardarImagen(datos, MIMES_IMAGEN.includes(mime) ? mime : "image/jpeg");
    await registrarMensaje({ direccion: "entrante", tipo: "imagen", texto: epigrafe, waMessageId: msg.key.id, adjuntoId: adj.id });

    if (epigrafe && PIDE_NOTA.test(normalizar(epigrafe))) return this.fotoComoNota(adj.id, datos, epigrafe);

    let datosBorrador: DatosBorrador = { adjuntoId: adj.id, url };
    let respuesta: string;
    try {
      const liviana = await imagenParaIa(datos);
      const a = await analizarFoto(cfg, liviana.datos, liviana.mime, epigrafe);
      await db.update(adjunto).set({ descripcionIa: a.descripcion, datosExtraidos: a }).where(eq(adjunto.id, adj.id));
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
    await guardarBorrador(datosBorrador);
    await this.decir(respuesta, { intencion: "propuesta_foto" });
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
    return this.decir(`🗒️ Guardé la nota *${n.titulo}* con la foto. Preguntame cuando la necesites.`, { intencion: "nota_guardar" });
  }

  private async texto(msg: WAMessage, texto: string, tipo: "texto" | "audio" = "texto") {
    const historial = await ultimosMensajes(5);
    const citado = idCitado(msg);
    const ocCitada = citado ? (await mensajePorWaId(citado))?.ocurrenciaId ?? null : null;
    const entrante = await registrarMensaje({ direccion: "entrante", texto, tipo, waMessageId: msg.key.id });
    const anotar = (intencion: string) =>
      db.update(mensaje).set({ intencionDetectada: intencion }).where(eq(mensaje.id, entrante.id));

    // 1) Links: se leen y se analizan.
    const urls = extraerUrls(texto);
    if (urls.length) {
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
    const cmd = ocCitada && comando?.tipo === "listar" ? null : comando;
    if (cmd) {
      await anotar(cmd.tipo);
      switch (cmd.tipo) {
        case "listar": {
          const t =
            cmd.rango === "todos"
              ? await textoTodos()
              : await textoListado(cmd.rango === "hoy" ? rangoHoy() : cmd.rango === "manana" ? rangoManana() : rangoSemana());
          return this.decir(t, { intencion: "listar" });
        }
        case "ayuda":
          return this.decir(TEXTO_AYUDA, { intencion: "ayuda" });
        case "listas":
          return this.decir(await this.textoListas(), { intencion: "lista_ver" });
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
          const oc = ocCitada ? { id: ocCitada } : await ultimaOcurrenciaEnviada();
          if (!oc) {
            if (cmd.explicito) return this.decir("No tengo ningún aviso esperando confirmación 👌");
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
    } catch {
      return this.decir(ERROR_IA, { intencion: "error_ia" });
    }
    await anotar(interp.intencion);
    try {
      await this.ejecutar(interp, { ocCitada, borrador });
    } catch (err) {
      if (err instanceof ErrorUsuario) return this.decir(`🤔 ${err.message}`);
      await registrar("error", "bot", "Error ejecutando la intención", err);
      return this.decir(ERROR_IA);
    }
  }

  private async contexto(historial: Awaited<ReturnType<typeof ultimosMensajes>>, borrador: DatosBorrador | null, ocCitada: number | null) {
    const activos = await recordatoriosActivos();
    const esperando = await pendientesSinConfirmar();
    const ultima = await ultimaOcurrenciaEnviada();
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
      .map((h) => ({ role: h.direccion === "entrante" ? "user" : "assistant", content: h.texto! }));
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
      if (r) respondiendoA = `El usuario está respondiendo al aviso de "${r.titulo}" (ID ${r.id}). Si dice solo un momento ("mañana", "en 2 horas", "a las 18"), es posponer ese aviso.`;
    }
    const listas = (await todasLasListas())
      .map((l) => `${l.nombre}: ${l.items.map((i) => `[${i.id}] ${i.texto}${i.cantidad ? ` (${i.cantidad})` : ""}`).join("; ") || "(vacía)"}`)
      .join("\n");
    const notas = (await todasLasNotas())
      .slice(0, 100)
      .map((n) => `${n.id} | ${n.titulo} | ${n.categoria}`)
      .join("\n");
    return {
      respondiendoA,
      listas,
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
      return this.decir(`Leí el link${contenido.titulo ? ` (*${contenido.titulo}*)` : ""}. ¿Cuándo querés que te lo recuerde?`, {
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

    await guardarBorrador({
      url,
      adjuntoId,
      titulo: a.titulo,
      descripcion: a.resumen,
      propuesta:
        a.accion !== "preguntar" && futura
          ? { titulo: a.titulo, fechaHora: futura.toISOString(), avisosPreviosMin: a.propuesta_avisos_previos_min, descripcion: a.lugar ? `Lugar: ${a.lugar}` : null }
          : null,
    });
    return this.decir(a.mensaje, { intencion: "propuesta_enlace" });
  }

  private async textoListas(): Promise<string> {
    const ls = await todasLasListas();
    if (!ls.length) return "No tenés listas todavía. Probá: _agregá leche a la lista del súper_ 🛒";
    if (ls.length === 1) return textoLista(ls[0]);
    return `📝 Tus listas:\n${ls.map((l) => `• *${l.nombre}* (${l.items.length})`).join("\n")}\n\nPedime una: _pasame la lista del súper_.`;
  }

  private async textoNotas(): Promise<string> {
    const ns = await todasLasNotas();
    if (!ns.length) return "Todavía no tenés notas. Probá: _anotá que la clave del wifi es…_ 🗒️";
    const lineas = ns.slice(0, 40).map((n) => `• ${n.titulo} _(${n.categoria})_${n.adjuntoId ? " 📎" : ""}`);
    return `🗒️ Tus notas (${ns.length}):\n${lineas.join("\n")}${ns.length > 40 ? "\n…y más en el panel." : ""}\n\nPreguntame: _¿cuál era la clave del wifi?_`;
  }

  private async confirmar(ocId: number) {
    const oc = await confirmarOcurrencia(ocId);
    if (!oc) return this.decir("Ese aviso ya estaba cerrado 👌");
    const rec = await obtenerRecordatorio(oc.recordatorioId);
    return this.decir(`Listo ✅ ¡Bien ahí! Marqué *${rec?.titulo ?? "el recordatorio"}* como hecho.`, {
      recordatorioId: oc.recordatorioId,
      intencion: "confirmar",
    });
  }

  private async aceptarBorrador(id: number, d: DatosBorrador) {
    const p = d.propuesta!;
    const rec = await crearRecordatorio({
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
    await this.decir("Dale, no te lo recuerdo 👍", { intencion: "rechazar_propuesta" });
  }

  private async elegir(ids: number[], accion: string): Promise<Recordatorio | null> {
    const recs = (await Promise.all(ids.map((i) => obtenerRecordatorio(i)))).filter((r): r is Recordatorio => !!r);
    if (recs.length === 1) return recs[0];
    if (!recs.length) {
      await this.decir(`No encontré cuál querés ${accion}. ¿Me decís el nombre? (Escribí *lista* para verlos todos)`);
      return null;
    }
    const opciones = recs.map((r, i) => `${i + 1}) *${r.titulo}* — ${describirCuando(r)}`).join("\n");
    await this.decir(`Encontré varios:\n${opciones}\n\n¿Cuál querés ${accion}?`);
    return null;
  }

  private async ejecutar(i: Interpretacion, ctx: { ocCitada: number | null; borrador: Awaited<ReturnType<typeof borradorActivo>> }) {
    switch (i.intencion) {
      case "crear_recordatorio": {
        const items = i.recordatorios.filter((r) => r.titulo && fechaDe(r.fecha_hora));
        if (i.falta_info || !items.length) return this.decir(i.respuesta ?? "¿Para cuándo te lo recuerdo?", { intencion: "falta_info" });
        const respuestas: string[] = [];
        let conFoto = ctx.borrador?.datos.adjuntoId ?? null;
        let link = ctx.borrador?.datos.url ?? null;
        for (const it of items) {
          const listaId = it.lista ? (await obtenerOCrearLista(it.lista)).id : null;
          const datos: DatosRecordatorio = {
            titulo: it.titulo!,
            listaId,
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
          respuestas.push(await textoConfirmacion(rec));
        }
        if (ctx.borrador) await cerrarBorrador(ctx.borrador.id);
        return this.decir(respuestas.join("\n"), { intencion: "crear_recordatorio" });
      }
      case "aceptar_propuesta":
        if (ctx.borrador?.datos.propuesta) return this.aceptarBorrador(ctx.borrador.id, ctx.borrador.datos);
        return this.decir(i.respuesta ?? "¿Qué querés que te recuerde y cuándo?");
      case "rechazar_propuesta":
        if (ctx.borrador) return this.rechazarBorrador(ctx.borrador.id, ctx.borrador.datos);
        return this.decir("Dale 👍");
      case "listar": {
        const desde = fechaDe(i.listar_desde);
        const hasta = fechaDe(i.listar_hasta);
        if (!desde && !hasta) return this.decir(await textoTodos(), { intencion: "listar" });
        return this.decir(await textoListado(listarRango(desde, hasta)), { intencion: "listar" });
      }
      case "confirmar": {
        let oc: Pick<Ocurrencia, "id"> | null = ctx.ocCitada ? { id: ctx.ocCitada } : null;
        if (!oc && i.recordatorio_ids.length === 1) oc = await ultimaOcurrenciaEnviada(i.recordatorio_ids[0]);
        oc ??= await ultimaOcurrenciaEnviada();
        if (!oc) return this.decir("No tengo ningún aviso esperando confirmación 👌");
        return this.confirmar(oc.id);
      }
      case "posponer": {
        const hasta = fechaDe(i.posponer_hasta) ?? (i.posponer_minutos ? new Date(Date.now() + i.posponer_minutos * 60_000) : null);
        if (!hasta || hasta.getTime() <= Date.now()) return this.decir(i.respuesta ?? "¿Para cuándo lo pospongo?");
        let oc: Pick<Ocurrencia, "id"> | null = ctx.ocCitada ? { id: ctx.ocCitada } : null;
        if (!oc && i.recordatorio_ids.length === 1)
          oc = (await ultimaOcurrenciaEnviada(i.recordatorio_ids[0])) ?? (await proximaOcurrenciaPendiente(i.recordatorio_ids[0]));
        if (!oc && i.recordatorio_ids.length > 1) {
          await this.elegir(i.recordatorio_ids, "posponer");
          return;
        }
        oc ??= await ultimaOcurrenciaEnviada();
        if (!oc) return this.decir("No encontré qué posponer. ¿Me decís cuál?");
        const pos = await posponerOcurrencia(oc.id, hasta);
        if (!pos) return this.decir("Ese aviso ya estaba cerrado 👌");
        const rec = await obtenerRecordatorio(pos.recordatorioId);
        return this.decir(`Dale ⏰ Te vuelvo a recordar *${rec?.titulo ?? ""}* ${formatearCuando(hasta)}.`, {
          recordatorioId: pos.recordatorioId,
          intencion: "posponer",
        });
      }
      case "editar": {
        const rec = await this.elegir(i.recordatorio_ids, "cambiar");
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
        const nuevo = await actualizarRecordatorio(rec.id, cambios);
        return this.decir(`Listo ✏️ *${nuevo.titulo}*: ${describirCuando(nuevo)}.`, { recordatorioId: rec.id, intencion: "editar" });
      }
      case "borrar": {
        const rec = await this.elegir(i.recordatorio_ids, "borrar");
        if (!rec) return;
        await borrarRecordatorio(rec.id);
        return this.decir(`Listo 🗑️ Borré *${rec.titulo}*.`, { recordatorioId: rec.id, intencion: "borrar" });
      }
      case "pausar": {
        const rec = await this.elegir(i.recordatorio_ids, "pausar");
        if (!rec) return;
        await pausarRecordatorio(rec.id);
        return this.decir(`⏸️ Pausé *${rec.titulo}*. Decime "reanudá ${rec.titulo.toLowerCase()}" cuando quieras retomarlo.`, {
          recordatorioId: rec.id,
          intencion: "pausar",
        });
      }
      case "reanudar": {
        const rec = await this.elegir(i.recordatorio_ids, "reanudar");
        if (!rec) return;
        await reanudarRecordatorio(rec.id);
        const r = (await obtenerRecordatorio(rec.id))!;
        return this.decir(`▶️ Reanudé *${r.titulo}*: ${describirCuando(r)}.`, { recordatorioId: rec.id, intencion: "reanudar" });
      }
      case "lista_agregar": {
        const items = i.lista_items.filter((x) => x.texto.trim());
        if (!items.length) return this.decir(i.respuesta ?? "¿Qué querés agregar a la lista?");
        const l = await obtenerOCrearLista(i.lista ?? "Pendientes");
        const nuevos = await agregarItems(l.id, items);
        const total = (await obtenerLista(l.id))?.items.length ?? 0;
        if (!nuevos.length) return this.decir(`Eso ya estaba en *${l.nombre}* 👌 (${total} en total)`, { intencion: "lista_agregar" });
        const lineas = nuevos.map((x) => `${x.texto}${x.cantidad ? ` (${x.cantidad})` : ""}`).join(", ");
        return this.decir(`🛒 Agregué a *${l.nombre}*: ${lineas}. (${total} en total)`, { intencion: "lista_agregar" });
      }
      case "lista_quitar": {
        const borrados = await quitarItems(i.lista_item_ids);
        if (!borrados.length) return this.decir(i.respuesta ?? "No encontré eso en tus listas 🤔. Escribí *listas* para verlas.");
        const l = await obtenerLista(borrados[0].listaId);
        const quedan = l?.items.length ?? 0;
        return this.decir(
          `✅ Listo, saqué: ${borrados.map((b) => b.texto).join(", ")}.${l ? ` En *${l.nombre}* ${quedan ? `quedan ${quedan}` : "no queda nada 🙌"}.` : ""}`,
          { intencion: "lista_quitar" },
        );
      }
      case "lista_ver": {
        if (!i.lista) return this.decir(await this.textoListas(), { intencion: "lista_ver" });
        const l = await buscarLista(i.lista);
        if (!l) return this.decir(`No tenés una lista "${i.lista}". ${await this.textoListas()}`);
        return this.decir(textoLista((await obtenerLista(l.id))!), { intencion: "lista_ver" });
      }
      case "lista_vaciar":
      case "lista_borrar": {
        const l = i.lista ? await buscarLista(i.lista) : null;
        if (!l) return this.decir("¿Qué lista? Escribí *listas* para verlas.");
        if (i.intencion === "lista_vaciar") {
          await vaciarLista(l.id);
          return this.decir(`🧹 Vacié *${l.nombre}*.`, { intencion: i.intencion });
        }
        await borrarLista(l.id);
        return this.decir(`🗑️ Borré la lista *${l.nombre}*.`, { intencion: i.intencion });
      }
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
        return this.decir(`🗒️ Anotado: *${n.titulo}*${b?.datos.adjuntoId ? " (con la foto)" : ""}. Preguntame cuando lo necesites.`, {
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
      case "ayuda":
        return this.decir(TEXTO_AYUDA, { intencion: "ayuda" });
      default:
        return this.decir(i.respuesta ?? "No te entendí bien 🤔. Probá con algo como _recordame mañana a las 10 pagar la luz_, o escribí *ayuda*.", {
          intencion: i.intencion,
        });
    }
  }
}
