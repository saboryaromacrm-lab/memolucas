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
import { analizarFoto, interpretar, type Interpretacion } from "./ia.js";

/** Lo que el procesador necesita de WhatsApp. */
export interface CanalBot {
  responder(texto: string): Promise<string | null>;
  descargarMedia(msg: WAMessage): Promise<Buffer>;
}

const ERROR_IA = "Uy, no pude procesar eso. ¿Me lo repetís?";
const HORAS_BORRADOR = 24;

type DatosBorrador = {
  adjuntoId: number;
  descripcion?: string;
  propuesta?: { titulo: string; fechaHora: string; avisosPreviosMin: number[]; descripcion: string | null } | null;
};

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
  return m?.extendedTextMessage?.contextInfo?.stanzaId ?? m?.imageMessage?.contextInfo?.stanzaId ?? null;
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
    const texto = textoMensaje(msg);
    if (texto?.trim()) return this.texto(msg, texto.trim());
    await registrarMensaje({ direccion: "entrante", tipo: "otro", texto: null, waMessageId: msg.key.id });
    if (m.audioMessage) return this.decir("Por ahora no escucho audios 🙈. Escribime o mandame una foto.");
    if (m.stickerMessage) return;
    await this.decir("Por ahora solo entiendo texto y fotos 🙂");
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
    const adj = await guardarImagen(datos, MIMES_IMAGEN.includes(mime) ? mime : "image/jpeg");
    await registrarMensaje({ direccion: "entrante", tipo: "imagen", texto: epigrafe, waMessageId: msg.key.id, adjuntoId: adj.id });

    let datosBorrador: DatosBorrador = { adjuntoId: adj.id };
    let respuesta: string;
    try {
      const liviana = await imagenParaIa(datos);
      const a = await analizarFoto(cfg, liviana.datos, liviana.mime, epigrafe);
      await db.update(adjunto).set({ descripcionIa: a.descripcion, datosExtraidos: a }).where(eq(adjunto.id, adj.id));
      const fecha = fechaDe(a.propuesta_fecha_hora);
      datosBorrador = {
        adjuntoId: adj.id,
        descripcion: a.descripcion,
        propuesta:
          a.util && fecha && fecha.getTime() > Date.now()
            ? {
                titulo: a.titulo ?? a.descripcion,
                fechaHora: fecha.toISOString(),
                avisosPreviosMin: a.propuesta_avisos_previos_min,
                descripcion: [a.monto && `Monto: ${a.monto}`, a.lugar && `Lugar: ${a.lugar}`].filter(Boolean).join(" · ") || null,
              }
            : null,
      };
      respuesta = a.mensaje;
    } catch {
      respuesta = "Guardé la foto 📎. ¿Cuándo querés que te la recuerde?";
    }
    // Una sola propuesta abierta por vez.
    await db.delete(borradorPendiente);
    await db.insert(borradorPendiente).values({
      tipo: "foto",
      datos: datosBorrador,
      expiraEn: new Date(Date.now() + HORAS_BORRADOR * 3_600_000),
    });
    await this.decir(respuesta, { intencion: "propuesta_foto" });
  }

  private async texto(msg: WAMessage, texto: string) {
    const historial = await ultimosMensajes(5);
    const citado = idCitado(msg);
    const ocCitada = citado ? (await mensajePorWaId(citado))?.ocurrenciaId ?? null : null;
    const entrante = await registrarMensaje({ direccion: "entrante", texto, waMessageId: msg.key.id });
    const anotar = (intencion: string) =>
      db.update(mensaje).set({ intencionDetectada: intencion }).where(eq(mensaje.id, entrante.id));

    // 1) Respuesta rápida a una propuesta de foto.
    const borrador = await borradorActivo();
    if (borrador?.datos.propuesta && esAfirmativo(texto)) {
      await anotar("aceptar_propuesta");
      return this.aceptarBorrador(borrador.id, borrador.datos);
    }
    if (borrador && esNegativo(texto)) {
      await anotar("rechazar_propuesta");
      return this.rechazarBorrador(borrador.id, borrador.datos);
    }

    // 2) Comandos rápidos sin IA. Si responde a un aviso ("mañana", "en 2 horas"), lo interpreta la IA como posponer.
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

    // 3) IA.
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
    if (borrador?.propuesta)
      propuesta = `Foto: ${borrador.descripcion ?? ""}. Propuesta: "${borrador.propuesta.titulo}" el ${aLocal(borrador.propuesta.fechaHora).toFormat("dd/MM HH:mm")}${
        borrador.propuesta.avisosPreviosMin.length ? ` con avisos previos ${borrador.propuesta.avisosPreviosMin.join(", ")} min` : ""
      }. Si el usuario crea un recordatorio ahora, se le adjunta esta foto.`;
    else if (borrador) propuesta = `Foto recibida sin propuesta (${borrador.descripcion ?? "sin datos"}). Si el usuario dice cuándo, crear_recordatorio y se le adjunta la foto.`;
    let respondiendoA: string | null = null;
    if (ocCitada) {
      const [oc] = await db.select().from(ocurrencia).where(eq(ocurrencia.id, ocCitada));
      const r = oc ? await obtenerRecordatorio(oc.recordatorioId) : null;
      if (r) respondiendoA = `El usuario está respondiendo al aviso de "${r.titulo}" (ID ${r.id}). Si dice solo un momento ("mañana", "en 2 horas", "a las 18"), es posponer ese aviso.`;
    }
    return {
      respondiendoA,
      recordatoriosActivos: activos.slice(0, 80).map(lineaRec).join("\n"),
      esperandoConfirmacion: esperandoTxt.join("\n"),
      propuestaPendiente: propuesta,
      historial: historialIa,
    };
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
      descripcion: p.descripcion,
      fechaHora: new Date(p.fechaHora),
      avisosPreviosMin: p.avisosPreviosMin,
      origen: "foto",
      adjuntoId: d.adjuntoId,
    });
    await cerrarBorrador(id);
    await this.decir(await textoConfirmacion(rec), { recordatorioId: rec.id, intencion: "crear_recordatorio" });
  }

  private async rechazarBorrador(id: number, d: DatosBorrador) {
    await cerrarBorrador(id);
    await borrarAdjunto(d.adjuntoId);
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
        for (const it of items) {
          const datos: DatosRecordatorio = {
            titulo: it.titulo!,
            descripcion: it.descripcion,
            fechaHora: fechaDe(it.fecha_hora)!,
            rrule: it.recurrencia,
            avisosPreviosMin: it.avisos_previos_min ?? [],
            origen: conFoto ? "foto" : "whatsapp",
            adjuntoId: conFoto,
          };
          const rec = await crearRecordatorio(datos);
          conFoto = null; // La foto va solo con el primero.
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
      case "ayuda":
        return this.decir(TEXTO_AYUDA, { intencion: "ayuda" });
      default:
        return this.decir(i.respuesta ?? "No te entendí bien 🤔. Probá con algo como _recordame mañana a las 10 pagar la luz_, o escribí *ayuda*.", {
          intencion: i.intencion,
        });
    }
  }
}
