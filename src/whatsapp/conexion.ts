import crypto from "node:crypto";
import fs from "node:fs/promises";
import { decryptPollVote, downloadMediaMessage, isJidBroadcast, isJidGroup, isJidNewsletter, isLidUser, isPnUser, jidNormalizedUser, type WAMessage, type WASocket, type proto } from "baileys";
import { rutas } from "../entorno.js";
import { logger, registrar } from "../lib/log.js";
import { actualizarConfig, obtenerConfig } from "../servicios/configuracion.js";
import type { Enviador } from "../servicios/enviador.js";
import { esMiembro, guardarGrupo } from "./grupos.js";
import { jidDeNumero, mismoNumero } from "./numeros.js";
import { espera, numeroDeJid, SesionWhatsApp } from "./sesion.js";

export type { EstadoWhatsApp } from "./sesion.js";

export type Remitente = {
  autorizado: boolean;
  numero: string | null;
  chatJid: string;
  /** Si vino de un grupo: el grupo (las respuestas van ahí). */
  grupo: { jid: string; nombre: string } | null;
  /** Nombre de quien escribió (en grupos). */
  autor: string | null;
};
const MINUTOS_CACHE_GRUPO = 10;
type Manejador = (msg: WAMessage, remitente: Remitente) => Promise<void>;

/** El número del bot: responde solo a tu número (y en tus grupos). */
class ConexionWhatsApp extends SesionWhatsApp implements Enviador {
  private chatJid: string | null = null;
  private enviados = new Map<string, proto.IMessage>();
  private manejador: Manejador | null = null;
  private grupos = new Map<string, { miembro: boolean; nombre: string; hasta: number }>();
  private gruposAvisados = new Set<string>();

  constructor() {
    super(rutas.auth, "WhatsApp del bot", true);
  }

  onMensaje(fn: Manejador) {
    this.manejador = fn;
  }

  protected opciones() {
    return {
      // Estados y canales no interesan: se descartan antes de procesarlos. Los grupos se filtran después.
      shouldIgnoreJid: (jid: string) => !!(isJidBroadcast(jid) || isJidNewsletter(jid)),
      getMessage: async (key: proto.IMessageKey) => (key.id ? this.enviados.get(key.id) : undefined),
    };
  }

