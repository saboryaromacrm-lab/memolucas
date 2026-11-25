import Anthropic from "@anthropic-ai/sdk";
import type { WAMessage } from "baileys";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import { iaPendiente } from "../src/db/schema.js";
import { alVolverLaIA, revisarIA } from "../src/bot/estado-ia.js";
import { ErrorIA, motivoFallaIA, type Interpretacion } from "../src/bot/ia.js";
import { Procesador } from "../src/bot/procesador.js";
import { fijarAzar } from "../src/bot/frases.js";
import { obtenerConfig } from "../src/servicios/configuracion.js";
import { recordatoriosActivos } from "../src/servicios/recordatorios.js";
import { baseLimpia, enviadorFalso, panelConSesion, reloj } from "./ayuda.js";

const interpretar = vi.fn<(...a: unknown[]) => Promise<Interpretacion>>();
const probarConexion = vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; mensaje: string; ms: number; motivo?: string }>>();
vi.mock("../src/bot/ia.js", async (orig) => ({
  ...(await orig<object>()),
  interpretar: (...a: unknown[]) => interpretar(...a),
  probarConexion: (...a: unknown[]) => probarConexion(...a),
}));

const Z = "America/Argentina/Buenos_Aires";
const local = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();
const YO = "5491112345678@s.whatsapp.net";
let n = 0;
const texto = (t: string): WAMessage => ({ key: { id: `IN${++n}`, remoteJid: YO }, message: { conversation: t } });

const sinCredito = () =>
  Anthropic.APIError.generate(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
    undefined,
    new Headers(),
  );
const crear = (titulo: string, fecha: string): Interpretacion => ({
  intencion: "crear_recordatorio",
  recordatorios: [{ titulo, descripcion: null, fecha_hora: fecha, recurrencia: null, avisos_previos_min: [], es_evento: false }],
  cambios: null,
  recordatorio_ids: [],
  referencia: null,
  listar_desde: null,
  listar_hasta: null,
  posponer_minutos: null,
  posponer_hasta: null,
  nota: null,
  nota_ids: [],
  consulta: null,
  falta_info: null,
  respuesta: null,
  confianza: 1,
});

