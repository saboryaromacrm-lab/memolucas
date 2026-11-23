import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { proto, type WAMessage } from "baileys";
import { DateTime } from "luxon";
import { db } from "../src/db/index.js";
import { waMensaje, waProgramado } from "../src/db/schema.js";
import { Procesador } from "../src/bot/procesador.js";
import type { Interpretacion } from "../src/bot/ia.js";
import {
  buscarMensajesWa,
  enviarProgramadosWa,
  guardarChatsWa,
  guardarMensajesWa,
  leerChatWa,
  listarChatsWa,
  programadosWa,
  purgarWa,
} from "../src/servicios/wa-personal.js";
import { personal } from "../src/whatsapp/personal.js";
import { baseLimpia, enviadorFalso, panelConSesion, reloj } from "./ayuda.js";

// Claude simulado (como en agente.test.ts): el guion elige herramientas reales y arma la respuesta con lo que devuelven.
type Llamada = { name: string; input: Record<string, unknown> };
type Params = { tools: { name: string; run?: (i: unknown) => Promise<string> }[]; messages: { role: string; content: string }[] };
const guion = vi.fn<(p: Params) => { llamadas: Llamada[]; responder: (resultados: string[]) => string }>();
vi.mock("../src/bot/ia.js", async (orig) => ({
  ...(await orig<object>()),
  cliente: () => ({
    beta: {
      messages: {
        toolRunner: (p: Params) => ({
          async *[Symbol.asyncIterator]() {
            const { llamadas, responder } = guion(p);
            const resultados: string[] = [];
            for (const l of llamadas) resultados.push(await p.tools.find((t) => t.name === l.name)!.run!(l.input));
            yield { usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn", content: [{ type: "text", text: responder(resultados) }] };
          },
        }),
      },
    },
  }),
  interpretar: vi.fn(),
}));

const local = (iso: string) => DateTime.fromISO(iso, { zone: "America/Argentina/Buenos_Aires" }).toJSDate();
const JUAN = "5491155550001@s.whatsapp.net";
const FAMILIA = "120363000000000009@g.us";
let n = 0;
const msg = (chat: string, contenido: proto.IMessage, extra: Partial<WAMessage> & { hace?: number; deMi?: boolean } = {}): WAMessage => ({
  key: { id: extra.key?.id ?? `M${++n}`, remoteJid: chat, fromMe: !!extra.deMi },
  message: contenido,
  messageTimestamp: Math.floor((Date.now() - (extra.hace ?? 0) * 60_000) / 1000),
  pushName: extra.pushName,
});
const guardar = (ms: WAMessage[], masAtras = false) => guardarMensajesWa(ms.map((m) => ({ msg: m, chatJid: m.key.remoteJid! })), masAtras);

describe("tu WhatsApp", () => {
  beforeEach(async () => {
    await baseLimpia();
    guion.mockReset();
    reloj(local("2026-11-23T10:00"));
    vi.spyOn(personal, "tieneSesion").mockResolvedValue(true);
    vi.spyOn(personal, "conectado").mockReturnValue(true);
    vi.spyOn(personal, "enviar").mockResolvedValue();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("guarda 7 días cifrados, con nombres, ediciones y borrados; busca, lee y purga", async () => {
    await guardarChatsWa([{ jid: JUAN, nombre: "Juan Pérez" }, { jid: FAMILIA, nombre: "Familia" }]);
    const editado = msg(JUAN, { conversation: "nos vemos a las 8" }, { hace: 30, pushName: "Juancito" });
    const borrado = msg(JUAN, { conversation: "esto lo borró" }, { hace: 20 });
    const nuevos = await guardar([
      editado,
      borrado,
      msg(JUAN, { conversation: "dale, llevo el vino" }, { hace: 10, deMi: true }),
      msg(FAMILIA, { imageMessage: { caption: "el asado del domingo" } }, { hace: 5, pushName: "Mamá" }),
      msg(FAMILIA, { reactionMessage: { text: "❤️" } }, { hace: 4 }),
      msg(JUAN, { conversation: "viejo" }, { hace: 8 * 1440 }),
    ]);
    expect(nuevos).toBe(4); // Ni la reacción ni el de hace 8 días.
    expect(await guardar([editado])).toBe(0); // Repetido.
    await guardar([
      msg(JUAN, { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: editado.key, editedMessage: { conversation: "nos vemos a las 9" } } }),
      msg(JUAN, { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: borrado.key } }),
    ]);

    // El texto queda cifrado en la base.
    expect(JSON.stringify(await db.select().from(waMensaje))).not.toContain("vino");

    expect(await leerChatWa(JUAN)).toMatchObject([
      { chat: "Juan Pérez", de: "Juan Pérez", texto: "nos vemos a las 9" },
      { chat: "Juan Pérez", de: "Yo", texto: "dale, llevo el vino" },
    ]);
    expect((await buscarMensajesWa("asado")).map((m) => [m.chat, m.de, m.texto])).toEqual([["Familia", "Mamá", "[foto] el asado del domingo"]]);
    expect(await buscarMensajesWa("borró")).toEqual([]);
    // Nombre de la agenda, y si no, el que se puso la persona; el chat más reciente primero.
    expect((await listarChatsWa()).map((c) => c.nombre)).toEqual(["Familia", "Juan Pérez"]);
    await guardarChatsWa([{ jid: JUAN, apodo: "Juancito" }]);
    expect((await listarChatsWa("juan")).map((c) => c.nombre)).toEqual(["Juan Pérez"]);
    expect((await listarChatsWa("5555")).map((c) => c.jid)).toEqual([JUAN]);

    // Los traídos de más atrás se guardan 1 día; la purga borra lo vencido.
    expect(await guardar([msg(JUAN, { conversation: "de hace mucho" }, { hace: 30 * 1440 })], true)).toBe(1);
    reloj(local("2026-11-24T10:01"));
    await purgarWa();
    expect((await leerChatWa(JUAN)).map((m) => m.texto)).toEqual(["nos vemos a las 9", "dale, llevo el vino"]);
  });

  describe("con el asistente", () => {
    let app: FastifyInstance;
    let headers: Record<string, string>;
    beforeEach(async () => {
      ({ app, headers } = await panelConSesion());
      await guardarChatsWa([{ jid: JUAN, nombre: "Juan Pérez" }]);
    });
    afterEach(() => app.close());
    const preguntar = async (texto: string) => (await app.inject({ method: "POST", url: "/api/agente", headers, payload: { texto } })).json().respuesta as string;

    /** El asistente llama a wa_enviar y contesta lo que le devuelve (la primera vez, lo que te tiene que mostrar). */
    const enviar = (input: Record<string, unknown>) => guion.mockReturnValueOnce({ llamadas: [{ name: "wa_enviar", input }], responder: ([r]) => r });
    const MACA = "5491166660002@s.whatsapp.net";

    it("como en la captura: busca por alias, te muestra el mensaje y con tu sí lo manda", async () => {
      await guardarChatsWa([{ jid: MACA, nombre: "Macarena Oviedo (Cliente Mayorista)" }, { jid: "5491166660003@s.whatsapp.net", nombre: "Maca Cardozo" }]);
      // "Maca" busca varios; cuando le decís cuál, lo guarda como alias y desde ahí "maca" es solo ese chat.
      expect((await listarChatsWa("maca")).length).toBe(2);
      guion.mockReturnValueOnce({ llamadas: [{ name: "wa_alias", input: { chat_jid: MACA, alias: "Maca" } }], responder: ([r]) => r });
      expect(await preguntar("es la primera, siempre que te digo maca es ella")).toBe('Listo: "Maca" es siempre Macarena Oviedo (Cliente Mayorista).');
      expect((await listarChatsWa("maca")).map((c) => c.jid)).toEqual([MACA]);

      // Primera llamada: no manda, devuelve qué mostrarte (con el nombre y el texto exactos).
      enviar({ chat_jid: MACA, texto: "¿Estás durmiendo?" });
      const mostrado = await preguntar("mandale a maca si está durmiendo");
      expect(mostrado).toContain('📤 *Para:* Macarena Oviedo (Cliente Mayorista)\n💬 *Texto:* "¿Estás durmiendo?"');
      expect(personal.enviar).not.toHaveBeenCalled();

      // El asistente te lo muestra con sus palabras (sin el aclarado entre paréntesis) y vos decís que sí: sale.
      guion.mockReturnValueOnce({ llamadas: [], responder: () => '📤 Para: *Macarena Oviedo*\n💬 Texto: "¿Estás durmiendo?"\n\n¿Lo mando?' });
      await preguntar("¿cómo quedó?");
      enviar({ chat_jid: MACA, texto: "¿Estás durmiendo?" });
      expect(await preguntar("Sí")).toBe("Enviado a Macarena Oviedo (Cliente Mayorista).");
      expect(personal.enviar).toHaveBeenCalledWith(MACA, "¿Estás durmiendo?");
    });

    it("como en la segunda captura: nombre sin paréntesis y el corazón escrito de otra forma, igual sale", async () => {
      await guardarChatsWa([{ jid: MACA, nombre: "Macarena Oviedo (Cliente Mayorista)" }]);
      guion.mockReturnValueOnce({ llamadas: [], responder: () => '📤 *Para:* Macarena Oviedo Cliente Mayorista\n💬 *Texto:* "Te amo ❤"\n\n¿Lo mando?' });
      await preguntar("mandale a maca te amo");
      enviar({ chat_jid: MACA, texto: "Te amo ❤️" });
      expect(await preguntar("si mandalo")).toBe("Enviado a Macarena Oviedo (Cliente Mayorista).");
    });

    it("no manda lo que no viste: otro texto, otra persona o algo que no te mostró justo antes", async () => {
      await guardarChatsWa([{ jid: MACA, nombre: "Macarena Oviedo" }]);
      enviar({ chat_jid: JUAN, texto: "Llego 10 min tarde" });
      await preguntar("avisale a juan que llego 10 min tarde");
      // Te mostró un texto y quiere mandar otro, o a otra persona.
      enviar({ chat_jid: JUAN, texto: "Llego 20 min tarde" });
      expect(await preguntar("sí")).toContain("No se mandó todavía");
      enviar({ chat_jid: MACA, texto: "Llego 20 min tarde" });
      expect(await preguntar("sí")).toContain("No se mandó todavía");
      // Lo que te mostró quedó antes de otra charla: ya no cuenta.
      guion.mockReturnValueOnce({ llamadas: [], responder: () => "Mañana llueve ☔" });
      await preguntar("¿llueve mañana?");
      enviar({ chat_jid: MACA, texto: "Llego 20 min tarde" });
      expect(await preguntar("dale")).toContain("No se mandó todavía");
      expect(personal.enviar).not.toHaveBeenCalled();
    });

    it("programa, lista, manda a la hora y avisa si no pudo", async () => {
      const bot = enviadorFalso();
      const programar = async (texto: string, enviar_en: string) => {
        enviar({ chat_jid: JUAN, texto, enviar_en });
        await preguntar(`programale a juan: ${texto}`);
        enviar({ chat_jid: JUAN, texto, enviar_en });
        return preguntar("dale");
      };
      expect(await programar("¡Feliz cumple!", "2026-11-24T09:00:00-03:00")).toBe("Programado: le llega a Juan Pérez mañana a las 9:00.");
      await programar("Recordá lo del viernes", "2026-11-23T12:00:00-03:00");
      expect((await programadosWa()).map((p) => p.texto)).toEqual(["Recordá lo del viernes", "¡Feliz cumple!"]);

      // A las 12 sale el primero.
      reloj(local("2026-11-23T12:00"));
      await enviarProgramadosWa(personal);
      expect(personal.enviar).toHaveBeenCalledWith(JUAN, "Recordá lo del viernes");

      // Mañana tu WhatsApp está desconectado: espera; pasadas 2 horas ya no lo manda y te avisa por el bot.
      vi.mocked(personal.conectado).mockReturnValue(false);
      reloj(local("2026-11-24T10:00"));
      await enviarProgramadosWa(personal);
      expect(await programadosWa()).toHaveLength(1);
      reloj(local("2026-11-24T11:01"));
      await enviarProgramadosWa(personal);
      expect(await programadosWa()).toHaveLength(0);
      expect((await db.select().from(waProgramado)).map((p) => p.estado).sort()).toEqual(["enviado", "vencido"]);
      expect(bot.enviados.at(-1)!.texto).toContain("No pude mandarle a *Juan Pérez*");
      expect(personal.enviar).toHaveBeenCalledTimes(1);
    });

    it("sin tu WhatsApp vinculado, lo dice", async () => {
      vi.mocked(personal.tieneSesion).mockResolvedValue(false);
      guion.mockReturnValueOnce({ llamadas: [{ name: "wa_buscar", input: { consulta: "asado" } }], responder: ([r]) => r });
      expect(await preguntar("¿qué dijeron del asado?")).toContain("tu WhatsApp no está vinculado");
    });

    it("si no está en 7 días, ofrece buscar más atrás", async () => {
      guion.mockReturnValueOnce({ llamadas: [{ name: "wa_buscar", input: { consulta: "contrato" } }], responder: ([r]) => r });
      expect(await preguntar("buscá lo del contrato")).toContain("No está en los mensajes de los últimos 7 días");
      vi.spyOn(personal, "traerMasAtras").mockImplementation(async (jid) => guardar([msg(jid, { conversation: "te mando el contrato" }, { hace: 20 * 1440 })], true));
      guion.mockReturnValueOnce({ llamadas: [{ name: "wa_buscar_mas_atras", input: { chat_jid: JUAN, consulta: "contrato" } }], responder: ([r]) => r });
      expect(JSON.parse(await preguntar("sí, buscá más atrás con juan"))).toMatchObject({ llegaron: 1, mensajes: [{ de: "Juan Pérez", texto: "te mando el contrato" }] });
    });
  });

  it("por WhatsApp, la respuesta a una pregunta del asistente va directo a él (no a los comandos)", async () => {
    const respuestas: string[] = [];
    const bot = new Procesador({
      responder: async (t: string) => (respuestas.push(t), `OUT${respuestas.length}`),
      responderImagen: async () => null,
      responderEncuesta: async () => ({ id: null, secreto: "" }),
      descifrarVoto: () => null,
      descargarMedia: async () => Buffer.alloc(0),
      reaccionar: async () => {},
    });
    const { interpretar } = await import("../src/bot/ia.js");
    vi.mocked(interpretar).mockResolvedValue({ intencion: "consulta" } as Interpretacion);
    guion.mockReturnValueOnce({ llamadas: [], responder: () => 'Para Juan: "Llego tarde". ¿Lo mando? 👍' });
    await bot.procesar({ key: { id: "W1", remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: "avisale a juan que llego tarde" } });
    vi.mocked(interpretar).mockClear();
    guion.mockReturnValueOnce({ llamadas: [], responder: () => "Enviado." });
    await bot.procesar({ key: { id: "W2", remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: "sí" } });
    expect(respuestas).toEqual(['Para Juan: "Llego tarde". ¿Lo mando? 👍', "Enviado."]);
    expect(interpretar).not.toHaveBeenCalled();
    expect(guion.mock.calls[1][0].messages.at(-1)!.content).toMatch(/\nsí$/);

    // Pasada media hora, un "sí" suelto ya no es para el asistente.
    reloj(local("2026-11-23T10:45"));
    vi.mocked(interpretar).mockResolvedValue({ intencion: "desconocido", respuesta: "¿Qué cosa?" } as Interpretacion);
    await bot.procesar({ key: { id: "W3", remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: "sí" } });
    expect(guion).toHaveBeenCalledTimes(2);
  });
});
