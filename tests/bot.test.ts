import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WAMessage } from "baileys";
import { DateTime } from "luxon";
import { Procesador } from "../src/bot/procesador.js";
import type { AnalisisEnlace, AnalisisFoto, Interpretacion } from "../src/bot/ia.js";
import type { ContenidoEnlace } from "../src/servicios/enlaces.js";
import sharp from "sharp";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { ocurrenciasVencidas, procesarOcurrencia } from "../src/servicios/disparador.js";
import { recordatoriosActivos } from "../src/servicios/recordatorios.js";
import { fijarAzar } from "../src/bot/frases.js";
import { hashOpcion } from "../src/servicios/encuestas.js";
import { baseLimpia, enviadorFalso, reloj } from "./ayuda.js";

const interpretar = vi.fn<(...a: unknown[]) => Promise<Interpretacion>>();
const analizarFoto = vi.fn<(...a: unknown[]) => Promise<AnalisisFoto>>();
const analizarEnlace = vi.fn<(...a: unknown[]) => Promise<AnalisisEnlace>>();
const leerEnlace = vi.fn<(...a: unknown[]) => Promise<ContenidoEnlace>>();
const responderConNotas = vi.fn<(...a: unknown[]) => Promise<{ respuesta: string; nota_ids: number[] }>>();
const transcribir = vi.fn<(...a: unknown[]) => Promise<string>>();
vi.mock("../src/servicios/audio.js", async (orig) => ({
  ...(await orig<object>()),
  transcribir: (...a: unknown[]) => transcribir(...a),
}));
vi.mock("../src/bot/ia.js", async (orig) => ({
  ...(await orig<object>()),
  interpretar: (...a: unknown[]) => interpretar(...a),
  analizarFoto: (...a: unknown[]) => analizarFoto(...a),
  analizarEnlace: (...a: unknown[]) => analizarEnlace(...a),
  responderConNotas: (...a: unknown[]) => responderConNotas(...a),
}));
vi.mock("../src/servicios/enlaces.js", async (orig) => ({
  ...(await orig<object>()),
  leerEnlace: (...a: unknown[]) => leerEnlace(...a),
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
  nota: null,
  nota_ids: [],
  consulta: null,
  falta_info: null,
  respuesta: null,
  confianza: 1,
};

let n = 0;
const YO = "5491112345678@s.whatsapp.net";
const texto = (t: string): WAMessage => ({ key: { id: `IN${++n}`, remoteJid: YO }, message: { conversation: t } });
/** Respuesta citando un mensaje del bot (ej. el aviso). */
const respuestaA = (citado: string, t: string): WAMessage => ({
  key: { id: `IN${++n}`, remoteJid: YO },
  message: { extendedTextMessage: { text: t, contextInfo: { stanzaId: citado } } },
});
/** Voto en una encuesta. En las pruebas, el "cifrado" es el texto de la opción. */
const voto = (encuesta: string, opcion: string): WAMessage => ({
  key: { id: `V${++n}`, remoteJid: YO },
  message: { pollUpdateMessage: { pollCreationMessageKey: { id: encuesta }, vote: { encPayload: Buffer.from(opcion), encIv: Buffer.alloc(12) } } },
});

describe("bot", () => {
  const respuestas: string[] = [];
  const destinos: (string | null)[] = [];
  const encuestas: { nombre: string; opciones: string[]; id: string }[] = [];
  const canal = {
    responderEncuesta: async (nombre: string, opciones: string[]) => {
      const id = `ENC${encuestas.length + 1}`;
      encuestas.push({ nombre, opciones, id });
      return { id, secreto: "prueba" };
    },
    descifrarVoto: (msg: WAMessage) => [hashOpcion(Buffer.from(msg.message!.pollUpdateMessage!.vote!.encPayload!).toString())],
    responder: async (t: string, destino?: string | null) => (respuestas.push(t), destinos.push(destino ?? null), `OUT${respuestas.length}`),
    responderImagen: async (_r: string, _m: string, t: string) => (respuestas.push(`[foto] ${t}`), `OUT${respuestas.length}`),
    reaccionar: async () => {},
    descargarMedia: async () => sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).jpeg().toBuffer(),
  };
  const bot = new Procesador(canal);

  beforeEach(async () => {
    await baseLimpia();
    enviadorFalso();
    respuestas.length = 0;
    destinos.length = 0;
    encuestas.length = 0;
    interpretar.mockReset();
    fijarAzar(() => 0);
    reloj(local("2026-10-22T08:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("crea un recordatorio desde texto y confirma", async () => {
    interpretar.mockResolvedValue({
      ...base,
      intencion: "crear_recordatorio",
      recordatorios: [{ titulo: "Pagar la luz", descripcion: null, fecha_hora: "2026-10-23T10:00:00-03:00", recurrencia: null, avisos_previos_min: [], es_evento: false }],
    });
    await bot.procesar(texto("Recordame mañana a las 10 pagar la luz"));
    expect(respuestas[0]).toBe("Agendado 👌\n📌 *Pagar la luz*\n🗓️ Mañana · 10:00");
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
      recordatorios: [{ titulo: "Tomar la pastilla", descripcion: null, fecha_hora: "2026-10-22T09:00:00-03:00", recurrencia: null, avisos_previos_min: [], es_evento: false }],
    });
    await bot.procesar(texto("Recordame a las 9 tomar la pastilla"));
    await bot.procesar(texto("hoy"));
    expect(respuestas[1]).toContain("Tomar la pastilla");
    expect(interpretar).toHaveBeenCalledTimes(1);

    vi.setSystemTime(local("2026-10-22T09:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    await bot.procesar(texto("listo"));
    expect(respuestas.at(-1)).toContain("*Tomar la pastilla*, hecho");
    expect(interpretar).toHaveBeenCalledTimes(1);
  });

  it("si la IA falla responde el mensaje de error", async () => {
    interpretar.mockRejectedValue(new Error("caída"));
    await bot.procesar(texto("algo raro"));
    expect(respuestas[0]).toBe("Se me trabó algo 😅 ¿Me lo mandás de nuevo en un ratito?");
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
      texto_visible: null,
    });
    const foto: WAMessage = {
      key: { id: "FOTO1", remoteJid: "5491112345678@s.whatsapp.net" },
      message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000 } },
    };
    await bot.procesar(foto);
    expect(respuestas[0]).toContain("¿Te lo recuerdo el 29/10");
    expect(encuestas[0].opciones).toEqual(["✅ Dale", "✏️ Otra fecha", "❌ No"]);
    await bot.procesar(texto("dale"));
    expect(respuestas[1]).toContain("*Pagar la luz*");
    const [rec] = await recordatoriosActivos();
    expect(rec.adjuntoId).not.toBeNull();
    expect(rec.descripcion).toContain("$25.400");
    vi.setSystemTime(local("2026-10-29T10:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    expect(wa.enviados[0].imagen).toBeTruthy();
  });

  const contenido = (extra: Partial<ContenidoEnlace> = {}): ContenidoEnlace => ({
    url: "https://entradas.com/recital",
    urlFinal: "https://entradas.com/recital",
    sitio: "entradas.com",
    titulo: "Recital de La Banda",
    descripcion: "15/11 21 hs en el Movistar Arena",
    texto: null,
    evento: null,
    imagen: null,
    legible: true,
    esInstagram: false,
    ...extra,
  });
  const analisis = (extra: Partial<AnalisisEnlace> = {}): AnalisisEnlace => ({
    tipo: "evento",
    resumen: "Recital de La Banda el 15/11 a las 21 en el Movistar Arena.",
    titulo: "Recital de La Banda",
    fecha_evento: "2026-11-15T21:00:00-03:00",
    lugar: "Movistar Arena",
    accion: "proponer",
    propuesta_fecha_hora: "2026-11-15T21:00:00-03:00",
    propuesta_avisos_previos_min: [1440, 60],
    mensaje: "Es el recital de La Banda el 15/11 a las 21. ¿Te aviso ese día con avisos el día anterior y 1 hora antes?",
    ...extra,
  });

  it("link: propone, acepta con 'dale' y el recordatorio trae el link", async () => {
    leerEnlace.mockResolvedValue(contenido());
    analizarEnlace.mockResolvedValue(analisis());
    await bot.procesar(texto("https://entradas.com/recital"));
    expect(respuestas[0]).toContain("¿Te aviso ese día");
    await bot.procesar(texto("dale"));
    const [rec] = await recordatoriosActivos();
    expect(rec.titulo).toBe("Recital de La Banda");
    expect(rec.origen).toBe("enlace");
    expect(rec.descripcion).toContain("🔗 https://entradas.com/recital");
    expect(rec.avisosPreviosMin).toEqual([1440, 60]);
  });

  it("link con instrucción: lo crea directo", async () => {
    leerEnlace.mockResolvedValue(contenido({ titulo: "Ñoquis caseros", descripcion: "Receta" }));
    analizarEnlace.mockResolvedValue(
      analisis({ tipo: "receta", titulo: "Ver receta de ñoquis", accion: "crear", propuesta_fecha_hora: "2026-10-24T10:00:00-03:00", propuesta_avisos_previos_min: [] }),
    );
    await bot.procesar(texto("recordame el sábado ver esto https://recetas.com/noquis"));
    expect(respuestas[0]).toContain("📌 *Ver receta de ñoquis*");
    expect(analizarEnlace.mock.calls[0][2]).toBe("recordame el sábado ver esto");
  });

  it("link que no se puede leer: pide captura y la foto hereda el link", async () => {
    leerEnlace.mockResolvedValue(contenido({ legible: false, esInstagram: true, titulo: null, descripcion: null }));
    await bot.procesar(texto("https://www.instagram.com/p/ABC/"));
    expect(respuestas[0]).toContain("captura de pantalla");
    expect(respuestas[0]).toContain("Instagram");
    analizarFoto.mockResolvedValue({
      tipo: "entrada",
      descripcion: "Flyer de fiesta",
      util: true,
      titulo: "Fiesta",
      fecha_evento: null,
      monto: null,
      lugar: null,
      propuesta_fecha_hora: "2026-10-30T22:00:00-03:00",
      propuesta_avisos_previos_min: [],
      mensaje: "¿Te lo recuerdo el 30/10 a las 22?",
      texto_visible: null,
    });
    await bot.procesar({ key: { id: "FOTO2", remoteJid: "5491112345678@s.whatsapp.net" }, message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000 } } });
    await bot.procesar(texto("dale"));
    const [rec] = await recordatoriosActivos();
    expect(rec.descripcion).toContain("🔗 https://www.instagram.com/p/ABC/");
    expect(rec.adjuntoId).not.toBeNull();
  });

  it("audio: transcribe, muestra lo entendido y lo procesa", async () => {
    transcribir.mockResolvedValue("recordame mañana a las 10 pagar la luz");
    interpretar.mockResolvedValue({
      ...base,
      intencion: "crear_recordatorio",
      recordatorios: [{ titulo: "Pagar la luz", descripcion: null, fecha_hora: "2026-10-23T10:00:00-03:00", recurrencia: null, avisos_previos_min: [], es_evento: false }],
    });
    await bot.procesar({ key: { id: "AUD1", remoteJid: "5491112345678@s.whatsapp.net" }, message: { audioMessage: { seconds: 5, mimetype: "audio/ogg; codecs=opus" } } });
    expect(respuestas[0]).toBe("🎙️ Entendí: “recordame mañana a las 10 pagar la luz”");
    expect(respuestas[1]).toContain("*Pagar la luz*");
    expect(interpretar.mock.calls[0][1]).toBe("recordame mañana a las 10 pagar la luz");
  });

  it("audio muy largo: no lo transcribe", async () => {
    await bot.procesar({ key: { id: "AUD2", remoteJid: "5491112345678@s.whatsapp.net" }, message: { audioMessage: { seconds: 500 } } });
    expect(respuestas[0]).toContain("muy largo");
    expect(transcribir).not.toHaveBeenCalled();
  });

  it("notas: guarda cifrada y responde preguntas", async () => {
    interpretar.mockResolvedValueOnce({
      ...base,
      intencion: "nota_guardar",
      nota: { titulo: "Clave wifi oficina", contenido: "La clave del wifi de la oficina es Mate2026!", categoria: "claves" },
    });
    await bot.procesar(texto("anotá que la clave del wifi de la oficina es Mate2026!"));
    expect(respuestas[0]).toContain("Anotado: *Clave wifi oficina*");

    const { db } = await import("../src/db/index.js");
    const { sql } = await import("drizzle-orm");
    const crudo = await db.execute(sql`select titulo_cifrado, contenido_cifrado from nota`);
    expect(JSON.stringify(crudo.rows)).not.toContain("Mate2026");

    interpretar.mockResolvedValueOnce({ ...base, intencion: "nota_consultar", consulta: "clave del wifi" });
    responderConNotas.mockResolvedValueOnce({ respuesta: "La clave del wifi de la oficina es *Mate2026!*", nota_ids: [1] });
    await bot.procesar(texto("¿cuál era la clave del wifi?"));
    expect(respuestas[1]).toContain("Mate2026!");
    const notasEnviadas = responderConNotas.mock.calls[0][2] as { contenido: string }[];
    expect(notasEnviadas[0].contenido).toContain("Mate2026!");

    await bot.procesar(texto("notas"));
    expect(respuestas[2]).toContain("Clave wifi oficina");
  });

  it("foto con 'guardala como nota' va a notas", async () => {
    analizarFoto.mockResolvedValue({
      tipo: "otro",
      descripcion: "Patente del auto",
      util: false,
      titulo: "Patente del auto",
      fecha_evento: null,
      monto: null,
      lugar: null,
      propuesta_fecha_hora: null,
      propuesta_avisos_previos_min: [],
      mensaje: "",
      texto_visible: "AB 123 CD",
    });
    await bot.procesar({
      key: { id: "FOTO3", remoteJid: "5491112345678@s.whatsapp.net" },
      message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000, caption: "guardala como nota" } },
    });
    expect(respuestas[0]).toContain("Guardé la nota *Patente del auto*");
    const { todasLasNotas } = await import("../src/servicios/notas.js");
    const [n] = await todasLasNotas();
    expect(n.contenido).toContain("AB 123 CD");
    expect(n.adjuntoId).not.toBeNull();
    expect(await recordatoriosActivos()).toHaveLength(0);
  });

  const crear = (titulo: string, fecha: string, extra: Partial<Interpretacion["recordatorios"][number]> = {}) =>
    interpretar.mockResolvedValueOnce({
      ...base,
      intencion: "crear_recordatorio",
      recordatorios: [{ titulo, descripcion: null, fecha_hora: fecha, recurrencia: null, avisos_previos_min: [], es_evento: false, ...extra }],
    });

  it("a un turno sin aviso previo le ofrece uno", async () => {
    crear("Turno con el doctor", "2026-10-30T09:00:00-03:00", { es_evento: true });
    await bot.procesar(texto("tengo turno con el doctor el viernes 30 a las 9"));
    expect(respuestas[0]).toContain("📌 *Turno con el doctor*\n🗓️ Viernes 30/10 · 9:00");
    expect(respuestas[0]).toContain("¿Querés que te avise antes también?");

    crear("Pagar la luz", "2026-10-30T09:00:00-03:00", { avisos_previos_min: [60] });
    await bot.procesar(texto("recordame pagar la luz el viernes a las 9 con aviso 1 hora antes"));
    expect(respuestas[1]).toContain("🔔 También te aviso 1 hora antes");
    expect(respuestas[1]).not.toContain("¿Querés que te avise antes");
  });

  it("aviso con encuesta: posponer 15 min y después 'Hecho'", async () => {
    const wa = enviadorFalso();
    crear("Sacar la ropa", "2026-10-22T09:00:00-03:00");
    await bot.procesar(texto("recordame a las 9 sacar la ropa"));
    vi.setSystemTime(local("2026-10-22T09:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    expect(wa.enviados[0].texto).toContain("⏰ *Sacar la ropa*");
    expect(wa.enviados[0].texto).not.toContain("Respondé *listo*");
    expect(wa.encuestas[0].opciones).toEqual(["✅ Hecho", "⏰ En 15 min", "⏰ En 1 h", "📅 Mañana a las 09:00"]);

    await bot.procesar(voto(wa.encuestas[0].id, "⏰ En 15 min"));
    expect(respuestas.at(-1)).toContain("hoy a las 9:15");
    // Un segundo voto en la misma encuesta no hace nada.
    await bot.procesar(voto(wa.encuestas[0].id, "✅ Hecho"));
    expect(respuestas).toHaveLength(2);

    vi.setSystemTime(local("2026-10-22T09:15"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    expect(wa.encuestas).toHaveLength(2);
    await bot.procesar(voto(wa.encuestas[1].id, "✅ Hecho"));
    expect(respuestas.at(-1)).toContain("*Sacar la ropa*, hecho");
    expect(await recordatoriosActivos()).toHaveLength(0);
  });

  it("la insistencia es una sola encuesta", async () => {
    const wa = enviadorFalso();
    crear("Tomar la pastilla", "2026-10-22T09:00:00-03:00");
    await bot.procesar(texto("recordame a las 9 tomar la pastilla"));
    vi.setSystemTime(local("2026-10-22T09:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    vi.setSystemTime(local("2026-10-22T10:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    expect(wa.enviados).toHaveLength(1);
    expect(wa.encuestas).toHaveLength(2);
    expect(wa.encuestas[1].nombre).toBe("🔁 ¿Pudiste con Tomar la pastilla?");
    // Escribir "listo" sigue funcionando.
    await bot.procesar(texto("listo"));
    expect(respuestas.at(-1)).toContain("*Tomar la pastilla*, hecho");
  });

  it("'no voy' respondiendo al aviso: un turno único se cancela", async () => {
    const wa = enviadorFalso();
    crear("Turno dentista", "2026-10-22T09:00:00-03:00", { es_evento: true, avisos_previos_min: [60] });
    await bot.procesar(texto("turno dentista hoy a las 9, avisame 1 hora antes"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    expect(wa.enviados[0].texto).toContain("En 1 hora");
    expect(wa.encuestas).toHaveLength(0); // El aviso previo no lleva encuesta.
    interpretar.mockResolvedValueOnce({ ...base, intencion: "cancelar_aviso" });
    await bot.procesar(respuestaA(wa.enviados[0].id, "no voy, se suspendió"));
    expect(respuestas.at(-1)).toContain("*Turno dentista*");
    expect(await recordatoriosActivos()).toHaveLength(0);
  });

  it("'hoy no voy' a un recurrente saltea esa vez", async () => {
    const wa = enviadorFalso();
    crear("Gimnasio", "2026-10-22T09:00:00-03:00", { recurrencia: "FREQ=WEEKLY;BYDAY=TH" });
    await bot.procesar(texto("todos los jueves a las 9 gimnasio"));
    vi.setSystemTime(local("2026-10-22T09:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    interpretar.mockResolvedValueOnce({ ...base, intencion: "cancelar_aviso" });
    await bot.procesar(respuestaA(wa.enviados[0].id, "hoy no voy"));
    expect(respuestas.at(-1)).toContain("salteo este");
    const [rec] = await recordatoriosActivos();
    expect(DateTime.fromJSDate(rec.proximaInstancia!).setZone(Z).toFormat("yyyy-MM-dd HH:mm")).toBe("2026-10-29 09:00");
    // Ya no insiste con el de hoy.
    vi.setSystemTime(local("2026-10-22T10:00"));
    expect(await ocurrenciasVencidas()).toHaveLength(0);
  });

  it("si hay varios, pregunta cuál con una encuesta", async () => {
    crear("Llamar a Juan", "2026-10-23T10:00:00-03:00");
    await bot.procesar(texto("recordame mañana a las 10 llamar a Juan"));
    crear("Llamar a Juana", "2026-10-24T10:00:00-03:00");
    await bot.procesar(texto("recordame el sábado a las 10 llamar a Juana"));
    const [a, b] = await recordatoriosActivos();
    interpretar.mockResolvedValueOnce({ ...base, intencion: "borrar", recordatorio_ids: [a.id, b.id] });
    await bot.procesar(texto("borrá lo de llamar"));
    expect(encuestas[0].nombre).toBe("Encontré varios. ¿Cuál querés borrar?");
    expect(encuestas[0].opciones).toHaveLength(2);
    await bot.procesar(voto(encuestas[0].id, encuestas[0].opciones[1]));
    expect(respuestas.at(-1)).toContain(`*${b.titulo}*`);
    const quedan = await recordatoriosActivos();
    expect(quedan.map((r) => r.id)).toEqual([a.id]);
  });

  it("propuesta de una foto: 'Otra fecha' y después la fecha", async () => {
    analizarFoto.mockResolvedValue({
      tipo: "turno",
      descripcion: "Turno médico",
      util: true,
      titulo: "Turno médico",
      fecha_evento: "2026-10-30T09:00:00-03:00",
      monto: null,
      lugar: null,
      propuesta_fecha_hora: "2026-10-30T09:00:00-03:00",
      propuesta_avisos_previos_min: [60],
      mensaje: "Es un turno médico el 30/10 a las 9. ¿Te lo agendo con aviso 1 hora antes?",
      texto_visible: null,
    });
    await bot.procesar({ key: { id: "FOTO9", remoteJid: YO }, message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000 } } });
    await bot.procesar(voto(encuestas[0].id, "✏️ Otra fecha"));
    expect(respuestas.at(-1)).toContain("¿para cuándo?");
    crear("Turno médico", "2026-10-31T11:00:00-03:00", { es_evento: true });
    await bot.procesar(texto("el 31 a las 11"));
    const [rec] = await recordatoriosActivos();
    expect(rec.adjuntoId).not.toBeNull();
  });

  it("con las encuestas apagadas, contesta con texto", async () => {
    await actualizarConfig({ usarEncuestas: false });
    const wa = enviadorFalso();
    crear("Sacar la basura", "2026-10-22T09:00:00-03:00");
    await bot.procesar(texto("a las 9 sacar la basura"));
    vi.setSystemTime(local("2026-10-22T09:00"));
    for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
    expect(wa.encuestas).toHaveLength(0);
    expect(wa.enviados[0].texto).toContain("Respondé *listo*");
  });

  it("'agregá a la lista' se guarda como nota", async () => {
    interpretar.mockResolvedValueOnce({
      ...base,
      intencion: "nota_guardar",
      nota: { titulo: "Compras", contenido: "leche, pan", categoria: "compras" },
    });
    await bot.procesar(texto("agregá leche y pan a la lista"));
    expect(respuestas[0]).toContain("Anotado: *Compras*");
  });

  describe("grupo de la familia", () => {
    const G = "120363000000000001@g.us";
    const origen = { grupo: { jid: G, nombre: "Familia" }, autor: "Ana" };
    const enGrupo = (t: string): WAMessage => ({
      key: { id: `G${++n}`, remoteJid: G, participant: "5491100000001@s.whatsapp.net" },
      pushName: "Ana",
      message: { conversation: t },
    });

    it("la charla del grupo se ignora (sin respuesta)", async () => {
      interpretar.mockResolvedValue({ ...base, intencion: "ignorar" });
      await bot.procesar(enGrupo("¿qué comemos hoy?"), origen);
      expect(respuestas).toHaveLength(0);
      const ctx = interpretar.mock.calls[0][2] as { grupo: { nombre: string; autor: string } };
      expect(ctx.grupo).toEqual({ nombre: "Familia", autor: "Ana" });
      const { db } = await import("../src/db/index.js");
      const { mensaje } = await import("../src/db/schema.js");
      const [m] = await db.select().from(mensaje);
      expect(m.chat).toBe(G);
      expect(m.autor).toBe("Ana");
    });

    it("un recordatorio del grupo avisa en el grupo y no se mezcla con lo personal", async () => {
      interpretar.mockResolvedValueOnce({
        ...base,
        intencion: "crear_recordatorio",
        recordatorios: [{ titulo: "Cumple de la abuela", descripcion: null, fecha_hora: "2026-10-22T09:00:00-03:00", recurrencia: null, avisos_previos_min: [], es_evento: false }],
      });
      await bot.procesar(enGrupo("recordanos a las 9 el cumple de la abuela"), origen);
      expect(respuestas[0]).toContain("*Cumple de la abuela*");
      expect(destinos[0]).toBe(G);

      interpretar.mockResolvedValueOnce({
        ...base,
        intencion: "crear_recordatorio",
        recordatorios: [{ titulo: "Algo mío", descripcion: null, fecha_hora: "2026-10-22T10:00:00-03:00", recurrencia: null, avisos_previos_min: [], es_evento: false }],
      });
      await bot.procesar(texto("recordame a las 10 algo mío"));
      expect(destinos[1]).toBeNull();

      const { textoTodos } = await import("../src/servicios/listados.js");
      expect(await textoTodos(G)).not.toContain("Algo mío");
      expect(await textoTodos(null)).not.toContain("Cumple de la abuela");

      const wa = enviadorFalso();
      vi.setSystemTime(local("2026-10-22T09:00"));
      for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
      expect(wa.enviados[0].destino).toBe(G);

      // "listo" en el grupo confirma el aviso que está insistiendo.
      await bot.procesar(enGrupo("listo"), origen);
      expect(respuestas.at(-1)).toContain("*Cumple de la abuela*, hecho");
    });

    it("'listo' en el grupo sin avisos pendientes es charla", async () => {
      interpretar.mockResolvedValue({ ...base, intencion: "ignorar" });
      await bot.procesar(enGrupo("listo, ya salgo"), origen);
      await bot.procesar(enGrupo("listo"), origen);
      expect(respuestas).toHaveLength(0);
    });

    it("las notas no se usan en el grupo", async () => {
      interpretar.mockResolvedValue({ ...base, intencion: "nota_consultar", consulta: "clave del wifi" });
      await bot.procesar(enGrupo("bot, ¿cuál es la clave del wifi?"), origen);
      expect(respuestas[0]).toContain("personales");
      expect(responderConNotas).not.toHaveBeenCalled();
      const ctx = interpretar.mock.calls[0][2] as { notas: string };
      expect(ctx.notas).toBe("");
    });

    it("fotos y audios de la charla no hacen nada", async () => {
      analizarFoto.mockReset();
      await bot.procesar(
        { key: { id: "GF1", remoteJid: G }, pushName: "Ana", message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000 } } },
        origen,
      );
      expect(analizarFoto).not.toHaveBeenCalled();
      transcribir.mockResolvedValue("ya estoy llegando");
      interpretar.mockResolvedValue({ ...base, intencion: "ignorar" });
      await bot.procesar({ key: { id: "GA1", remoteJid: G }, pushName: "Ana", message: { audioMessage: { seconds: 4 } } }, origen);
      expect(respuestas).toHaveLength(0);
    });
  });
});
