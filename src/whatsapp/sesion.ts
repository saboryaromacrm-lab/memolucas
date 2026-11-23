import fs from "node:fs/promises";
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, useMultiFileAuthState, type ConnectionState, type UserFacingSocketConfig, type WASocket } from "baileys";
import QRCode from "qrcode";
import { bus } from "../lib/eventos.js";
import { logger, registrar } from "../lib/log.js";

export type EstadoWhatsApp = "iniciando" | "conectando" | "esperando_qr" | "conectado" | "desconectado" | "sesion_cerrada";

const ESPERAS_S = [5, 10, 30, 60, 300];
export const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const numeroDeJid = (jid: string | null | undefined) => (jid ? jidNormalizedUser(jid).split("@")[0] : null);

function estaRegistrado(sock: WASocket): boolean {
  return !!sock.authState.creds.registered || !!sock.authState.creds.me;
}

/**
 * Una cuenta de WhatsApp vinculada como dispositivo (el chip del bot o tu número): vincular con QR o código,
 * reconectar si se corta y desvincular. Lo propio de cada una va en las subclases.
 */
export abstract class SesionWhatsApp {
  protected sock: WASocket | null = null;
  protected estado: EstadoWhatsApp = "iniciando";
  protected numeroVinculado: string | null = null;
  private qr: string | null = null;
  private desconectadoDesde: Date | null = new Date();
  private ultimoError: string | null = null;
  private reintentos = 0;
  private temporizador: NodeJS.Timeout | null = null;
  protected deteniendo = false;
  private trasConectar: (() => void) | null = null;

  /**
   * carpeta: dónde se guarda la sesión. nombre: para los registros. reintentarSinVincular: si nadie escanea el QR,
   * volver a mostrar otro (el bot siempre; tu número solo mientras lo estás vinculando).
   */
  constructor(
    private carpeta: string,
    protected nombre: string,
    private reintentarSinVincular: boolean,
  ) {}

  /** Los oyentes y opciones propios de cada cuenta. */
  protected abstract escuchar(sock: WASocket): void;
  protected opciones(): Partial<UserFacingSocketConfig> {
    return {};
  }
  /** Al conectar y al perder la sesión (cerrada desde el teléfono o desvinculada). */
  protected async alConectar(): Promise<void> {}
  protected async alPerderSesion(): Promise<void> {}

  /** Lo que hace el resto de la app cada vez que conecta (ej. mandar lo atrasado). */
  onConectado(fn: () => void) {
    this.trasConectar = fn;
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

  protected cambiarEstado(estado: EstadoWhatsApp) {
    if (estado !== "conectado" && this.estado === "conectado") this.desconectadoDesde = new Date();
    this.estado = estado;
    bus.avisar("whatsapp", this.info());
  }

  /** ¿Hay una sesión guardada (ya se vinculó alguna vez)? */
  async tieneSesion(): Promise<boolean> {
    return fs.access(`${this.carpeta}/creds.json`).then(
      () => true,
      () => false,
    );
  }

  async iniciar(): Promise<void> {
    this.deteniendo = false;
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = null;
    await fs.mkdir(this.carpeta, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.carpeta);
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
      // Sin "en línea": el teléfono sigue recibiendo las notificaciones.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      ...this.opciones(),
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u) => void this.alActualizar(sock, u));
    this.escuchar(sock);
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
      await registrar("info", "whatsapp", `${this.nombre}: conectado como +${this.numeroVinculado}`);
      await this.alConectar();
      this.trasConectar?.();
    }
    if (connection === "close") {
      this.sock = null;
      const error = lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined;
      const codigo = error?.output?.statusCode;
      this.ultimoError = error?.message ?? null;
      if (this.deteniendo) return;
      if (codigo === DisconnectReason.loggedOut || codigo === DisconnectReason.forbidden) {
        // Sesión cerrada desde el teléfono o número bloqueado: hay que vincular de nuevo.
        await registrar("error", "whatsapp", `${this.nombre}: ${codigo === 403 ? "WhatsApp rechazó el número (posible bloqueo)" : "la sesión se cerró desde el teléfono"}`, { codigo });
        await this.borrarSesion();
        this.cambiarEstado("sesion_cerrada");
        if (this.reintentarSinVincular) this.programarReconexion(5);
        return;
      }
      this.cambiarEstado("desconectado");
      if (codigo === DisconnectReason.restartRequired) return this.programarReconexion(0);
      const sinVincular = !estaRegistrado(sock);
      if (sinVincular && !this.reintentarSinVincular) {
        // Nadie escaneó el QR: no queda nada a medias.
        await fs.rm(this.carpeta, { recursive: true, force: true });
        return this.cambiarEstado("sesion_cerrada");
      }
      const s = sinVincular ? 3 : ESPERAS_S[Math.min(this.reintentos, ESPERAS_S.length - 1)];
      this.reintentos++;
      if (!sinVincular) await registrar("aviso", "whatsapp", `${this.nombre}: se cortó la conexión (código ${codigo ?? "?"}). Reintento en ${s} s`);
      this.programarReconexion(s);
    }
  }

  private programarReconexion(segundos: number) {
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => {
      this.iniciar().catch((err) => {
        void registrar("error", "whatsapp", `${this.nombre}: no se pudo iniciar`, err);
        this.programarReconexion(30);
      });
    }, segundos * 1000);
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
    await fs.rm(this.carpeta, { recursive: true, force: true });
    this.numeroVinculado = null;
    await this.alPerderSesion();
  }

  /** Cierra la sesión en el teléfono y borra lo guardado. El bot queda esperando otro QR; tu número, apagado. */
  async desvincular() {
    this.deteniendo = true;
    if (this.temporizador) clearTimeout(this.temporizador);
    try {
      await this.sock?.logout();
    } catch {
      this.sock?.end(undefined);
    }
    this.sock = null;
    await this.borrarSesion();
    await registrar("aviso", "whatsapp", `${this.nombre}: se desvinculó desde el panel`);
    this.cambiarEstado("sesion_cerrada");
    if (!this.reintentarSinVincular) return;
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
