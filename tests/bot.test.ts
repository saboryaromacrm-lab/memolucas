import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WAMessage } from "baileys";
import { DateTime } from "luxon";
import { Procesador } from "../src/bot/procesador.js";
import type { AnalisisFoto, Interpretacion } from "../src/bot/ia.js";
import sharp from "sharp";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { ocurrenciasVencidas, procesarOcurrencia } from "../src/servicios/disparador.js";
import { recordatoriosActivos } from "../src/servicios/recordatorios.js";
import { baseLimpia, enviadorFalso, reloj } from "./ayuda.js";

const interpretar = vi.fn<(...a: unknown[]) => Promise<Interpretacion>>();
const analizarFoto = vi.fn<(...a: unknown[]) => Promise<AnalisisFoto>>();
vi.mock("../src/bot/ia.js", async (orig) => ({
  ...(await orig<object>()),
  interpretar: (...a: unknown[]) => interpretar(...a),
  analizarFoto: (...a: unknown[]) => analizarFoto(...a),
}));

const Z = "America/Argentina/Buenos_Aires";
const local = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();

const base: Interpretacion = {
  intencion: "desconocido",
  recordatorios: [],
  cambios: null,
  recordatorio_ids: [],
  referencia: null,
  listar_desde: null,
  listar_hasta: null,
  posponer_minutos: null,
  posponer_hasta: null,
  falta_info: null,
  respuesta: null,
  confianza: 1,
};

let n = 0;
const texto = (t: string): WAMessage => ({ key: { id: `IN${++n}`, remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: t } });

describe("bot", () => {
  const respuestas: string[] = [];
  const canal = {
    responder: async (t: string) => (respuestas.push(t), `OUT${respuestas.length}`),
    descargarMedia: async () => sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).jpeg().toBuffer(),
  };
  const bot = new Procesador(canal);

  beforeEach(async () => {
    await baseLimpia();
    enviadorFalso();
    respuestas.length = 0;
    interpretar.mockReset();
    reloj(local("2026-10-22T08:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("crea un recordatorio desde texto y confirma", async () => {
    interpretar.mockResolvedValue({
      ...base,
      intencion: "crear_recordatorio",
      recordatorios: [{ titulo: "Pagar la luz", descripcion: null, fecha_hora: "2026-10-23T10:00:00-03:00", recurrencia: null, avisos_previos_min: [] }],
    });
    await bot.procesar(texto("Recordame mañana a las 10 pagar la luz"));
    expect(respuestas[0]).toBe("Listo ✅ Te recuerdo *Pagar la luz* mañana a las 10:00.");
    const recs = await recordatoriosActivos();
    expect(recs).toHaveLength(1);
    expect(recs[0].origen).toBe("whatsapp");
  });

  it("pregunta cuando falta la hora", async () => {
    interpretar.mockResolvedValue({ ...base, intencion: "crear_recordatorio", falta_info: "fecha", respuesta: "¿Para cuándo te lo recuerdo?" });
    await bot.procesar(texto("Recordame llamar a Juan"));
    expect(respuestas[0]).toBe("¿Para cuándo te lo recuerdo?");
    expect(await recordatoriosActivos()).toHaveLength(0);
  });

  it("comandos rápidos sin IA y 'listo' confirma el último aviso", async () => {
    interpretar.mockResolvedValue({
      ...base,
      intencion: "crear_recordatorio",
      recordatorios: [{ titulo: "Tomar la pastilla", descripcion: null, fecha_hora: "2026-10-22T09:00:00-03:00", recurrencia: null, avisos_previos_min: [] }],
    });
    await bot.procesar(texto("Recordame a las 9 tomar la pastilla"));
    await bot.procesar(texto("hoy"));
    expect(respuestas[1]).toContain("Tomar la pastilla");
    expect(interpretar).toHaveBeenCalledTimes(1);

    vi.setSystemTime(local("2026-10-22T09:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    await bot.procesar(texto("listo"));
    expect(respuestas.at(-1)).toContain("Marqué *Tomar la pastilla* como hecho");
    expect(interpretar).toHaveBeenCalledTimes(1);
  });

  it("si la IA falla responde el mensaje de error", async () => {
    interpretar.mockRejectedValue(new Error("caída"));
    await bot.procesar(texto("algo raro"));
    expect(respuestas[0]).toBe("Uy, no pude procesar eso. ¿Me lo repetís?");
  });

  it("silencio 2h", async () => {
    await bot.procesar(texto("silencio 2h"));
    expect(respuestas[0]).toContain("no te mando avisos hasta hoy a las 10:00");
    await actualizarConfig({ botSilenciadoHasta: null });
  });

  it("foto: propone, acepta con 'dale' y al avisar reenvía la foto", async () => {
    const wa = enviadorFalso();
    analizarFoto.mockResolvedValue({
      tipo: "factura",
      descripcion: "Factura de luz",
      util: true,
      titulo: "Pagar la luz",
      fecha_evento: "2026-10-30T00:00:00-03:00",
      monto: "$25.400",
      lugar: null,
      propuesta_fecha_hora: "2026-10-29T10:00:00-03:00",
      propuesta_avisos_previos_min: [],
      mensaje: "Veo una factura de luz que vence el 30/10 por $25.400. ¿Te lo recuerdo el 29/10 a las 10:00?",
    });
    const foto: WAMessage = {
      key: { id: "FOTO1", remoteJid: "5491112345678@s.whatsapp.net" },
      message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000 } },
    };
    await bot.procesar(foto);
    expect(respuestas[0]).toContain("¿Te lo recuerdo el 29/10");
    await bot.procesar(texto("dale"));
    expect(respuestas[1]).toContain("*Pagar la luz*");
    const [rec] = await recordatoriosActivos();
    expect(rec.adjuntoId).not.toBeNull();
    expect(rec.descripcion).toContain("$25.400");
    vi.setSystemTime(local("2026-10-29T10:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    expect(wa.enviados[0].imagen).toBeTruthy();
  });
});
