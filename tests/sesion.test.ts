import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { rutas } from "../src/entorno.js";
import { leerChatWa, listarChatsWa } from "../src/servicios/wa-personal.js";
import { personal } from "../src/whatsapp/personal.js";
import { baseLimpia } from "./ayuda.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Baileys simulado: un socket con eventos, para probar el ciclo de vida de tu WhatsApp (la base común con el bot).
const sockets: any[] = [];
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
vi.mock("baileys", async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    default: (opts: any) => {
      const ev = new EventEmitter();
      const s: any = { opts, ev, authState: { creds: {} }, user: null, end: vi.fn(), logout: vi.fn(), groupFetchAllParticipating: async () => ({ "1@g.us": { id: "1@g.us", subject: "Fútbol" } }), sendPresenceUpdate: vi.fn(async () => {}), sendMessage: vi.fn(async () => ({ key: { id: "X" }, message: {} })), signalRepository: { lidMapping: { getPNForLID: async () => null } } };
      sockets.push(s);
      return s;
    },
  };
});

describe("tu WhatsApp: conexión", () => {
  it("vincula, guarda, no insiste sin QR y desvincula borrando", async () => {
    await baseLimpia();
    await fs.rm(rutas.authPersonal, { recursive: true, force: true });
    await personal.iniciarSiHaySesion();
    expect(personal.info().estado).toBe("sesion_cerrada");
    expect(sockets).toHaveLength(0);

    await personal.reconectar();
    const s = sockets[0];
    expect(s.opts.markOnlineOnConnect).toBe(false);
    s.ev.emit("connection.update", { qr: "abc" });
    await espera(50);
    expect(personal.info().estado).toBe("esperando_qr");
    // Nadie escanea: se cierra y no vuelve a intentar.
    s.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: Object.assign(new Error("QR refs attempts ended"), { output: { statusCode: 408 } }) } });
    await espera(200);
    expect(personal.info().estado).toBe("sesion_cerrada");
    expect(sockets).toHaveLength(1);
    expect(await personal.tieneSesion()).toBe(false);

    await personal.reconectar();
    const s2 = sockets[1];
    s2.authState.creds.me = { id: "5491199990000:1@s.whatsapp.net" };
    s2.user = { id: "5491199990000:1@s.whatsapp.net" };
    s2.ev.emit("connection.update", { connection: "open" });
    await espera(100);
    expect(personal.info()).toMatchObject({ estado: "conectado", numeroVinculado: "5491199990000" });
    expect((await listarChatsWa()).map((c) => c.nombre)).toEqual(["Fútbol"]);
    s2.ev.emit("messages.upsert", { type: "notify", messages: [{ key: { id: "A", remoteJid: "5491155550001@s.whatsapp.net" }, message: { conversation: "hola!" }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: "Juan" }] });
    s2.ev.emit("messages.upsert", { type: "notify", messages: [{ key: { id: "B", remoteJid: "status@broadcast" }, message: { conversation: "estado" }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
    await espera(100);
    expect((await leerChatWa("5491155550001@s.whatsapp.net")).map((m) => [m.de, m.texto])).toEqual([["Juan", "hola!"]]);
    expect(s2.readMessages).toBeUndefined();

    await personal.enviar("5491155550001@s.whatsapp.net", "chau");
    expect(s2.sendPresenceUpdate).toHaveBeenCalledWith("composing", "5491155550001@s.whatsapp.net");
    expect(s2.sendMessage).toHaveBeenCalledWith("5491155550001@s.whatsapp.net", { text: "chau" });

    await personal.desvincular();
    expect(s2.logout).toHaveBeenCalled();
    expect(personal.info().estado).toBe("sesion_cerrada");
    expect(await listarChatsWa()).toEqual([]);
    expect(sockets).toHaveLength(2);
  }, 30000);
});
