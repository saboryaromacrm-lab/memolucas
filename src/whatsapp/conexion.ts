import fs from "node:fs/promises";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  useMultiFileAuthState,
  type ConnectionState,
  type WAMessage,
  type WASocket,
  type proto,
} from "baileys";
import QRCode from "qrcode";
import { rutas } from "../entorno.js";
import { bus } from "../lib/eventos.js";
import { logger, registrar } from "../lib/log.js";
import { actualizarConfig, obtenerConfig } from "../servicios/configuracion.js";
import type { Enviador } from "../servicios/enviador.js";
import { jidDeNumero, mismoNumero } from "./numeros.js";

export type EstadoWhatsApp = "iniciando" | "conectando" | "esperando_qr" | "conectado" | "desconectado" | "sesion_cerrada";

type Remitente = { autorizado: boolean; numero: string | null; chatJid: string };
type Manejador = (msg: WAMessage, remitente: Remitente) => Promise<void>;

const ESPERAS_S = [5, 10, 30, 60, 300];
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const numeroDeJid = (jid: string | null | undefined) => (jid ? jidNormalizedUser(jid).split("@")[0] : null);

class ConexionWhatsApp implements Enviador {
  private sock: WASocket | null = null;
  private estado: EstadoWhatsApp = "iniciando";
  private qr: string | null = null;
  private numeroVinculado: string | null = null;
  private desconectadoDesde: Date | null = new Date();
  private ultimoError: string | null = null;
  private reintentos = 0;
  private temporizador: NodeJS.Timeout | null = null;
  private deteniendo = false;
  private chatJid: string | null = null;
  private enviados = new Map<string, proto.IMessage>();
  private manejador: Manejador | null = null;
  private alConectar: (() => void) | null = null;

  onMensaje(fn: Manejador) {
    this.manejador = fn;
  }
  onConectado(fn: () => void) {
    this.alConectar = fn;
  }

  conectado() {
    return this.estado === "conectado" && !!this.sock;
  }

  info() {
    return {
      estado: this.estado,
      qr: this.estado === "esperando_qr" ? this.qr : null,
      numeroVinculado: this.numeroVinculado,
      desconectadoDesde: this.estado === "conectado" ? null : this.desconectadoDesde,
      ultimoError: this.ultimoError,
    };
  }

  private cambiarEstado(estado: EstadoWhatsApp) {
    if (estado !== "conectado" && this.estado === "conectado") this.desconectadoDesde = new Date();
    this.estado = estado;
    bus.avisar("whatsapp", this.info());
  }

