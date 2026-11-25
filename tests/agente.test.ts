import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WAMessage } from "baileys";
import { DateTime } from "luxon";
import { Procesador } from "../src/bot/procesador.js";
import type { Interpretacion } from "../src/bot/ia.js";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { gastoDelMes } from "../src/bot/ia.js";
import { crearSuscripcion } from "../src/servicios/suscripciones.js";
import { recordatoriosActivos } from "../src/servicios/recordatorios.js";
import { listarLinks } from "../src/servicios/links.js";
import { crearLink } from "../src/servicios/links.js";
import { baseLimpia, panelConSesion, reloj } from "./ayuda.js";

// Claude simulado: un "guion" decide qué herramientas llama (las herramientas son las de verdad) y qué contesta.
type Llamada = { name: string; input: Record<string, unknown> };
type Params = { model: string; system: string; tools: { name: string; type?: string; run?: (i: unknown) => Promise<string> }[]; messages: { role: string; content: string }[] };
const guion = vi.fn<(p: Params) => { llamadas: Llamada[]; responder: (resultados: string[]) => string }>();
const runner = (p: Params) => ({
  async *[Symbol.asyncIterator]() {
    const { llamadas, responder } = guion(p);
    const resultados: string[] = [];
    for (const l of llamadas) resultados.push(await p.tools.find((t) => t.name === l.name)!.run!(l.input));
    yield { usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, server_tool_use: { web_search_requests: 1 } }, stop_reason: "tool_use", content: [] };
    yield { usage: { input_tokens: 200, output_tokens: 50 }, stop_reason: "end_turn", content: [{ type: "text", text: responder(resultados) }] };
  },
});
const interpretar = vi.fn<(...a: unknown[]) => Promise<Interpretacion>>();
vi.mock("../src/bot/ia.js", async (orig) => ({
  ...(await orig<object>()),
  cliente: () => ({ beta: { messages: { toolRunner: (p: Params) => runner(p) } } }),
  interpretar: (...a: unknown[]) => interpretar(...a),
}));

const local = (iso: string) => DateTime.fromISO(iso, { zone: "America/Argentina/Buenos_Aires" }).toJSDate();

