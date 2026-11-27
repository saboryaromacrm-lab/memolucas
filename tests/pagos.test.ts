import type { WAMessage } from "baileys";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import { suscripcion, tarjeta } from "../src/db/schema.js";
import Anthropic from "@anthropic-ai/sdk";
import { ErrorIA, type AnalisisFoto } from "../src/bot/ia.js";
import { Procesador } from "../src/bot/procesador.js";
import { fijarAzar } from "../src/bot/frases.js";
import { abrir } from "../src/lib/cifrado.js";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import {
  actualizarFijo,
  actualizarPagoDelMes,
  borrarFijo,
  borrarLugar,
  borrarPago,
  buscarPendientes,
  crearFijo,
  crearLugar,
  crearSuelto,
  desmarcarPago,
  historialPagos,
  omitirPago,
  registrarPago,
  resumenPagos,
  verMes,
  type EntradaFijo,
} from "../src/servicios/pagos.js";
import { avisarPagos, mensajesDelMesPagos } from "../src/servicios/pagos-avisos.js";
import { crearSuscripcion } from "../src/servicios/suscripciones.js";
import { crearTarjeta, SIN_SALDOS } from "../src/servicios/tarjetas.js";
import { armarFijosConIa } from "../src/bot/ia-pagos.js";
import { baseLimpia, enviadorFalso, panelConSesion, reloj } from "./ayuda.js";

const pedir = vi.fn();
const analizarFoto = vi.fn<(...a: unknown[]) => Promise<AnalisisFoto>>();
vi.mock("../src/bot/ia.js", async (orig) => ({
  ...(await orig<object>()),
  pedir: (...a: unknown[]) => pedir(...a),
  analizarFoto: (...a: unknown[]) => analizarFoto(...a),
}));

const Z = "America/Argentina/Buenos_Aires";
const local = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();
const fijo = (lugarId: number, e: Partial<EntradaFijo>): EntradaFijo => ({
  lugarId,
  nombre: "Pago",
  categoria: "Servicios",
  monto: 0,
  variable: false,
  moneda: "ARS",
  dia: 10,
  frecuencia: "mensual",
  medio: "Transferencia",
  cuenta: "",
  avisoDias: null,
  nota: "",
  ...e,
});
const item = async (periodo: string, nombre: string) => (await verMes(periodo)).items.find((i) => i.nombre === nombre)!;

