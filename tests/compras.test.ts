import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WAMessage } from "baileys";
import sharp from "sharp";
import { db } from "../src/db/index.js";
import { comprobante, grupo } from "../src/db/schema.js";
import { Procesador } from "../src/bot/procesador.js";
import type { Comprobante } from "../src/lib/comprobantes.js";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { hashOpcion } from "../src/servicios/encuestas.js";
import { limpiarArchivosViejos, obtenerComprobante } from "../src/servicios/compras.js";
import { baseLimpia, enviadorFalso } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const leerComprobantes = vi.fn<(...a: unknown[]) => Promise<Comprobante[]>>();
const corregirComprobante = vi.fn<(...a: unknown[]) => Promise<Comprobante>>();
const interpretar = vi.fn();
vi.mock("../src/bot/ia-compras.js", async (orig) => ({
  ...(await orig<object>()),
  leerComprobantes: (...a: unknown[]) => leerComprobantes(...a),
  corregirComprobante: (...a: unknown[]) => corregirComprobante(...a),
}));
vi.mock("../src/bot/ia.js", async (orig) => ({ ...(await orig<object>()), interpretar: (...a: unknown[]) => interpretar(...a) }));

const G = "120363000000000099@g.us";
const origen = { grupo: { jid: G, nombre: "Compras Coffit" }, autor: "Ana" };
const YO = "5491112345678@s.whatsapp.net";
let n = 0;

const foto = (chat = G): WAMessage => ({
  key: { id: `F${++n}`, remoteJid: chat, participant: chat === G ? "5491100000001@s.whatsapp.net" : undefined },
  pushName: "Ana",
  message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000 } },
});
const texto = (t: string, citado?: string): WAMessage => ({
  key: { id: `T${++n}`, remoteJid: G, participant: "5491100000001@s.whatsapp.net" },
  pushName: "Ana",
  message: citado ? { extendedTextMessage: { text: t, contextInfo: { stanzaId: citado } } } : { conversation: t },
});
const voto = (encuesta: string, opcion: string): WAMessage => ({
  key: { id: `V${++n}`, remoteJid: G, participant: "5491100000001@s.whatsapp.net" },
  message: { pollUpdateMessage: { pollCreationMessageKey: { id: encuesta }, vote: { encPayload: Buffer.from(opcion), encIv: Buffer.alloc(12) } } },
});