describe("cuando la IA no anda", () => {
  const respuestas: string[] = [];
  const reacciones: { id: string; emoji: string }[] = [];
  const bot = new Procesador({
    responder: async (t: string) => (respuestas.push(t), `OUT${respuestas.length}`),
    responderImagen: async () => null,
    responderEncuesta: async () => ({ id: null, secreto: "" }),
    descifrarVoto: () => null,
    descargarMedia: async () => Buffer.alloc(0),
    reaccionar: async (m: WAMessage, emoji: string) => void reacciones.push({ id: m.key.id!, emoji }),
  });
  alVolverLaIA((motivo) => bot.reanudarPendientes(motivo));

  beforeEach(async () => {
    await baseLimpia();
    enviadorFalso();
    respuestas.length = 0;
    reacciones.length = 0;
    interpretar.mockReset();
    probarConexion.mockReset();
    fijarAzar(() => 0);
    reloj(local("2026-11-25T13:29"));
  });
  afterEach(() => vi.useRealTimers());

  it("reconoce el motivo: crédito, clave, Anthropic caído (también envuelto en ErrorIA)", () => {
    expect(motivoFallaIA(sinCredito())).toBe("sin_credito");
    expect(motivoFallaIA(new ErrorIA("Your credit balance is too low", { cause: sinCredito() }))).toBe("sin_credito");
    expect(motivoFallaIA(Anthropic.APIError.generate(401, { error: { message: "invalid x-api-key" } }, undefined, new Headers()))).toBe("clave");
    expect(motivoFallaIA(Anthropic.APIError.generate(529, { error: { message: "Overloaded" } }, undefined, new Headers()))).toBe("caido");
    expect(motivoFallaIA(new ErrorIA("No hay API key de Claude configurada"))).toBe("clave");
    expect(motivoFallaIA(new Error("La respuesta del modelo no tiene el formato esperado"))).toBeNull();
  });

  it("avisa una sola vez, guarda lo que llega y lo hace solo cuando vuelve", async () => {
    interpretar.mockRejectedValue(sinCredito());
    await bot.procesar(texto("Haceme acordar el sábado a las 4 de la tarde de ir a buscar la plata de Mariel"));
    expect(respuestas).toHaveLength(1);
    expect(respuestas[0]).toContain("Se terminó el crédito de la cuenta de Claude");
    expect(respuestas[0]).toContain("lo hago solo cuando vuelva");
    expect((await obtenerConfig()).iaFalla?.motivo).toBe("sin_credito");

    // El segundo: prueba si volvió (no), no repite el aviso y lo marca con ⏳.
    probarConexion.mockResolvedValue({ ok: false, mensaje: "sin crédito", ms: 5, motivo: "sin_credito" });
    const segundo = texto("y el lunes a las 9 llamar al médico");
    await bot.procesar(segundo);
    expect(respuestas).toHaveLength(1);
    expect(reacciones).toEqual([{ id: segundo.key.id!, emoji: "⏳" }]);
    expect(interpretar).toHaveBeenCalledTimes(1); // Con la IA caída no se insiste.

    // Los comandos rápidos andan igual.
    await bot.procesar(texto("hoy"));
    expect(respuestas).toHaveLength(2);
    expect(await db.select().from(iaPendiente)).toHaveLength(2);

    // Vuelve (cargó crédito): el barrido lo nota y hace lo guardado, en orden, con la hora en que llegó cada uno.
    reloj(local("2026-11-25T15:00"));
    probarConexion.mockResolvedValue({ ok: true, mensaje: "OK", ms: 5 });
    interpretar
      .mockResolvedValueOnce(crear("Buscar la plata de Mariel", "2026-11-28T16:00:00-03:00"))
      .mockResolvedValueOnce(crear("Llamar al médico", "2026-11-30T09:00:00-03:00"));
    expect(await revisarIA()).toBe(true);
    expect(respuestas[2]).toBe("✅ Volví a andar. Ahora hago las 2 cosas que me mandaste mientras no podía:");
    expect(respuestas[3]).toContain("*Buscar la plata de Mariel*");
    expect(respuestas[4]).toContain("*Llamar al médico*");
    expect(interpretar.mock.calls[1][1]).toContain("(Esto lo mandé el mié 25/11 13:29 y recién ahora lo podés hacer");
    expect((await recordatoriosActivos()).map((r) => r.titulo)).toEqual(["Buscar la plata de Mariel", "Llamar al médico"]);
    expect(reacciones).toContainEqual({ id: segundo.key.id!, emoji: "" }); // Se sacó el ⏳.
    expect(await db.select().from(iaPendiente)).toHaveLength(0);
    expect((await obtenerConfig()).iaFalla).toBeNull();
    // Volvió porque cargó crédito: pregunta cuánto, como pregunta del asistente (la respuesta la anota él).
    expect(respuestas.at(-1)).toContain("decime cuánto cargaste (por ejemplo «cargué 10 dólares»). ¿Cuánto fue?");
  });

  it("si vuelve con un mensaje nuevo, primero hace lo guardado", async () => {
    interpretar.mockRejectedValueOnce(sinCredito());
    await bot.procesar(texto("recordame mañana a las 10 pagar la luz"));
    probarConexion.mockResolvedValue({ ok: true, mensaje: "OK", ms: 5 });
    interpretar
      .mockResolvedValueOnce(crear("Pagar la luz", "2026-11-26T10:00:00-03:00"))
      .mockResolvedValueOnce(crear("Comprar pan", "2026-11-26T18:00:00-03:00"));
    await bot.procesar(texto("mañana a las 18 comprar pan"));
    expect(respuestas[1]).toBe("✅ Volví a andar. Ahora hago lo que me mandaste mientras no podía:");
    expect(respuestas[2]).toContain("*Pagar la luz*");
    expect(respuestas[3]).toContain("¿Cuánto fue?");
    expect(respuestas[4]).toContain("*Comprar pan*");
  });

  it("lo de más de 24 horas no lo hace: lo lista para que lo reenvíe", async () => {
    interpretar.mockRejectedValue(sinCredito());
    await bot.procesar(texto("recordame regar las plantas"));
    reloj(local("2026-11-26T14:00"));
    probarConexion.mockResolvedValue({ ok: true, mensaje: "OK", ms: 5 });
    await revisarIA(true);
    expect(respuestas.at(-2)).toBe(
      "✅ Volví a andar. Estos no los hice porque pasaron más de 24 horas:\n• «recordame regar las plantas» (mié 25/11 13:29)\nSi todavía los necesitás, mandámelos de nuevo.",
    );
    expect(interpretar).toHaveBeenCalledTimes(1);
    expect(await db.select().from(iaPendiente)).toHaveLength(0);
  });

  it("si se vuelve a caer en el medio, lo que falta queda guardado", async () => {
    interpretar.mockRejectedValue(sinCredito());
    await bot.procesar(texto("uno"));
    probarConexion.mockResolvedValue({ ok: false, mensaje: "", ms: 1, motivo: "sin_credito" });
    await bot.procesar(texto("dos"));
    probarConexion.mockResolvedValue({ ok: true, mensaje: "OK", ms: 5 });
    await revisarIA(true); // interpretar sigue rechazando: se corta en el primero.
    expect(await db.select().from(iaPendiente)).toHaveLength(2);
    expect((await obtenerConfig()).iaFalla?.motivo).toBe("sin_credito");
  });

  it("el panel muestra la falla, la causa y cuántos esperan", async () => {
    interpretar.mockRejectedValue(sinCredito());
    await bot.procesar(texto("algo"));
    const { app, headers } = await panelConSesion();
    const estado = (await app.inject({ method: "GET", url: "/api/estado", headers })).json();
    expect(estado.ia.falla).toMatchObject({ motivo: "sin_credito", guardados: 1 });
    expect(estado.ia.falla.causa).toContain("console.anthropic.com");
    await app.close();
  });
});