describe("asistente", () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await baseLimpia();
    guion.mockReset();
    interpretar.mockReset();
    reloj(local("2026-11-23T10:00"));
    ({ app, headers } = await panelConSesion());
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  const preguntar = (texto: string) => app.inject({ method: "POST", url: "/api/agente", headers, payload: { texto } });

  it("desde el panel: consulta y crea con las herramientas reales, recuerda la conversación y registra el gasto", async () => {
    await crearSuscripcion({ nombre: "Netflix", url: "", fechaInicio: null, fechaVto: "2026-11-25", monto: 9.99, moneda: "USD", frecuencia: "mensual", observacion: "" });
    guion.mockReturnValueOnce({
      llamadas: [
        { name: "ver_suscripciones", input: {} },
        { name: "crear_recordatorio", input: { titulo: "Pagar Netflix", fecha_hora: "2026-11-24T09:00:00-03:00" } },
      ],
      responder: ([susc, rec]) => `Netflix vence en ${JSON.parse(susc)[0].dias} días. Te agendé "${JSON.parse(rec).titulo}".`,
    });
    const r = await preguntar("¿cuándo vence Netflix? recordame pagarlo mañana a las 9");
    expect(r.json()).toEqual({ respuesta: 'Netflix vence en 2 días. Te agendé "Pagar Netflix".' });
    expect((await recordatoriosActivos()).map((x) => [x.titulo, x.origen])).toEqual([["Pagar Netflix", "panel"]]);

    // Lo que recibe Claude: el sistema con el nombre, todas las herramientas (y la búsqueda web) y la fecha de hoy.
    const p = guion.mock.calls[0][0];
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.system).toContain("asistente personal de Lucas");
    expect(p.tools.map((t) => t.name)).toEqual([
      "ver_agenda",
      "crear_recordatorio",
      "ver_notas",
      "guardar_nota",
      "ver_suscripciones",
      "crear_suscripcion",
      "suscripcion_tarjeta",
      "renovar_suscripcion",
      "ver_tarjetas",
      "cargar_compra_tarjeta",
      "marcar_pago_tarjeta",
      "ver_bloc",
      "agregar_al_bloc",
      "ver_links",
      "guardar_link",
      "wa_chats",
      "wa_leer",
      "wa_buscar",
      "wa_buscar_mas_atras",
      "wa_alias",
      "wa_enviar",
      "wa_programados",
      "resumir_video",
      "borrar",
      "web_search",
    ]);
    expect(p.messages.at(-1)!.content).toBe("[Ahora: lunes 23/11/2026 10:00 (America/Argentina/Buenos_Aires)]\n¿cuándo vence Netflix? recordame pagarlo mañana a las 9");

    // El segundo mensaje lleva la conversación anterior (sin repetir el actual).
    guion.mockReturnValueOnce({ llamadas: [], responder: () => "¡De nada!" });
    await preguntar("gracias");
    expect(guion.mock.calls[1][0].messages.map((m) => [m.role, m.content.split("\n").at(-1)])).toEqual([
      ["user", "¿cuándo vence Netflix? recordame pagarlo mañana a las 9"],
      ["assistant", 'Netflix vence en 2 días. Te agendé "Pagar Netflix".'],
      ["user", "gracias"],
    ]);
    expect((await app.inject({ url: "/api/agente", headers })).json().map((m: { direccion: string }) => m.direccion)).toEqual(["entrante", "saliente", "entrante", "saliente"]);

    // Gasto de las dos preguntas: entrada (con caché leída a 0,1×), salida y una búsqueda web cada una, a precio de Sonnet.
    expect((await gastoDelMes()).costoUsd).toBeCloseTo(2 * (((1000 + 500 + 200) * 2 + 150 * 10) / 1e6 + 0.01), 6);
  });

  it("borrar pide confirmación; con el tope de gasto alcanzado no usa la IA", async () => {
    const { id } = await crearLink({ concepto: "AFIP", url: "https://afip.gob.ar" });
    guion.mockReturnValueOnce({ llamadas: [{ name: "borrar", input: { tipo: "link", id, confirmado: false } }], responder: ([r]) => r });
    expect((await preguntar("borrá el link de AFIP")).json().respuesta).toContain("No se borró");
    expect(await listarLinks()).toHaveLength(1);
    guion.mockReturnValueOnce({ llamadas: [{ name: "borrar", input: { tipo: "link", id, confirmado: true } }], responder: ([r]) => r });
    expect((await preguntar("sí, borralo")).json().respuesta).toBe("Borrado.");
    expect(await listarLinks()).toHaveLength(0);

    await actualizarConfig({ agenteTopeUsd: 0 });
    guion.mockClear();
    expect((await preguntar("¿qué vence?")).json().respuesta).toContain("Llegué al tope de IA de este mes (US$ 0)");
    expect(guion).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: "/api/agente" })).statusCode).toBe(401);
  });

  it("si el asistente solo confirma lo que hizo, por WhatsApp reacciona en vez de escribir", async () => {
    const respuestas: string[] = [];
    const reacciones: string[] = [];
    const bot = new Procesador({
      responder: async (t: string) => (respuestas.push(t), "OUT"),
      responderImagen: async () => null,
      responderEncuesta: async () => ({ id: null, secreto: "" }),
      descifrarVoto: () => null,
      descargarMedia: async () => Buffer.alloc(0),
      reaccionar: async (_m: WAMessage, e: string) => void reacciones.push(e),
    });
    interpretar.mockResolvedValue({ intencion: "consulta" } as Interpretacion);
    guion.mockReturnValueOnce({ llamadas: [], responder: () => "💳" });
    await bot.procesar({ key: { id: "W5", remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: "gasté 30 mil en el súper con la visa" } });
    expect([respuestas, reacciones]).toEqual([[], ["💳"]]);
    expect(guion.mock.calls[0][0].system).toContain("respondé solo con un emoji");
    // Si tiene algo que contar, contesta con texto.
    guion.mockReturnValueOnce({ llamadas: [], responder: () => "Anotado 💳, pero ojo: ya vas $ 900.000 este mes." });
    await bot.procesar({ key: { id: "W6", remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: "y 20 mil de nafta" } });
    expect(respuestas).toEqual(["Anotado 💳, pero ojo: ya vas $ 900.000 este mes."]);
  });

  it("el panel y WhatsApp son conversaciones separadas: cada una con su historial y su memoria", async () => {
    guion.mockReturnValueOnce({ llamadas: [], responder: () => "Hola desde el panel" });
    await preguntar("hola panel");
    const bot = new Procesador({
      responder: async () => "OUT",
      responderImagen: async () => null,
      responderEncuesta: async () => ({ id: null, secreto: "" }),
      descifrarVoto: () => null,
      descargarMedia: async () => Buffer.alloc(0),
      reaccionar: async () => {},
    });
    interpretar.mockResolvedValue({ intencion: "consulta" } as Interpretacion);
    guion.mockReturnValueOnce({ llamadas: [], responder: () => "Hola desde WhatsApp" });
    await bot.procesar({ key: { id: "W9", remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: "hola whatsapp" } });

    // WhatsApp no recuerda lo del panel, y el panel no muestra lo de WhatsApp (ni el historial de WhatsApp lo del panel).
    expect(guion.mock.calls[1][0].messages.map((m) => m.content.split("\n").at(-1))).toEqual(["hola whatsapp"]);
    expect((await app.inject({ url: "/api/agente", headers })).json().map((m: { texto: string }) => m.texto)).toEqual(["hola panel", "Hola desde el panel"]);
    expect((await app.inject({ url: "/api/historial", headers })).json().map((m: { texto: string }) => m.texto)).toEqual(["Hola desde WhatsApp", "hola whatsapp"]);
    // Y el panel recuerda solo lo suyo.
    guion.mockReturnValueOnce({ llamadas: [], responder: () => "¡Dale!" });
    await preguntar("seguimos");
    expect(guion.mock.calls[2][0].messages.map((m) => m.content.split("\n").at(-1))).toEqual(["hola panel", "Hola desde el panel", "seguimos"]);
  });

  it("por WhatsApp, lo que el intérprete marca como consulta lo responde el asistente (en el grupo no)", async () => {
    const respuestas: string[] = [];
    const bot = new Procesador({
      responder: async (t: string) => (respuestas.push(t), `OUT${respuestas.length}`),
      responderImagen: async () => null,
      responderEncuesta: async () => ({ id: null, secreto: "" }),
      descifrarVoto: () => null,
      descargarMedia: async () => Buffer.alloc(0),
      reaccionar: async () => {},
    });
    const consulta = { intencion: "consulta", recordatorios: [], cambios: null, recordatorio_ids: [], referencia: null, listar_desde: null, listar_hasta: null, posponer_minutos: null, posponer_hasta: null, nota: null, nota_ids: [], consulta: null, falta_info: null, respuesta: null, confianza: 1 } as Interpretacion;
    interpretar.mockResolvedValue(consulta);
    guion.mockReturnValueOnce({ llamadas: [{ name: "ver_tarjetas", input: {} }], responder: ([t]) => `Tenés ${JSON.parse(t).length} tarjetas.` });
    await bot.procesar({ key: { id: "W1", remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: "¿cuánto debo de la tarjeta?" } });
    expect(respuestas).toEqual(["Tenés 0 tarjetas."]);
    expect(guion.mock.calls[0][0].messages.at(-1)!.content).toContain("¿cuánto debo de la tarjeta?");

    const G = "120363000000000001@g.us";
    const enGrupo: WAMessage = { key: { id: "G1", remoteJid: G, participant: "5491100000001@s.whatsapp.net" }, pushName: "Ana", message: { conversation: "bot, ¿cuánto está el dólar?" } };
    await bot.procesar(enGrupo, { grupo: { jid: G, nombre: "Familia" }, autor: "Ana" });
    expect(guion).toHaveBeenCalledTimes(1);
  });
});