describe("compras", () => {
  const respuestas: { texto: string; id: string }[] = [];
  const encuestas: { nombre: string; opciones: string[]; id: string }[] = [];
  const reacciones: string[] = [];
  const canal = {
    responder: async (t: string) => {
      const id = `OUT${respuestas.length + 1}`;
      respuestas.push({ texto: t, id });
      return id;
    },
    responderImagen: async () => null,
    responderEncuesta: async (nombre: string, opciones: string[]) => {
      const id = `ENC${encuestas.length + 1}`;
      encuestas.push({ nombre, opciones, id });
      return { id, secreto: "prueba" };
    },
    descifrarVoto: (msg: WAMessage) => [hashOpcion(Buffer.from(msg.message!.pollUpdateMessage!.vote!.encPayload!).toString())],
    descargarMedia: async (msg: WAMessage) =>
      msg.message?.documentMessage ? Buffer.from("%PDF-1.4 prueba") : sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).jpeg().toBuffer(),
    reaccionar: async (_m: WAMessage, emoji: string) => void reacciones.push(emoji),
  };
  const bot = new Procesador(canal);
  const fetchFalso = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

  beforeEach(async () => {
    await baseLimpia();
    enviadorFalso();
    await db.insert(grupo).values({ jid: G, nombre: "Compras Coffit", compras: true });
    await actualizarConfig({ erpUrl: "https://erp.ejemplo.com/compras", comprasEsperaSeg: 60 });
    respuestas.length = 0;
    encuestas.length = 0;
    reacciones.length = 0;
    leerComprobantes.mockReset();
    corregirComprobante.mockReset();
    interpretar.mockReset();
    fetchFalso.mockReset();
    fetchFalso.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchFalso);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("junta las hojas, muestra el resumen y al confirmar lo manda al ERP", async () => {
    leerComprobantes.mockResolvedValue([facturaDePrueba({ archivo: "foto-1.jpg, foto-2.jpg" })]);
    await bot.procesar(foto(), origen);
    await bot.procesar(foto(), origen);
    expect(leerComprobantes).not.toHaveBeenCalled(); // Espera por si llegan más hojas.
    await bot.terminarCompras();

    expect(leerComprobantes).toHaveBeenCalledTimes(1);
    expect((leerComprobantes.mock.calls[0][1] as unknown[]).length).toBe(2);
    expect(reacciones).toEqual(["👀", "👀"]);
    expect(respuestas[0].texto).toContain("🧾 *Factura A 0012-00004567* · 28/10/2026");
    expect(respuestas[0].texto).toContain("Distribuidora del Café SA");
    expect(respuestas[0].texto).toContain("✅ cierra");
    expect(encuestas[0].opciones).toEqual(["✅ Confirmar", "✏️ Corregir", "❌ Descartar"]);

    await bot.procesar(voto(encuestas[0].id, "✅ Confirmar"), origen);
    expect(respuestas.at(-1)!.texto).toBe("✅ Confirmado y enviado al ERP.");
    const [url, init] = fetchFalso.mock.calls[0];
    expect(url).toBe("https://erp.ejemplo.com/compras");
    const cuerpo = JSON.parse(init.body as string) as { comprobantes: Comprobante[] };
    expect(cuerpo.comprobantes[0].encabezado.numero).toBe("00004567");
    expect(cuerpo.comprobantes[0].controles.sumaRenglones).toBe(159000);
    const [fila] = await db.select().from(comprobante);
    expect(fila.estado).toBe("confirmado");
    expect(fila.enviadoEn).not.toBeNull();
    expect(fila.autor).toBe("Ana");
    expect(fila.adjuntoIds).toHaveLength(2);
    expect(fila.datosCifrados).not.toContain("Distribuidora");
  });

  it("si no cierra, relee con el otro modelo y se queda con la lectura que cierra", async () => {
    const mala = facturaDePrueba();
    mala.renglones[0].importe = 13500;
    leerComprobantes.mockResolvedValueOnce([mala]).mockResolvedValueOnce([facturaDePrueba()]);
    await bot.procesar(foto(), origen);
    await bot.terminarCompras();
    expect(leerComprobantes).toHaveBeenCalledTimes(2);
    expect(leerComprobantes.mock.calls[1][2]).toBe("claude-opus-5-5");
    expect(leerComprobantes.mock.calls[1][3]).toContain("Renglón 1");
    expect(respuestas[0].texto).toContain("✅ cierra");
    const [fila] = await db.select().from(comprobante);
    expect(fila.modelo).toBe("claude-opus-5-5");
    expect(fila.estado).toBe("pendiente");
  });

  it("si sigue sin cerrar queda a revisar y dice la diferencia", async () => {
    const mala = facturaDePrueba();
    mala.pie.total = 190000;
    leerComprobantes.mockResolvedValue([mala]);
    await bot.procesar(foto(), origen);
    await bot.terminarCompras();
    expect(respuestas[0].texto).toContain("⚠️ *No cierra:*");
    expect(respuestas[0].texto).toContain("El total calculado da $ 197.160,00 y el impreso dice $ 190.000,00");
    const [fila] = await db.select().from(comprobante);
    expect(fila.estado).toBe("revisar");
  });

  it("avisa si el comprobante ya estaba cargado", async () => {
    leerComprobantes.mockResolvedValue([facturaDePrueba()]);
    await bot.procesar(foto(), origen);
    await bot.terminarCompras();
    await bot.procesar(foto(), origen);
    await bot.terminarCompras();
    expect(respuestas.at(-1)!.texto).toContain("ya estaba cargado");
    expect(respuestas.at(-1)!.texto).toContain("lo mandó Ana");
    expect(await db.select().from(comprobante)).toHaveLength(1);
  });

  it("corregir: toca la opción, escribe la corrección y vuelve a mostrarlo", async () => {
    const mala = facturaDePrueba();
    mala.renglones[0].cantidad = 1;
    leerComprobantes.mockResolvedValue([mala]);
    await bot.procesar(foto(), origen);
    await bot.terminarCompras();
    await bot.procesar(voto(encuestas[0].id, "✏️ Corregir"), origen);
    expect(respuestas.at(-1)!.texto).toContain("decime qué corrijo");

    corregirComprobante.mockResolvedValue(facturaDePrueba());
    await bot.procesar(texto("el renglón 1 son 10 kg"), origen);
    expect(corregirComprobante.mock.calls[0][2]).toBe("el renglón 1 son 10 kg");
    expect(respuestas.at(-1)!.texto).toContain("✅ cierra");
    expect(encuestas).toHaveLength(2);
    const [fila] = await db.select().from(comprobante);
    expect(fila.estado).toBe("pendiente");
    expect(fila.corrigiendoHasta).toBeNull();
  });

  it("responder 'descartar' al resumen lo descarta", async () => {
    leerComprobantes.mockResolvedValue([facturaDePrueba()]);
    await bot.procesar(foto(), origen);
    await bot.terminarCompras();
    await bot.procesar(texto("descartar", respuestas[0].id), origen);
    expect(respuestas.at(-1)!.texto).toContain("descarté");
    const [fila] = await db.select().from(comprobante);
    expect(fila.estado).toBe("descartado");
  });

  it("la charla del grupo de compras no se contesta ni hace recordatorios", async () => {
    await bot.procesar(texto("recordame mañana a las 10 pagar al proveedor"), origen);
    expect(respuestas).toHaveLength(0);
    expect(interpretar).not.toHaveBeenCalled();
  });

  it("por privado, un PDF es un comprobante", async () => {
    leerComprobantes.mockResolvedValue([facturaDePrueba({ archivo: "factura.pdf" })]);
    await bot.procesar({
      key: { id: `D${++n}`, remoteJid: YO },
      message: { documentMessage: { mimetype: "application/pdf", fileName: "factura.pdf", fileLength: 2000 } },
    });
    await bot.terminarCompras();
    const archivos = leerComprobantes.mock.calls[0][1] as { nombre: string; mime: string }[];
    expect(archivos[0]).toMatchObject({ nombre: "factura.pdf", mime: "application/pdf" });
    expect(respuestas[0].texto).toContain("Factura A");
    const [fila] = await db.select().from(comprobante);
    expect(fila.chat).toBeNull();
  });

  it("si falla el ERP queda confirmado con el error, para reintentar", async () => {
    fetchFalso.mockResolvedValue(new Response("caído", { status: 503 }));
    leerComprobantes.mockResolvedValue([facturaDePrueba()]);
    await bot.procesar(foto(), origen);
    await bot.terminarCompras();
    await bot.procesar(voto(encuestas[0].id, "✅ Confirmar"), origen);
    expect(respuestas.at(-1)!.texto).toContain("no lo pude mandar al ERP");
    const [fila] = await db.select().from(comprobante);
    expect(fila.estado).toBe("confirmado");
    expect(fila.envioError).toContain("503");
  });

  it("borra las fotos viejas pero conserva los datos", async () => {
    leerComprobantes.mockResolvedValue([facturaDePrueba()]);
    await bot.procesar(foto(), origen);
    await bot.terminarCompras();
    const [fila] = await db.select().from(comprobante);
    await db.update(comprobante).set({ creadoEn: new Date(Date.now() - 31 * 86_400_000) });
    expect(await limpiarArchivosViejos(30)).toBe(1);
    const c = await obtenerComprobante(fila.id);
    expect(c!.fila.archivosBorrados).toBe(true);
    expect(c!.datos.encabezado.razonSocialEmisor).toBe("Distribuidora del Café SA");
  });
});
