import { isJidBroadcast, isJidGroup, isJidNewsletter, isLidUser, isPnUser, jidNormalizedUser, proto, type Contact, type WAMessage, type WASocket } from "baileys";
import { rutas } from "../entorno.js";
import { registrar } from "../lib/log.js";
import { ErrorUsuario } from "../servicios/recordatorios.js";
import { borrarTodoWa, guardarChatsWa, guardarMensajesWa, masViejoWa, type CanalPersonal, type DatosChat } from "../servicios/wa-personal.js";
import { whatsapp } from "./conexion.js";
import { mismoNumero } from "./numeros.js";
import { espera, numeroDeJid, SesionWhatsApp } from "./sesion.js";

const MENSAJES_MAS_ATRAS = 50;
const SEGUNDOS_ESPERA_HISTORIAL = 15;

/**
 * Tu WhatsApp, vinculado como un dispositivo más: guarda lo que llega para que el asistente lo lea y manda lo que
 * le confirmás. Nunca marca nada como leído ni aparece "en línea"; si nadie escanea el QR, no insiste.
 */
class WhatsAppPersonal extends SesionWhatsApp implements CanalPersonal {
  private enviados = new Map<string, proto.IMessage>();
  private alLlegarHistorial: ((nuevos: number) => void) | null = null;

  constructor() {
    super(rutas.authPersonal, "Tu WhatsApp", false);
  }

  /** Al arrancar la app: se conecta solo si ya estaba vinculado. */
  async iniciarSiHaySesion() {
    if (await this.tieneSesion()) return this.iniciar();
    this.cambiarEstado("sesion_cerrada");
  }

  protected opciones() {
    return {
      shouldIgnoreJid: (jid: string) => !!(isJidBroadcast(jid) || isJidNewsletter(jid)),
      getMessage: async (key: proto.IMessageKey) => (key.id ? this.enviados.get(key.id) : undefined),
    };
  }

