import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WAMessage } from "baileys";
import { DateTime } from "luxon";
import { Procesador } from "../src/bot/procesador.js";
import { hashOpcion } from "../src/servicios/encuestas.js";
import { avisarSuscripciones, listarSuscripciones, sumarPeriodo } from "../src/servicios/suscripciones.js";
import { baseLimpia, enviadorFalso, panelConSesion, reloj } from "./ayuda.js";

// Las respuestas al aviso no pasan por la IA.
vi.mock("../src/bot/ia.js", async (orig) => ({ ...(await orig<object>()), interpretar: () => Promise.reject(new Error("no debería usar la IA")) }));

const local = (iso: string) => DateTime.fromISO(iso, { zone: "America/Argentina/Buenos_Aires" }).toJSDate();
const YO = "5491112345678@s.whatsapp.net";
let n = 0;
const texto = (t: string): WAMessage => ({ key: { id: `IN${++n}`, remoteJid: YO }, message: { conversation: t } });
const citando = (id: string, t: string): WAMessage => ({ key: { id: `IN${++n}`, remoteJid: YO }, message: { extendedTextMessage: { text: t, contextInfo: { stanzaId: id } } } });
const voto = (encuesta: string, opcion: string): WAMessage => ({
  key: { id: `V${++n}`, remoteJid: YO },
  message: { pollUpdateMessage: { pollCreationMessageKey: { id: encuesta }, vote: { encPayload: Buffer.from(opcion), encIv: Buffer.alloc(12) } } },
});

const NETFLIX = { nombre: "Netflix", url: "https://netflix.com", fechaInicio: null, fechaVto: "2026-11-23", monto: 9.99, moneda: "USD", frecuencia: "mensual", observacion: "" };

