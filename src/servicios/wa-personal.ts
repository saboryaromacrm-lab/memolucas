import { and, asc, desc, eq, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { isJidGroup, normalizeMessageContent, proto, type WAMessage } from "baileys";
import { db } from "../db/index.js";
import { waChat, waMensaje, waProgramado } from "../db/schema.js";
import { abrir, sellar } from "../lib/cifrado.js";
import { bus } from "../lib/eventos.js";
import { formatearCuando } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { normalizar } from "../lib/textos.js";
import { mostrarNumero } from "../whatsapp/numeros.js";
import { enviador } from "./enviador.js";
import { registrarMensaje, ultimosMensajes } from "./mensajes.js";
import { ErrorUsuario } from "./recordatorios.js";

// Tu WhatsApp, del lado de los datos: lo que llega se guarda 7 días (cifrado) para que el asistente lo lea, resuma y
// busque; los envíos siempre pasan por tu confirmación. Tus apodos ("Maca") apuntan siempre al mismo chat.

export const DIAS_GUARDADO = 7;
const DIA_MS = 86_400_000;
/** Un programado que no se pudo mandar a tiempo (tu WhatsApp estaba desconectado) ya no se manda pasado este rato. */
const HORAS_TOLERANCIA_PROGRAMADO = 2;

type DatosMensaje = { texto: string; autor: string | null };
const ILEGIBLE: DatosMensaje = { texto: "(no se pudo leer)", autor: null };

// ───────────── Chats y contactos ─────────────

export type DatosChat = { jid: string; nombre?: string | null; apodo?: string | null };

/** Guarda chats y contactos. Solo pisa los nombres que vienen (un contacto sin nombre no borra el de la agenda). */
export async function guardarChatsWa(chats: DatosChat[]) {
  const porJid = new Map<string, DatosChat>();
  for (const c of chats) porJid.set(c.jid, { ...porJid.get(c.jid), ...Object.fromEntries(Object.entries(c).filter(([, v]) => v)), jid: c.jid });
  const filas = [...porJid.values()].map((c) => ({ jid: c.jid, nombre: c.nombre || null, apodo: c.apodo || null, esGrupo: !!isJidGroup(c.jid) }));
  for (let i = 0; i < filas.length; i += 500)
    await db
      .insert(waChat)
      .values(filas.slice(i, i + 500))
      .onConflictDoUpdate({
        target: waChat.jid,
        set: { nombre: sql`coalesce(excluded.nombre, ${waChat.nombre})`, apodo: sql`coalesce(excluded.apodo, ${waChat.apodo})` },
      });
}

const nombreDe = (c: { jid: string; nombre: string | null; apodo: string | null; esGrupo: boolean }) =>
  c.nombre || c.apodo || (c.esGrupo ? "Grupo" : mostrarNumero(c.jid.split("@")[0]));

/**
 * Chats y contactos: los que coinciden con la consulta (nombre, alias o número), o los de mensajes más recientes.
 * Si la consulta es uno de tus alias, devuelve solo ese chat.
 */
export async function listarChatsWa(consulta?: string, limite = 20) {
  const filas = await db.select().from(waChat).orderBy(sql`${waChat.ultimoMensajeEn} desc nulls last`);
  const buscado = normalizar(consulta ?? "");
  const porAlias = filas.filter((c) => c.alias && normalizar(c.alias) === buscado);
  const palabras = buscado.split(" ").filter(Boolean);
  return (porAlias.length ? porAlias : filas.filter((c) => palabras.every((p) => normalizar(`${c.nombre ?? ""} ${c.apodo ?? ""} ${c.alias ?? ""} ${c.jid.split("@")[0]}`).includes(p))))
    .slice(0, limite)
    .map((c) => ({ jid: c.jid, nombre: nombreDe(c), alias: c.alias, esGrupo: c.esGrupo, ultimoMensaje: c.ultimoMensajeEn }));
}

/** "Cuando digo Maca es Macarena Oviedo": el alias queda en ese chat (y deja de estar en cualquier otro). */
export async function fijarAliasWa(chatJid: string, alias: string) {
  const a = alias.trim();
  if (!a) throw new ErrorUsuario("El apodo está vacío.");
  const conEse = (await db.select().from(waChat)).filter((c) => c.alias && normalizar(c.alias) === normalizar(a));
  if (conEse.length) await db.update(waChat).set({ alias: null }).where(inArray(waChat.jid, conEse.map((c) => c.jid)));
  const [fila] = await db.update(waChat).set({ alias: a }).where(eq(waChat.jid, chatJid)).returning();
  if (!fila) throw new ErrorUsuario("Ese chat no está entre tus contactos.");
  return `Listo: "${a}" es siempre ${nombreDe(fila)}.`;
}

async function chatsPorJid(jids: string[]) {
  const filas = jids.length ? await db.select().from(waChat).where(inArray(waChat.jid, [...new Set(jids)])) : [];
  return new Map(filas.map((c) => [c.jid, c]));
}

export async function nombreDeChatWa(jid: string) {
  const c = (await chatsPorJid([jid])).get(jid);
  return c ? nombreDe(c) : nombreDe({ jid, nombre: null, apodo: null, esGrupo: !!isJidGroup(jid) });
}

// ───────────── Mensajes ─────────────

/** Lo legible de un mensaje; lo que no es texto va con una etiqueta. null: no se guarda (reacciones, avisos internos…). */
export function textoDeMensaje(contenido: proto.IMessage | null | undefined): string | null {
  const m = normalizeMessageContent(contenido);
  if (!m) return null;
  const con = (etiqueta: string, texto?: string | null) => (texto?.trim() ? `${etiqueta} ${texto.trim()}` : etiqueta);
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return con("[foto]", m.imageMessage.caption);
  if (m.videoMessage) return con("[video]", m.videoMessage.caption);
  if (m.audioMessage) return m.audioMessage.ptt ? "[audio de voz]" : "[audio]";
  if (m.documentMessage) return con(`[documento: ${m.documentMessage.fileName ?? "archivo"}]`, m.documentMessage.caption);
  if (m.stickerMessage) return "[sticker]";
  if (m.locationMessage) return con("[ubicación]", m.locationMessage.name ?? m.locationMessage.address);
  if (m.contactMessage) return `[contacto: ${m.contactMessage.displayName ?? ""}]`;
  const encuesta = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
  if (encuesta) return con("[encuesta]", encuesta.name);
  return null;
}

const segundos = (t: WAMessage["messageTimestamp"]) => Number(t ?? 0);

/**
 * Guarda los mensajes que llegan (o que mandaste desde el teléfono). chatJid: el chat ya resuelto (con el número en vez
 * del LID cuando se sabe). masAtras: se trajeron a pedido de más de 7 días atrás (se guardan 1 día).
 * Respeta lo editado y lo borrado para todos. Devuelve cuántos mensajes nuevos se guardaron.
 */
export async function guardarMensajesWa(items: { msg: WAMessage; chatJid: string }[], masAtras = false): Promise<number> {
  const ya = Date.now();
  const filas: (typeof waMensaje.$inferInsert)[] = [];
  const chats = new Map<string, { ultimo: Date; apodo: string | null }>();
  for (const { msg, chatJid } of items) {
    const protocolo = normalizeMessageContent(msg.message)?.protocolMessage;
    if (protocolo?.key?.id) {
      if (protocolo.type === proto.Message.ProtocolMessage.Type.REVOKE)
        await db.delete(waMensaje).where(and(eq(waMensaje.chatJid, chatJid), eq(waMensaje.waId, protocolo.key.id)));
      const editado = protocolo.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT ? textoDeMensaje(protocolo.editedMessage) : null;
      if (editado) await editarMensajeWa(chatJid, protocolo.key.id, editado);
      continue;
    }
    const texto = textoDeMensaje(msg.message);
    const enviadoEn = new Date(segundos(msg.messageTimestamp) * 1000);
    const guardarHasta = new Date(Math.max(enviadoEn.getTime() + DIAS_GUARDADO * DIA_MS, masAtras ? ya + DIA_MS : 0));
    if (!texto || !msg.key.id || guardarHasta.getTime() <= ya) continue;
    const deMi = !!msg.key.fromMe;
    const autor = !deMi && isJidGroup(chatJid) ? msg.pushName?.trim() || null : null;
    filas.push({ waId: msg.key.id, chatJid, remoteJid: msg.key.remoteJid ?? chatJid, deMi, datosCifrados: sellar({ texto, autor }), enviadoEn, guardarHasta });
    const c = chats.get(chatJid);
    const apodo = !deMi && !isJidGroup(chatJid) ? msg.pushName?.trim() || null : null;
    chats.set(chatJid, { ultimo: c && c.ultimo > enviadoEn ? c.ultimo : enviadoEn, apodo: apodo ?? c?.apodo ?? null });
  }
  let nuevos = 0;
  for (let i = 0; i < filas.length; i += 500)
    nuevos += (await db.insert(waMensaje).values(filas.slice(i, i + 500)).onConflictDoNothing().returning({ id: waMensaje.id })).length;
  if (chats.size) {
    await guardarChatsWa([...chats].map(([jid, c]) => ({ jid, apodo: c.apodo })));
    for (const [jid, c] of chats)
      await db
        .update(waChat)
        .set({ ultimoMensajeEn: sql`greatest(${waChat.ultimoMensajeEn}, ${c.ultimo.toISOString()}::timestamptz)` })
        .where(eq(waChat.jid, jid));
  }
  return nuevos;
}

async function editarMensajeWa(chatJid: string, waId: string, texto: string) {
  const [fila] = await db.select().from(waMensaje).where(and(eq(waMensaje.chatJid, chatJid), eq(waMensaje.waId, waId)));
  if (!fila) return;
  const datos = abrir<DatosMensaje>(fila.datosCifrados, ILEGIBLE);
  await db.update(waMensaje).set({ datosCifrados: sellar({ ...datos, texto }) }).where(eq(waMensaje.id, fila.id));
}

export type MensajeLeido = { chat: string; chatJid: string; fecha: Date; de: string; texto: string };

async function leer(filas: (typeof waMensaje.$inferSelect)[]): Promise<MensajeLeido[]> {
  const chats = await chatsPorJid(filas.map((f) => f.chatJid));
  return filas.map((f) => {
    const d = abrir<DatosMensaje>(f.datosCifrados, ILEGIBLE);
    const c = chats.get(f.chatJid);
    const chat = c ? nombreDe(c) : f.chatJid;
    return { chat, chatJid: f.chatJid, fecha: f.enviadoEn, de: f.deMi ? "Yo" : d.autor || chat, texto: d.texto };
  });
}

/** Los últimos mensajes de un chat, del más viejo al más nuevo. */
export async function leerChatWa(chatJid: string, cantidad = 40) {
  const filas = await db.select().from(waMensaje).where(eq(waMensaje.chatJid, chatJid)).orderBy(desc(waMensaje.enviadoEn)).limit(cantidad);
  return leer(filas.reverse());
}

/** Busca palabras en los mensajes guardados (todas tienen que aparecer), de los más nuevos a los más viejos. */
export async function buscarMensajesWa(consulta: string, chatJid?: string, limite = 30) {
  const palabras = normalizar(consulta).split(" ").filter(Boolean);
  const filas = await db.select().from(waMensaje).where(chatJid ? eq(waMensaje.chatJid, chatJid) : undefined).orderBy(desc(waMensaje.enviadoEn));
  return (await leer(filas)).filter((m) => palabras.every((p) => normalizar(`${m.texto} ${m.de} ${m.chat}`).includes(p))).slice(0, limite);
}

/** El mensaje más viejo guardado de un chat: desde ahí se le piden más al teléfono. */
export async function masViejoWa(chatJid: string) {
  const [fila] = await db.select().from(waMensaje).where(eq(waMensaje.chatJid, chatJid)).orderBy(asc(waMensaje.enviadoEn)).limit(1);
  return fila ?? null;
}

export async function resumenWa() {
  const [{ chats }] = await db.select({ chats: sql<number>`count(*)::int` }).from(waChat);
  const [{ mensajes }] = await db.select({ mensajes: sql<number>`count(*)::int` }).from(waMensaje);
  return { chats, mensajes };
}

/** Mantenimiento: borra los mensajes vencidos y los programados viejos ya resueltos. */
export async function purgarWa() {
  const ya = new Date();
  await db.delete(waMensaje).where(lt(waMensaje.guardarHasta, ya));
  await db.delete(waProgramado).where(and(ne(waProgramado.estado, "pendiente"), lt(waProgramado.enviarEn, new Date(ya.getTime() - DIAS_GUARDADO * DIA_MS))));
}

/** Al desvincular tu WhatsApp: no queda nada. */
export async function borrarTodoWa() {
  await db.delete(waMensaje);
  await db.delete(waProgramado);
  await db.delete(waChat);
  bus.avisar("whatsapp");
}

// ───────────── Envíos (siempre con tu confirmación) ─────────────

/** Lo que se necesita de tu WhatsApp para mandar. */
export type CanalPersonal = { conectado(): boolean; enviar(jid: string, texto: string): Promise<unknown> };

/**
 * Para comparar lo que el asistente te mostró con lo que se va a mandar: sin formato, comillas, espacios de más ni las
 * variantes invisibles de los emojis (❤ y ❤️ son el mismo corazón).
 */
const comparable = (t: string) =>
  t
    .toLowerCase()
    .replace(/[*_~"“”'‘’«»\uFE0F\u200D]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * ¿Ya te lo mostró y le contestaste? Tu último mensaje tiene que ser la respuesta directa a un mensaje del asistente
 * que mostraba para quién y el texto exacto. Así no depende de que el asistente recuerde nada entre mensajes, y no
 * puede mandar algo que no viste.
 */
async function loViste(para: string, texto: string): Promise<boolean> {
  const recientes = await ultimosMensajes(10, null);
  const tuyo = recientes.findLastIndex((m) => m.direccion === "entrante");
  const anterior = recientes.slice(0, Math.max(tuyo, 0)).findLast((m) => m.texto && (m.direccion === "entrante" || m.intencionDetectada === "agente"));
  if (tuyo < 0 || !anterior || anterior.direccion !== "saliente") return false;
  const mostrado = comparable(anterior.texto!);
  return mostrado.includes(comparable(texto)) && mostrado.includes(comparable(para.replace(/\s*\(.*?\)/g, "")));
}

/**
 * Manda (o programa) un mensaje desde tu WhatsApp, solo si ya te lo mostró y contestaste. Si no, no manda y le dice al
 * asistente qué mostrarte.
 */
export async function enviarWa(chatJid: string, texto: string, enviarEn: Date | null, canal: CanalPersonal): Promise<string> {
  if (!texto.trim()) throw new ErrorUsuario("El mensaje está vacío.");
  if (enviarEn && enviarEn.getTime() < Date.now() - 60_000) throw new ErrorUsuario("Esa hora ya pasó.");
  const para = await nombreDeChatWa(chatJid);
  const programado = enviarEn && enviarEn.getTime() > Date.now() + 60_000 ? enviarEn : null;
  if (!(await loViste(para, texto)))
    return `No se mandó todavía. Mostrale esto tal cual y preguntale "¿Lo mando?":\n📤 *Para:* ${para}\n💬 *Texto:* "${texto}"${
      programado ? `\n🕐 *Cuándo:* ${formatearCuando(programado)}` : ""
    }\nSi contesta que sí, volvé a llamar a wa_enviar con el mismo chat y el mismo texto.`;
  if (programado) {
    await db.insert(waProgramado).values({ chatJid, datosCifrados: sellar({ texto, para }), enviarEn: programado });
    bus.avisar("whatsapp");
    return `Programado: le llega a ${para} ${formatearCuando(programado)}.`;
  }
  if (!canal.conectado()) throw new ErrorUsuario("Tu WhatsApp no está conectado ahora: revisalo en el panel.");
  await canal.enviar(chatJid, texto);
  await registrar("info", "whatsapp", `Tu WhatsApp: mensaje enviado a ${para} (pedido al asistente)`);
  return `Enviado a ${para}.`;
}

type DatosProgramado = { texto: string; para: string };

export async function programadosWa() {
  const filas = await db.select().from(waProgramado).where(eq(waProgramado.estado, "pendiente")).orderBy(asc(waProgramado.enviarEn));
  return filas.map((f) => ({ id: f.id, enviarEn: f.enviarEn, ...abrir<DatosProgramado>(f.datosCifrados, { texto: ILEGIBLE.texto, para: f.chatJid }) }));
}

export async function cancelarProgramadoWa(id: number) {
  const [fila] = await db.delete(waProgramado).where(and(eq(waProgramado.id, id), eq(waProgramado.estado, "pendiente"))).returning();
  if (!fila) throw new ErrorUsuario("Ese mensaje programado no existe o ya se mandó.");
  bus.avisar("whatsapp");
}

/** Barrido: manda los programados que vencieron. Si tu WhatsApp estuvo desconectado demasiado, no los manda y te avisa. */
export async function enviarProgramadosWa(canal: CanalPersonal) {
  const ya = Date.now();
  const filas = await db
    .select()
    .from(waProgramado)
    .where(and(eq(waProgramado.estado, "pendiente"), lte(waProgramado.enviarEn, new Date(ya))));
  for (const f of filas) {
    const d = abrir<DatosProgramado>(f.datosCifrados, { texto: "", para: f.chatJid });
    const tarde = ya - f.enviarEn.getTime() > HORAS_TOLERANCIA_PROGRAMADO * 3_600_000;
    if (!canal.conectado() && !tarde) continue; // Se manda cuando vuelva a conectar.
    let estado: "enviado" | "vencido" | "error" = "vencido";
    if (!tarde) {
      try {
        await canal.enviar(f.chatJid, d.texto);
        estado = "enviado";
      } catch (err) {
        estado = "error";
        await registrar("error", "whatsapp", "Tu WhatsApp: no se pudo mandar un mensaje programado", err);
      }
    }
    await db.update(waProgramado).set({ estado }).where(eq(waProgramado.id, f.id));
    bus.avisar("whatsapp");
    if (estado === "enviado") continue;
    const motivo = estado === "vencido" ? "tu WhatsApp estaba desconectado" : "WhatsApp dio un error";
    const texto = `⚠️ No pude mandarle a *${d.para}* el mensaje programado para ${formatearCuando(f.enviarEn)} (${motivo}):\n_${d.texto}_`;
    const waId = await enviador().enviarTexto(texto).catch(() => null);
    await registrarMensaje({ direccion: "saliente", texto, waMessageId: waId, chat: null, intencionDetectada: "aviso_wa_programado" });
  }
}