  protected escuchar(sock: WASocket) {
    const seguro = (fn: () => Promise<unknown>) => void fn().catch((err) => registrar("error", "whatsapp", "Tu WhatsApp: no se pudo guardar lo que llegó", err));
    sock.ev.on("messages.upsert", ({ messages }) => seguro(() => this.guardar(sock, messages)));
    sock.ev.on("messaging-history.set", ({ messages, contacts, chats, syncType }) =>
      seguro(async () => {
        await guardarChatsWa([...contacts.map(datosDeContacto), ...chats.flatMap((c) => (c.id && isJidGroup(c.id) && c.name ? [{ jid: c.id, nombre: c.name }] : []))].filter((c) => this.guardable(c.jid)));
        const nuevos = await this.guardar(sock, messages, syncType === proto.HistorySync.HistorySyncType.ON_DEMAND);
        if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) this.alLlegarHistorial?.(nuevos);
      }),
    );
    const contactos = (cs: Partial<Contact>[]) => seguro(() => guardarChatsWa(cs.filter((c) => c.id).map((c) => datosDeContacto(c as Contact)).filter((c) => this.guardable(c.jid))));
    sock.ev.on("contacts.upsert", contactos);
    sock.ev.on("contacts.update", contactos);
    sock.ev.on("groups.upsert", (gs) => seguro(() => guardarChatsWa(gs.map((g) => ({ jid: g.id, nombre: g.subject })))));
    sock.ev.on("groups.update", (gs) => seguro(() => guardarChatsWa(gs.flatMap((g) => (g.id && g.subject ? [{ jid: g.id, nombre: g.subject }] : [])))));
  }

  protected async alConectar() {
    const sock = this.sock;
    const bot = whatsapp.info().numeroVinculado;
    if (bot && this.numeroVinculado && mismoNumero(bot, this.numeroVinculado)) {
      await registrar("error", "whatsapp", "Tu WhatsApp: vinculaste el mismo número del bot. Se desvinculó: escaneá el QR con tu número personal.");
      return this.desvincular();
    }
    // Los nombres de todos tus grupos, de una vez.
    const grupos = await sock?.groupFetchAllParticipating().catch(() => null);
    if (grupos) await guardarChatsWa(Object.values(grupos).map((g) => ({ jid: g.id, nombre: g.subject })));
  }

  protected async alPerderSesion() {
    await borrarTodoWa();
  }

  /** Ni estados, ni canales, ni el chat con el bot (esa conversación ya la tiene el asistente). */
  private guardable(jid: string) {
    const bot = whatsapp.info().numeroVinculado;
    const numero = isPnUser(jid) ? numeroDeJid(jid) : null;
    return !!jid && !isJidBroadcast(jid) && !isJidNewsletter(jid) && !(bot && numero && mismoNumero(bot, numero));
  }

  /** El chat con el número de teléfono cuando se conoce (WhatsApp a veces lo nombra con un LID). */
  private async chatDe(sock: WASocket, msg: WAMessage): Promise<string> {
    const jid = jidNormalizedUser(msg.key.remoteJid ?? "");
    if (!isLidUser(jid)) return jid;
    const alt = msg.key.remoteJidAlt;
    if (alt && isPnUser(alt)) return jidNormalizedUser(alt);
    const pn = await sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
    return pn ? jidNormalizedUser(pn) : jid;
  }

  private async guardar(sock: WASocket, mensajes: WAMessage[], masAtras = false) {
    const items: { msg: WAMessage; chatJid: string }[] = [];
    for (const msg of mensajes) {
      const chatJid = await this.chatDe(sock, msg);
      if (this.guardable(chatJid)) items.push({ msg, chatJid });
    }
    return guardarMensajesWa(items, masAtras);
  }

  /** Manda un mensaje como si lo escribieras vos: "escribiendo…" un rato según el largo, y después el mensaje. */
  async enviar(jid: string, texto: string) {
    const sock = this.sock;
    if (!sock || !this.conectado()) throw new ErrorUsuario("Tu WhatsApp no está conectado.");
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await espera(Math.min(1500 + texto.length * 40, 6000));
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    const r = await sock.sendMessage(jid, { text: texto });
    if (r?.key.id && r.message) {
      this.enviados.set(r.key.id, r.message);
      if (this.enviados.size > 200) this.enviados.delete(this.enviados.keys().next().value!);
    }
  }

  /** Le pide al teléfono mensajes más viejos de un chat (llegan aparte) y espera un rato. Devuelve cuántos llegaron. */
  async traerMasAtras(chatJid: string): Promise<number> {
    const sock = this.sock;
    if (!sock || !this.conectado()) throw new ErrorUsuario("Tu WhatsApp no está conectado.");
    const viejo = await masViejoWa(chatJid);
    if (!viejo) throw new ErrorUsuario("De ese chat no tengo ningún mensaje para pedir desde ahí más atrás.");
    const llegaron = new Promise<number>((resolver) => {
      this.alLlegarHistorial = resolver;
      setTimeout(() => resolver(0), SEGUNDOS_ESPERA_HISTORIAL * 1000);
    });
    try {
      await sock.fetchMessageHistory(MENSAJES_MAS_ATRAS, { remoteJid: viejo.remoteJid, id: viejo.waId, fromMe: viejo.deMi }, Math.floor(viejo.enviadoEn.getTime() / 1000));
      return await llegaron;
    } finally {
      this.alLlegarHistorial = null;
    }
  }
}

/** Un contacto con su número (no el LID) cuando se conoce: nombre de tu agenda y el que se puso la persona. */
function datosDeContacto(c: Contact): DatosChat {
  const jid = isPnUser(c.id) ? c.id : c.phoneNumber && isPnUser(c.phoneNumber) ? c.phoneNumber : c.id;
  return { jid: jidNormalizedUser(jid), nombre: isJidGroup(c.id) ? c.name || c.notify : c.name, apodo: c.notify || c.verifiedName };
}

export const personal = new WhatsAppPersonal();