describe("suscripciones", () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await baseLimpia();
    reloj(local("2026-11-20T08:00"));
    ({ app, headers } = await panelConSesion());
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it("renovar suma un período al vencimiento (no a hoy)", () => {
    expect(sumarPeriodo("2026-11-30", "7dias")).toBe("2026-12-07");
    expect(sumarPeriodo("2026-11-30", "quincenal")).toBe("2026-12-15");
    expect(sumarPeriodo("2026-01-31", "mensual")).toBe("2026-02-28");
    expect(sumarPeriodo("2026-11-30", "anual")).toBe("2027-11-30");
  });

  it("se crean, editan, renuevan y borran desde el panel, ordenadas por vencimiento", async () => {
    const crear = (d: object) => app.inject({ method: "POST", url: "/api/suscripciones", headers, payload: d });
    const netflix = (await crear(NETFLIX)).json();
    await crear({ ...NETFLIX, nombre: "Dominio", url: "", fechaVto: "2026-11-21", monto: 15000, moneda: "ARS", frecuencia: "anual" });
    expect((await crear({ ...NETFLIX, nombre: "" })).statusCode).toBe(400);
    expect((await crear({ ...NETFLIX, url: "netflix" })).statusCode).toBe(400);

    const lista = (await app.inject({ url: "/api/suscripciones", headers })).json();
    expect(lista.diasAviso).toBe(3);
    expect(lista.suscripciones.map((s: { nombre: string }) => s.nombre)).toEqual(["Dominio", "Netflix"]);
    expect(lista.suscripciones[1]).toMatchObject({ monto: 9.99, moneda: "USD" });

    expect((await app.inject({ method: "PUT", url: `/api/suscripciones/${netflix.id}`, headers, payload: { ...NETFLIX, monto: 12.5 } })).json().monto).toBe(12.5);
    expect((await app.inject({ method: "POST", url: `/api/suscripciones/${netflix.id}/renovar`, headers })).json().fechaVto).toBe("2026-12-23");
    await app.inject({ method: "DELETE", url: `/api/suscripciones/${netflix.id}`, headers });
    expect((await listarSuscripciones()).map((s) => s.nombre)).toEqual(["Dominio"]);
    expect((await app.inject({ url: "/api/suscripciones" })).statusCode).toBe(401);
  });

  it("avisa por WhatsApp unos días antes y el día que vence; se contesta renovada o recordame mañana", async () => {
    const wa = enviadorFalso();
    const respuestas: string[] = [];
    const bot = new Procesador({
      responder: async (t: string) => (respuestas.push(t), `OUT${respuestas.length}`),
      responderImagen: async () => null,
      responderEncuesta: async () => ({ id: null, secreto: "" }),
      descifrarVoto: (m: WAMessage) => [hashOpcion(Buffer.from(m.message!.pollUpdateMessage!.vote!.encPayload!).toString())],
      descargarMedia: async () => Buffer.alloc(0),
      reaccionar: async (_m: WAMessage, e: string) => void respuestas.push(`(reacción ${e})`),
    });
    await app.inject({ method: "POST", url: "/api/suscripciones", headers, payload: NETFLIX });
    // Cargada cuando ya pasó el momento de su aviso previo: ese aviso no sale.
    await app.inject({ method: "POST", url: "/api/suscripciones", headers, payload: { ...NETFLIX, nombre: "Hosting", url: "", fechaVto: "2026-11-21", monto: 0 } });

    await avisarSuscripciones();
    expect(wa.enviados).toHaveLength(0);

    // 3 días antes, a la hora por defecto.
    vi.setSystemTime(local("2026-11-20T09:00"));
    await avisarSuscripciones();
    await avisarSuscripciones();
    expect(wa.enviados.map((e) => e.texto)).toEqual(["🔔 *Netflix* vence en 3 días (lun 23/11) · US$ 9,99\nhttps://netflix.com"]);
    expect(wa.encuestas.map((e) => [e.nombre, e.opciones])).toEqual([["¿Renovaste Netflix?", ["🔄 Renovada", "⏰ Recordame mañana"]]]);

    // El día que vence el hosting (sin monto ni dirección).
    vi.setSystemTime(local("2026-11-21T09:00"));
    await avisarSuscripciones();
    expect(wa.enviados.at(-1)!.texto).toBe("🔔 *Hosting* vence hoy");

    // El día de Netflix: "Recordame mañana" y al otro día vuelve a avisar.
    vi.setSystemTime(local("2026-11-23T09:00"));
    await avisarSuscripciones();
    expect(wa.enviados.at(-1)!.texto).toContain("*Netflix* vence hoy");
    await bot.procesar(voto(wa.encuestas.at(-1)!.id, "⏰ Recordame mañana"));
    expect(respuestas.at(-1)).toBe("⏰ Dale, te recuerdo *Netflix* mañana a las 9:00.");
    vi.setSystemTime(local("2026-11-24T09:00"));
    await avisarSuscripciones();
    expect(wa.enviados.at(-1)!.texto).toContain("*Netflix* venció hace 1 día");

    // "renovada" sin citar, justo después del aviso: suma un mes al vencimiento.
    await bot.procesar(texto("renovada"));
    expect(respuestas.at(-1)).toBe("(reacción 🔄)");
    expect((await listarSuscripciones()).find((x) => x.nombre === "Netflix")!.fechaVto).toBe("2026-12-23");
    // Citando un aviso viejo no la renueva dos veces.
    await bot.procesar(citando(wa.enviados.at(-1)!.id, "ya la renové"));
    expect(respuestas.at(-1)).toBe("*Netflix* ya estaba renovada: vence el miércoles 23/12/2026.");
    expect((await listarSuscripciones()).find((s) => s.nombre === "Netflix")!.fechaVto).toBe("2026-12-23");
  });

  it("no avisa con WhatsApp desconectado ni en el horario de silencio (sale después)", async () => {
    const wa = enviadorFalso();
    await app.inject({ method: "PUT", url: "/api/configuracion", headers, payload: { silencioActivo: true, silencioDesde: "08:30", silencioHasta: "10:00", silencioDias: [1, 2, 3, 4, 5, 6, 7] } });
    await app.inject({ method: "POST", url: "/api/suscripciones", headers, payload: NETFLIX });
    vi.setSystemTime(local("2026-11-20T09:00"));
    await avisarSuscripciones();
    expect(wa.enviados).toHaveLength(0);
    vi.setSystemTime(local("2026-11-20T10:01"));
    wa.online = false;
    await avisarSuscripciones();
    expect(wa.enviados).toHaveLength(0);
    wa.online = true;
    await avisarSuscripciones();
    expect(wa.enviados).toHaveLength(1);
  });
});