  protected escuchar(sock: WASocket) {
    // Si cambian los integrantes o el nombre de un grupo, se vuelve a consultar.
    sock.ev.on("group-participants.update", ({ id }) => this.grupos.delete(id));
    sock.ev.on("groups.update", (gs) => gs.forEach((g) => g.id && this.grupos.delete(g.id)));
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) void this.alRecibir(sock, msg);
    });
  }

  protected async alConectar() {
    await this.resolverAutorizado();
  }

  protected async alPerderSesion() {
    this.chatJid = null;
  }

  /** Busca el JID real del número autorizado y su LID (para reconocerlo en chats nuevos). */
  async resolverAutorizado() {
    const sock = this.sock;
    const cfg = await obtenerConfig();
    if (!sock || !cfg.numeroAutorizado) return;
    try {
      const [r] = (await sock.onWhatsApp(cfg.numeroAutorizado)) ?? [];
      if (r?.exists) this.chatJid = jidNormalizedUser(r.jid);
      const lid = await sock.signalRepository.lidMapping.getLIDForPN(this.chatJid ?? jidDeNumero(cfg.numeroAutorizado));
      if (lid && lid !== cfg.lidAutorizado) await actualizarConfig({ lidAutorizado: jidNormalizedUser(lid) });
    } catch (err) {
      logger.warn({ err }, "No se pudo resolver el número autorizado");
    }
  }

  olvidarChat() {
    this.chatJid = null;
  }

  private async remitente(sock: WASocket, msg: WAMessage): Promise<Remitente> {
    const key = msg.key;
    const chatJid = jidNormalizedUser(key.remoteJid ?? "");
    const cfg = await obtenerConfig();
    let numero: string | null = null;
    if (isPnUser(chatJid)) numero = numeroDeJid(chatJid);
    else if (key.remoteJidAlt && isPnUser(key.remoteJidAlt)) numero = numeroDeJid(key.remoteJidAlt);
    else if (isLidUser(chatJid)) {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(chatJid).catch(() => null);
      numero = numeroDeJid(pn);
    }
    const porLid = !!cfg.lidAutorizado && isLidUser(chatJid) && chatJid === cfg.lidAutorizado;
    const autorizado = !!cfg.numeroAutorizado && (porLid || (!!numero && mismoNumero(numero, cfg.numeroAutorizado)));
    if (autorizado && isLidUser(chatJid) && chatJid !== cfg.lidAutorizado) await actualizarConfig({ lidAutorizado: chatJid });
    return { autorizado, numero, chatJid, grupo: null, autor: null };
  }

  /** Datos del grupo (con caché): nombre y si el dueño está adentro. */
  private async infoGrupo(sock: WASocket, jid: string) {
    const enCache = this.grupos.get(jid);
    if (enCache && enCache.hasta > Date.now()) return enCache;
    const cfg = await obtenerConfig();
    const meta = await sock.groupMetadata(jid);
    const info = {
      miembro: esMiembro(meta.participants, cfg.numeroAutorizado, cfg.lidAutorizado),
      nombre: meta.subject || "Grupo",
      hasta: Date.now() + MINUTOS_CACHE_GRUPO * 60_000,
    };
    this.grupos.set(jid, info);
    if (info.miembro) await guardarGrupo(jid, info.nombre);
    return info;
  }

  private async alRecibirGrupo(sock: WASocket, msg: WAMessage, jid: string) {
    const info = await this.infoGrupo(sock, jid);
    if (!info.miembro) {
      if (!this.gruposAvisados.has(jid)) {
        this.gruposAvisados.add(jid);
        await registrar("aviso", "whatsapp", `Grupo "${info.nombre}" ignorado: el número autorizado no está en el grupo`);
      }
      return;
    }
    const participante = msg.key.participantAlt ?? msg.key.participant ?? "";
    const numero = isPnUser(participante) ? numeroDeJid(participante) : null;
    const autor = msg.pushName?.trim() || (numero ? `+${numero}` : null);
    await sock.readMessages([msg.key]).catch(() => {});
    await this.manejador?.(msg, { autorizado: true, numero, chatJid: jid, grupo: { jid, nombre: info.nombre }, autor });
  }

  private async alRecibir(sock: WASocket, msg: WAMessage) {
    try {
      if (!msg.message || msg.key.fromMe) return;
      const jid = msg.key.remoteJid ?? "";
      if (isJidGroup(jid)) return await this.alRecibirGrupo(sock, msg, jid);
      if (!isPnUser(jid) && !isLidUser(jid)) return; // Estados y canales: se ignoran.
      const r = await this.remitente(sock, msg);
      if (!r.autorizado) {
        await registrar("info", "whatsapp", `Mensaje ignorado de ${r.numero ? `+${r.numero}` : r.chatJid} (no autorizado)`);
        return;
      }
      this.chatJid = r.chatJid;
      await sock.readMessages([msg.key]).catch(() => {});
      await this.manejador?.(msg, r);
    } catch (err) {
      await registrar("error", "whatsapp", "Error procesando un mensaje entrante", err);
    }
  }

  private async destino(): Promise<string> {
    if (this.chatJid) return this.chatJid;
    const cfg = await obtenerConfig();
    if (!cfg.numeroAutorizado) throw new Error("No hay número autorizado configurado");
    return jidDeNumero(cfg.numeroAutorizado);
  }

  private recordar(id: string | null | undefined, m: proto.IMessage | null | undefined) {
    if (!id || !m) return;
    this.enviados.set(id, m);
    if (this.enviados.size > 500) this.enviados.delete(this.enviados.keys().next().value!);
  }

  async enviarTexto(texto: string, destino?: string | null, citar?: WAMessage): Promise<string | null> {
    const sock = this.sock;
    if (!sock || !this.conectado()) throw new Error("WhatsApp no está conectado");
    const r = await sock.sendMessage(destino ?? (await this.destino()), { text: texto }, citar ? { quoted: citar } : undefined);
    this.recordar(r?.key.id, r?.message);
    return r?.key.id ?? null;
  }

  async enviarImagen(ruta: string, mime: string, epigrafe: string, destino?: string | null): Promise<string | null> {
    const sock = this.sock;
    if (!sock || !this.conectado()) throw new Error("WhatsApp no está conectado");
    const imagen = await fs.readFile(ruta);
    const r = await sock.sendMessage(destino ?? (await this.destino()), { image: imagen, mimetype: mime, caption: epigrafe });
    this.recordar(r?.key.id, r?.message);
    return r?.key.id ?? null;
  }

  async enviarEncuesta(nombre: string, opciones: string[], destino?: string | null): Promise<{ id: string | null; secreto: string }> {
    const sock = this.sock;
    if (!sock || !this.conectado()) throw new Error("WhatsApp no está conectado");
    // La clave se guarda para poder leer los votos (llegan cifrados).
    const secreto = crypto.randomBytes(32);
    const r = await sock.sendMessage(destino ?? (await this.destino()), { poll: { name: nombre, values: opciones, selectableCount: 1, messageSecret: secreto } });
    this.recordar(r?.key.id, r?.message);
    return { id: r?.key.id ?? null, secreto: secreto.toString("base64") };
  }

  async responderEncuesta(nombre: string, opciones: string[], destino?: string | null): Promise<{ id: string | null; secreto: string }> {
    const sock = this.sock;
    if (!sock || !this.conectado()) return { id: null, secreto: "" };
    const jid = destino ?? (await this.destino());
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await espera(600);
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    return this.enviarEncuesta(nombre, opciones, jid);
  }

  /** Lee un voto. Según el chat, WhatsApp firma con el número o con el LID: se prueban las combinaciones. */
  descifrarVoto(msg: WAMessage, secreto: string): Uint8Array[] | null {
    const pu = msg.message?.pollUpdateMessage;
    const pollId = pu?.pollCreationMessageKey?.id;
    if (!pu?.vote || !pollId || !secreto) return null;
    const usuarios = (jids: (string | null | undefined)[]) =>
      [...new Set(jids.filter((j): j is string => !!j && !!(isPnUser(j) || isLidUser(j))).map((j) => jidNormalizedUser(j)))];
    const creadores = usuarios([this.sock?.user?.id, this.sock?.user?.lid]);
    const k = msg.key;
    const votantes = usuarios([k.participant, k.participantAlt, k.remoteJid, k.remoteJidAlt]);
    const clave = Buffer.from(secreto, "base64");
    for (const pollCreatorJid of creadores)
      for (const voterJid of votantes) {
        try {
          return decryptPollVote(pu.vote, { pollCreatorJid, pollMsgId: pollId, pollEncKey: clave, voterJid }).selectedOptions ?? [];
        } catch {
          // Probar la siguiente combinación.
        }
      }
    return null;
  }

  /** Respuesta del bot: "escribiendo…" y una demora corta antes de enviar (más natural). */
  async responder(texto: string, destino?: string | null, citar?: WAMessage): Promise<string | null> {
    const sock = this.sock;
    if (!sock || !this.conectado()) return null;
    const cfg = await obtenerConfig();
    const jid = destino ?? (await this.destino());
    const min = Math.max(0, cfg.demoraMinMs);
    const max = Math.max(min, cfg.demoraMaxMs);
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await espera(min + Math.random() * (max - min));
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    return this.enviarTexto(texto, jid, citar);
  }

  /** Como responder, pero con una imagen (ej. la foto de una nota). */
  async responderImagen(ruta: string, mime: string, epigrafe: string, destino?: string | null): Promise<string | null> {
    const sock = this.sock;
    if (!sock || !this.conectado()) return null;
    const jid = destino ?? (await this.destino());
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await espera(800);
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    return this.enviarImagen(ruta, mime, epigrafe, jid);
  }

  async reaccionar(msg: WAMessage, emoji: string): Promise<void> {
    const sock = this.sock;
    if (!sock || !this.conectado() || !msg.key.remoteJid) return;
    await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
  }

  async descargarMedia(msg: WAMessage): Promise<Buffer> {
    const sock = this.sock;
    if (!sock) throw new Error("WhatsApp no está conectado");
    return downloadMediaMessage(msg, "buffer", {}, { logger: logger as never, reuploadRequest: sock.updateMediaMessage });
  }
}

export const whatsapp = new ConexionWhatsApp();