describe("Pagos", () => {
  let express: number;
  let casa: number;
  let r: ReturnType<typeof reloj>;
  beforeEach(async () => {
    await baseLimpia();
    r = reloj(local("2026-11-26T08:00"));
    pedir.mockReset();
    analizarFoto.mockReset();
    fijarAzar(() => 0);
    express = (await crearLugar({ nombre: "Express 1", tipo: "negocio" })).id;
    casa = (await crearLugar({ nombre: "Casa", tipo: "personal" })).id;
  });
  afterEach(() => vi.useRealTimers());

  it("cada mes se arma solo con lo que toca, desde el primer mes que se abrió", async () => {
    await crearFijo(fijo(express, { nombre: "Alquiler", categoria: "Alquiler", monto: 650000, dia: 5 }));
    await crearFijo(fijo(express, { nombre: "Luz", monto: 70000, variable: true, dia: 15, cuenta: "REFSA 7788-1" }));
    await crearFijo(fijo(casa, { nombre: "ABL", categoria: "Impuestos y tasas", monto: 38000, dia: 31, frecuencia: "bimestral" }));
    const nov = await verMes("2026-11");
    expect(nov.items.map((i) => [i.nombre, i.lugar, i.vence, i.monto, i.estado, i.vencido])).toEqual([
      ["Alquiler", "Express 1", "2026-11-05", 650000, "pendiente", true],
      ["Luz", "Express 1", "2026-11-15", 70000, "pendiente", true],
      ["ABL", "Casa", "2026-11-30", 38000, "pendiente", false],
    ]);
    expect(nov.totales).toMatchObject({ total: { ARS: 758000, USD: 0 }, cantidad: 3, vencidos: 2 });
    expect((await verMes("2026-12")).items.map((i) => i.nombre)).toEqual(["Alquiler", "Luz"]);
    expect((await verMes("2027-01")).items.map((i) => i.nombre)).toEqual(["Alquiler", "Luz", "ABL"]);
    expect((await verMes("2026-10")).items).toEqual([]); // Antes del primer mes, nada inventado.
    // Volver a abrir el mes no repite nada.
    expect((await verMes("2026-11")).items).toHaveLength(3);
  });

  it("pagar de un toque, en partes, desmarcar y no se paga este mes; el variable aprende de lo pagado", async () => {
    await crearFijo(fijo(express, { nombre: "Alquiler", monto: 650000, dia: 5 }));
    await crearFijo(fijo(express, { nombre: "Luz", monto: 70000, variable: true, dia: 15 }));
    const alquiler = await item("2026-11", "Alquiler");
    expect(await registrarPago(alquiler.id)).toMatchObject({ estado: "pagado", pagado: 650000, falta: 0, pagadoEn: "2026-11-26" });
    await expect(registrarPago(alquiler.id)).rejects.toThrow("ya está marcado");
    await desmarcarPago(alquiler.id);
    expect(await registrarPago(alquiler.id, { monto: 300000, medio: "Efectivo" })).toMatchObject({ estado: "parcial", falta: 350000, medio: "Efectivo" });
    expect(await registrarPago(alquiler.id)).toMatchObject({ estado: "pagado", pagado: 650000 });

    const luz = await item("2026-11", "Luz");
    await registrarPago(luz.id, { monto: 96200 });
    expect((await item("2026-12", "Luz")).monto).toBe(96200);

    await omitirPago((await item("2026-12", "Alquiler")).id, true);
    const dic = await verMes("2026-12");
    expect(dic.items.find((i) => i.nombre === "Alquiler")).toMatchObject({ estado: "omitido", falta: 0 });
    expect(dic.totales.total.ARS).toBe(96200);
  });

  it("la boleta cambia el monto y el vencimiento del mes, y avisa si vino mucho más alta", async () => {
    r.ir(local("2026-10-10T08:00"));
    await actualizarConfig({ pagosDesde: "2026-10" });
    await crearFijo(fijo(express, { nombre: "Luz", monto: 70000, variable: true, dia: 15, desde: "2026-10" }));
    await registrarPago((await item("2026-10", "Luz")).id, { monto: 70000 });
    r.ir(local("2026-11-26T08:00"));
    const luz = await actualizarPagoDelMes((await item("2026-11", "Luz")).id, { monto: 96200, vence: "2026-11-28" });
    expect(luz).toMatchObject({ monto: 96200, boleta: 96200, esperado: 70000, vence: "2026-11-28", vencido: false });
    expect((await verMes("2026-11")).alertas).toContain("Luz · Express 1 viene 37 % más que el promedio de los meses anteriores.");
  });

  it("las suscripciones y el resumen de la tarjeta entran solos, y pagarlos los marca allá", async () => {
    const chatgpt = await crearSuscripcion({ nombre: "ChatGPT Plus", url: "", fechaInicio: null, fechaVto: "2026-11-28", monto: 20, moneda: "USD", frecuencia: "mensual", observacion: "" });
    await crearSuscripcion({ nombre: "Netflix", url: "", fechaInicio: null, fechaVto: "2026-12-10", monto: 9999, moneda: "ARS", frecuencia: "mensual", observacion: "" });
    const visa = await crearTarjeta({ ...SIN_SALDOS, nombre: "Visa", ultimos4: "1376", cierre: "2026-11-16", vencimiento: "2026-11-30", saldo: 386540, pagoMinimo: 38654 });
    const nov = await verMes("2026-11");
    expect(nov.items.map((i) => [i.nombre, i.lugar, i.monto, i.moneda, i.estado, i.origen])).toEqual([
      ["Netflix", "Suscripciones", 9999, "ARS", "pagado", "suscripcion"], // El 10/11 ya se renovó (vence el 10/12).
      ["ChatGPT Plus", "Suscripciones", 20, "USD", "pendiente", "suscripcion"],
      ["Visa ···1376", "Tarjetas", 386540, "ARS", "pendiente", "tarjeta"],
    ]);
    await registrarPago(nov.items[1].id);
    expect((await db.select().from(suscripcion).where(eq(suscripcion.id, chatgpt.id)))[0].fechaVto).toBe("2026-12-28");
    await registrarPago(nov.items[2].id, { monto: 100000 });
    const [t] = await db.select().from(tarjeta).where(eq(tarjeta.id, visa.id));
    expect(abrir<{ pagado?: number }>(t.datosCifrados, {}).pagado).toBe(100000);
    expect((await verMes("2026-12")).items.map((i) => [i.nombre, i.vence, i.estado])).toEqual([
      ["Netflix", "2026-12-10", "pendiente"],
      ["ChatGPT Plus", "2026-12-28", "pendiente"],
    ]);
  });

  it("sueltos, cambios en lo fijo y lugares con pagos", async () => {
    const { id } = await crearFijo(fijo(express, { nombre: "Internet", monto: 30000, dia: 12 }));
    const arreglo = await crearSuelto({ nombre: "Arreglo heladera", lugarId: express, categoria: "Otros", monto: 85000, moneda: "ARS", fecha: "2026-11-20", medio: "Efectivo", nota: "", pagado: true });
    expect(arreglo).toMatchObject({ estado: "pagado", origen: "suelto", periodo: "2026-11" });
    await expect(borrarPago((await item("2026-11", "Internet")).id)).rejects.toThrow("No se paga este mes");
    await borrarPago(arreglo.id);

    await actualizarFijo(id, fijo(casa, { nombre: "Internet Fibra", monto: 35000, dia: 20 }));
    expect(await item("2026-11", "Internet Fibra")).toMatchObject({ lugar: "Casa", monto: 35000, vence: "2026-11-20" });
    await expect(borrarLugar(casa)).rejects.toThrow("tiene pagos");

    await registrarPago((await item("2026-11", "Internet Fibra")).id);
    await verMes("2026-12");
    await borrarFijo(id);
    expect((await verMes("2026-11")).items.map((i) => [i.nombre, i.estado])).toEqual([["Internet Fibra", "pagado"]]); // Lo pagado queda.
    expect((await verMes("2026-12")).items).toEqual([]);
  });

  it("buscar lo que dijo por WhatsApp, el historial y el resumen por lugar", async () => {
    await crearFijo(fijo(express, { nombre: "Luz", monto: 70000, dia: 15 }));
    await crearFijo(fijo(casa, { nombre: "Luz", monto: 40000, dia: 15 }));
    await crearFijo(fijo(casa, { nombre: "Gas", monto: 25000, dia: 15 }));
    expect((await buscarPendientes("pagué la luz del express 1")).map((i) => i.lugar)).toEqual(["Express 1"]);
    expect(await buscarPendientes("pagué la luz")).toHaveLength(2);
    await registrarPago((await buscarPendientes("luz express"))[0].id);
    expect((await historialPagos("2026-01", "2026-12", "luz")).total.ARS).toBe(70000);
    const resumen = await resumenPagos("2026-11");
    expect(resumen.mes.porLugar.map((g) => [g.nombre, g.total.ARS, g.pagado.ARS])).toEqual([
      ["Express 1", 70000, 70000],
      ["Casa", 65000, 0],
    ]);
    expect(resumen.mes.porTipo.map((g) => g.nombre)).toEqual(["Negocio", "Personal"]);
    expect(resumen.meses.at(-1)).toMatchObject({ periodo: "2026-11", total: { ARS: 135000 } });
  });

  it("API: el mes, el CSV y los comprobantes (foto o PDF, cifrados)", async () => {
    await crearFijo(fijo(express, { nombre: "Alquiler", monto: 650000, dia: 5 }));
    const { app, headers } = await panelConSesion();
    const mes = (await app.inject({ url: "/api/pagos/mes?periodo=2026-11", headers })).json();
    const id = mes.items[0].id;
    expect((await app.inject({ method: "POST", url: `/api/pagos/${id}/pagar`, headers, payload: {} })).json()).toMatchObject({ estado: "pagado" });
    const foto = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#fff" } }).png().toBuffer();
    expect((await app.inject({ method: "PUT", url: `/api/pagos/${id}/comprobante`, headers: { ...headers, "content-type": "image/png" }, payload: foto })).statusCode).toBe(200);
    const c = await app.inject({ url: `/api/pagos/${id}/comprobante`, headers });
    expect(c.headers["content-type"]).toBe("image/webp");
    expect((await sharp(c.rawPayload).metadata()).width).toBe(1600);
    const pdf = Buffer.from("%PDF-1.4\n%prueba\n");
    await app.inject({ method: "PUT", url: `/api/pagos/${id}/comprobante`, headers: { ...headers, "content-type": "application/pdf" }, payload: pdf });
    expect((await app.inject({ url: `/api/pagos/${id}/comprobante`, headers })).rawPayload).toEqual(pdf);
    const csv = await app.inject({ url: "/api/pagos/exportar?desde=2026-11&hasta=2026-11", headers });
    expect(csv.headers["content-disposition"]).toContain("pagos-2026-11.csv");
    expect(csv.body).toContain("Express 1;Negocio;Servicios;Alquiler;ARS;650000,00;650000,00;Pagado");
    await app.close();
  });

  it("avisa por WhatsApp 3 días antes y el día que vence, todo junto y una sola vez", async () => {
    const wa = enviadorFalso();
    await crearFijo(fijo(express, { nombre: "Luz", monto: 70000, dia: 15 }));
    await crearFijo(fijo(casa, { nombre: "Gas", monto: 25000, dia: 15 }));
    await crearFijo(fijo(casa, { nombre: "Internet", monto: 30000, dia: 15, avisoDias: -1 }));
    r.ir(local("2026-12-12T10:00"));
    await avisarPagos();
    await avisarPagos();
    expect(wa.enviados).toHaveLength(1);
    expect(wa.enviados[0].texto).toContain("🗓️ *Vencen pronto:*\n• Luz · Express 1 — $ 70.000,00 · vence en 3 días");
    expect(wa.enviados[0].texto).not.toContain("Internet");
    r.ir(local("2026-12-15T10:00"));
    await avisarPagos();
    expect(wa.enviados[1].texto).toContain("💸 *Vencen hoy:*\n• Luz · Express 1");
    // Lo del mes que ya venció hace rato (noviembre) no se avisa.
    expect(wa.enviados.map((e) => e.texto).join()).not.toContain("venció ayer");
  });

  it("el día 1: cómo cerró el mes anterior (IA) y lo que viene; a mitad de mes, lo que falta", async () => {
    const wa = enviadorFalso();
    await crearFijo(fijo(express, { nombre: "Alquiler", monto: 650000, dia: 5 }));
    await verMes("2026-11");
    pedir.mockResolvedValue({ vinetas: ["Cerraste noviembre con $ 650.000 sin pagar.", "El alquiler es lo que más pesa."] });
    r.ir(local("2026-12-01T10:00"));
    await mensajesDelMesPagos();
    await mensajesDelMesPagos();
    expect(wa.enviados).toHaveLength(1);
    expect(wa.enviados[0].texto).toContain("🧾 *Cómo cerró noviembre 2026:*\n• Cerraste noviembre con $ 650.000 sin pagar.");
    expect(wa.enviados[0].texto).toContain("📅 *Pagos de diciembre 2026:* 1 por $ 650.000,00");
    expect((await verMes("2026-11")).analisis?.texto).toContain("El alquiler es lo que más pesa.");
    r.ir(local("2026-12-16T10:00"));
    await mensajesDelMesPagos();
    expect(wa.enviados[1].texto).toContain("🧾 *A mitad de mes te falta pagar $ 650.000,00:*");
  });

  it("la IA arma la lista de lo que dictaste: usa tus lugares o propone los nuevos", async () => {
    pedir.mockResolvedValue({
      pagos: [
        // Para un lugar que ya existe la IA deja el tipo vacío, y escribe la moneda y la frecuencia a su manera: no rompe.
        { lugar: "express 1", lugar_nuevo_tipo: "", nombre: "Alquiler", categoria: "Alquiler", monto: 650000, variable: false, moneda: "pesos", dia: 5, frecuencia: "Bimestral", medio: "Transferencia", cuenta: "", nota: "" },
        { lugar: "Fontana", lugar_nuevo_tipo: "negocio", nombre: "Luz", categoria: "Electricidad", monto: 0, variable: true, moneda: "USD", dia: 15, frecuencia: "mensual", medio: "", cuenta: "", nota: "" },
      ],
    });
    const { fijos } = await armarFijosConIa("en el express 1 pago alquiler 650 mil el 5, y en Fontana la luz a mitad de mes");
    expect(fijos.map((f) => [f.lugarId, f.lugarNuevo, f.categoria, f.moneda, f.frecuencia])).toEqual([
      [express, undefined, "Alquiler", "ARS", "bimestral"],
      [null, { nombre: "Fontana", tipo: "negocio" }, "Otros", "USD", "mensual"],
    ]);
  });

  it("si la IA falla al armar la lista, el panel dice por qué (no «Error interno»)", async () => {
    const { app, headers } = await panelConSesion();
    const armar = () => app.inject({ method: "POST", url: "/api/pagos/ia/armar", headers, payload: { texto: "alquiler 650 mil el 5" } });
    pedir.mockRejectedValueOnce(new ErrorIA("401 invalid x-api-key", { cause: Anthropic.APIError.generate(401, { error: { message: "invalid x-api-key" } }, undefined, new Headers()) }));
    let r = await armar();
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toContain("La clave de Claude falta o no funciona");
    pedir.mockRejectedValueOnce(new ErrorIA("La respuesta del modelo quedó cortada"));
    r = await armar();
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe("La IA no pudo responder: La respuesta del modelo quedó cortada");
    await app.close();
  });

  it("WhatsApp: la foto del comprobante se reconoce, se confirma con «sí» y queda con la foto; la de la boleta actualiza el mes", async () => {
    await crearFijo(fijo(casa, { nombre: "ABL", categoria: "Impuestos y tasas", monto: 38400, dia: 30 }));
    await crearFijo(fijo(express, { nombre: "Luz", monto: 70000, variable: true, dia: 28 }));
    const abl = await item("2026-11", "ABL");
    const luz = await item("2026-11", "Luz");
    const respuestas: string[] = [];
    const encuestas: string[] = [];
    let n = 0;
    const bot = new Procesador({
      responder: async (t: string) => (respuestas.push(t), `OUT${++n}`),
      responderImagen: async () => null,
      responderEncuesta: async (nombre: string) => (encuestas.push(nombre), { id: `ENC${++n}`, secreto: "x" }),
      descifrarVoto: () => null,
      descargarMedia: async () => sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).jpeg().toBuffer(),
      reaccionar: async () => {},
    });
    const YO = "5491112345678@s.whatsapp.net";
    const foto = (): WAMessage => ({ key: { id: `F${++n}`, remoteJid: YO }, message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000 } } });
    const texto = (t: string): WAMessage => ({ key: { id: `T${++n}`, remoteJid: YO }, message: { conversation: t } });
    const analisis = (a: Partial<AnalisisFoto>): AnalisisFoto => ({
      tipo: "comprobante",
      descripcion: "Transferencia",
      util: false,
      titulo: null,
      fecha_evento: null,
      monto: null,
      lugar: null,
      propuesta_fecha_hora: null,
      propuesta_avisos_previos_min: [],
      mensaje: "",
      texto_visible: null,
      monto_numero: 0,
      pago_id: 0,
      ...a,
    });

    analizarFoto.mockResolvedValue(analisis({ monto_numero: 38400, fecha_evento: "2026-11-26T10:00:00-03:00", pago_id: abl.id }));
    await bot.procesar(foto());
    expect(analizarFoto.mock.calls[0][4]).toContain(`${abl.id} | ABL · Casa`);
    expect(encuestas).toEqual(["🧾 Veo un pago de $ 38.400,00 del 26/11. ¿Es ABL · Casa ($ 38.400,00)?"]);
    await bot.procesar(texto("sí"));
    expect(respuestas.at(-1)).toBe("✅ Anotado: *ABL · Casa* $ 38.400,00, con el comprobante.\nTe falta: Luz · Express 1.");
    expect(await item("2026-11", "ABL")).toMatchObject({ estado: "pagado", comprobante: "image/webp", pagadoEn: "2026-11-26" });

    analizarFoto.mockResolvedValue(analisis({ tipo: "factura", monto_numero: 96200, fecha_evento: "2026-11-29T00:00:00-03:00", pago_id: luz.id }));
    await bot.procesar(foto());
    expect(respuestas.at(-1)).toBe("📄 Anoté la boleta de *Luz · Express 1*: $ 96.200,00, vence en 3 días (dom 29/11). Te aviso antes.");

    // Un comprobante que no sabe de cuál es: pregunta, y con lo que le dice lo encuentra.
    analizarFoto.mockResolvedValue(analisis({ monto_numero: 96200 }));
    await bot.procesar(foto());
    expect(respuestas.at(-1)).toBe("🧾 Veo un pago de $ 96.200,00. ¿De cuál de tus pagos es? Decime, por ejemplo, «es la luz del Express 1».");
    await bot.procesar(texto("es la luz del express"));
    expect(respuestas.at(-1)).toBe("✅ Anotado: *Luz · Express 1* $ 96.200,00, con el comprobante.\nYa pagaste todo lo del mes 🙌");
  });
});