  async iniciar(): Promise<void> {
    this.deteniendo = false;
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = null;
    await fs.mkdir(rutas.auth, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(rutas.auth);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined; // Usa la que trae Baileys.
    }
    this.cambiarEstado("conectando");
    const sock = makeWASocket({
      auth: state,
      version,
      logger: logger.child({ modulo: "baileys" }, { level: "warn" }) as never,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Grupos, estados y canales no interesan: se descartan antes de procesarlos.
      shouldIgnoreJid: (jid) => !!(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
      getMessage: async (key) => (key.id ? this.enviados.get(key.id) : undefined),
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u) => void this.alActualizar(sock, u));
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) void this.alRecibir(sock, msg);
    });
  }

  private async alActualizar(sock: WASocket, u: Partial<ConnectionState>) {
    if (sock !== this.sock) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      this.cambiarEstado("esperando_qr");
    }
    if (connection === "open") {
      this.reintentos = 0;
      this.qr = null;
      this.ultimoError = null;
      this.numeroVinculado = numeroDeJid(sock.user?.id);
      this.cambiarEstado("conectado");
      await registrar("info", "whatsapp", `Conectado como +${this.numeroVinculado}`);
      await this.resolverAutorizado();
      this.alConectar?.();
    }
    if (connection === "close") {
      this.sock = null;
      const error = lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined;
      const codigo = error?.output?.statusCode;
      this.ultimoError = error?.message ?? null;
      if (this.deteniendo) return;
      if (codigo === DisconnectReason.loggedOut || codigo === DisconnectReason.forbidden) {
        // Sesión cerrada desde el teléfono o número bloqueado: hay que vincular de nuevo.
        await registrar("error", "whatsapp", codigo === 403 ? "WhatsApp rechazó el número (posible bloqueo)" : "La sesión se cerró desde el teléfono", {
          codigo,
        });
        await this.borrarSesion();
        this.cambiarEstado("sesion_cerrada");
        this.programarReconexion(5);
        return;
      }
      this.cambiarEstado("desconectado");
      if (codigo === DisconnectReason.restartRequired) return this.programarReconexion(0);
      const sinVincular = !estaRegistrado(sock);
      const s = sinVincular ? 3 : ESPERAS_S[Math.min(this.reintentos, ESPERAS_S.length - 1)];
      this.reintentos++;
      if (!sinVincular) await registrar("aviso", "whatsapp", `Se cortó la conexión (código ${codigo ?? "?"}). Reintento en ${s} s`);
      this.programarReconexion(s);
    }
  }

  private programarReconexion(segundos: number) {
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => {
      this.iniciar().catch((err) => {
        void registrar("error", "whatsapp", "No se pudo iniciar WhatsApp", err);
        this.programarReconexion(30);
      });
    }, segundos * 1000);
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
    return { autorizado, numero, chatJid };
  }

  private async alRecibir(sock: WASocket, msg: WAMessage) {
    try {
      if (!msg.message || msg.key.fromMe) return;
      const jid = msg.key.remoteJid ?? "";
      if (!isPnUser(jid) && !isLidUser(jid)) return; // Grupos, estados, canales: se ignoran.
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

  async enviarTexto(texto: string): Promise<string | null> {
    const sock = this.sock;
    if (!sock || !this.conectado()) throw new Error("WhatsApp no está conectado");
    const r = await sock.sendMessage(await this.destino(), { text: texto });
    this.recordar(r?.key.id, r?.message);
    return r?.key.id ?? null;
  }

  async enviarImagen(ruta: string, mime: string, epigrafe: string): Promise<string | null> {
    const sock = this.sock;
    if (!sock || !this.conectado()) throw new Error("WhatsApp no está conectado");
    const imagen = await fs.readFile(ruta);
    const r = await sock.sendMessage(await this.destino(), { image: imagen, mimetype: mime, caption: epigrafe });
    this.recordar(r?.key.id, r?.message);
    return r?.key.id ?? null;
  }

  /** Respuesta del bot: "escribiendo…" y una demora corta antes de enviar (más natural). */
  async responder(texto: string): Promise<string | null> {
    const sock = this.sock;
    if (!sock || !this.conectado()) return null;
    const cfg = await obtenerConfig();
    const jid = await this.destino();
    const min = Math.max(0, cfg.demoraMinMs);
    const max = Math.max(min, cfg.demoraMaxMs);
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await espera(min + Math.random() * (max - min));
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    return this.enviarTexto(texto);
  }

  async descargarMedia(msg: WAMessage): Promise<Buffer> {
    const sock = this.sock;
    if (!sock) throw new Error("WhatsApp no está conectado");
    return downloadMediaMessage(msg, "buffer", {}, { logger: logger as never, reuploadRequest: sock.updateMediaMessage });
  }

  async pedirCodigo(numero: string): Promise<string> {
    if (this.estado === "conectado") throw new Error("WhatsApp ya está vinculado");
    if (!this.sock || this.estado !== "esperando_qr") {
      await this.reconectar();
      for (let i = 0; i < 30 && this.estado !== "esperando_qr"; i++) await espera(500);
    }
    if (!this.sock) throw new Error("No se pudo iniciar la conexión, probá de nuevo");
    const codigo = await this.sock.requestPairingCode(numero);
    return codigo.match(/.{1,4}/g)?.join("-") ?? codigo;
  }

  async reconectar() {
    this.deteniendo = true;
    this.sock?.end(undefined);
    this.sock = null;
    this.reintentos = 0;
    await espera(300);
    await this.iniciar();
  }

  private async borrarSesion() {
    await fs.rm(rutas.auth, { recursive: true, force: true });
    this.numeroVinculado = null;
    this.chatJid = null;
  }

  async desvincular() {
    this.deteniendo = true;
    try {
      await this.sock?.logout();
    } catch {
      this.sock?.end(undefined);
    }
    this.sock = null;
    await this.borrarSesion();
    await registrar("aviso", "whatsapp", "Se desvinculó WhatsApp desde el panel");
    this.cambiarEstado("sesion_cerrada");
    await espera(500);
    await this.iniciar();
  }

  async detener() {
    this.deteniendo = true;
    if (this.temporizador) clearTimeout(this.temporizador);
    this.sock?.end(undefined);
    this.sock = null;
  }
}

function estaRegistrado(sock: WASocket): boolean {
  return !!sock.authState.creds.registered || !!sock.authState.creds.me;
}

export const whatsapp = new ConexionWhatsApp();
