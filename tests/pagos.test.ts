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
  corregirPago,
  crearFijo,
  crearLugar,
  crearSuelto,
  desmarcarPago,
  historialPagos,
  listarFijos,
  omitirPago,
  registrarPago,
  resumenPagos,
  verMes,
  type EntradaFijo,
} from "../src/servicios/pagos.js";
import { avisarPagos, mensajesDelMesPagos } from "../src/servicios/pagos-avisos.js";
import { borrarForma, crearForma, listarFormas } from "../src/servicios/pagos-formas.js";
import { borrarCategoria, crearCategoria, listarCategorias, renombrarCategoria } from "../src/servicios/pagos-categorias.js";
import { borrarPersona, crearPersona, listarCuentas, pagarAPersona } from "../src/servicios/pagos-cuentas.js";
import { crearSuscripcion, pagarSuscripcionCon } from "../src/servicios/suscripciones.js";
import { actualizarTarjeta, borrarTarjeta, crearTarjeta, SIN_SALDOS } from "../src/servicios/tarjetas.js";
import { armarFijosConIa, cargarMesConIa } from "../src/bot/ia-pagos.js";
import { baseLimpia, enviadorFalso, panelConSesion, reloj } from "./ayuda.js";

const pedir = vi.fn();
const analizarFoto = vi.fn<(...a: unknown[]) => Promise<AnalisisFoto>>();
vi.mock("../src/bot/ia.js", async (orig) => ({
  ...(await orig<object>()),
  pedir: (...a: unknown[]) => pedir(...a),
  analizarFoto: (...a: unknown[]) => analizarFoto(...a),
}));

const Z = "America/Argentina/Buenos_Aires";
/** Las formas de pago de las pruebas (se crean en cada una). */
let transferencia: number;
let efectivo: number;
const local = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();
const fijo = (lugarId: number, e: Partial<EntradaFijo>): EntradaFijo => ({
  alcance: "lugar",
  lugarId,
  tipo: null,
  reparto: null,
  nombre: "Pago",
  categoria: "Servicios",
  monto: 0,
  variable: false,
  moneda: "ARS",
  dia: 10,
  frecuencia: "mensual",
  formaId: transferencia,
  desfase: 0,
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
    for (const c of ["Alquiler", "Servicios", "Impuestos y tasas", "Sueldos y cargas", "Honorarios", "Préstamos y cuotas", "Otros"]) await crearCategoria(c);
    transferencia = (await crearForma({ nombre: "Transferencia", tipo: "transferencia" })).id;
    efectivo = (await crearForma({ nombre: "Efectivo", tipo: "efectivo" })).id;
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
    expect(await registrarPago(alquiler.id, { monto: 300000, formaId: efectivo })).toMatchObject({ estado: "parcial", falta: 350000, forma: "Efectivo" });
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
      ["Netflix", "General", 9999, "ARS", "pagado", "suscripcion"], // El 10/11 ya se renovó (vence el 10/12).
      ["ChatGPT Plus", "General", 20, "USD", "pendiente", "suscripcion"],
      ["Visa ···1376", "General", 386540, "ARS", "pendiente", "tarjeta"],
    ]);
    await registrarPago(nov.items[1].id, { formaId: efectivo });
    expect((await db.select().from(suscripcion).where(eq(suscripcion.id, chatgpt.id)))[0].fechaVto).toBe("2026-12-28");
    await registrarPago(nov.items[2].id, { monto: 100000, formaId: transferencia });
    const [t] = await db.select().from(tarjeta).where(eq(tarjeta.id, visa.id));
    expect(abrir<{ pagado?: number }>(t.datosCifrados, {}).pagado).toBe(100000);
    expect((await verMes("2026-12")).items.map((i) => [i.nombre, i.vence, i.estado])).toEqual([
      ["Netflix", "2026-12-10", "pendiente"],
      ["ChatGPT Plus", "2026-12-28", "pendiente"],
    ]);
  });

  it("sueltos, cambios en lo fijo y lugares con pagos", async () => {
    const { id } = await crearFijo(fijo(express, { nombre: "Internet", monto: 30000, dia: 12 }));
    const arreglo = await crearSuelto({ nombre: "Arreglo heladera", lugarId: express, categoria: "Otros", monto: 85000, moneda: "ARS", fecha: "2026-11-20", formaId: efectivo, nota: "", pagado: true });
    expect(arreglo).toMatchObject({ estado: "pagado", origen: "suelto", periodo: "2026-11" });
    await expect(borrarPago((await item("2026-11", "Internet")).id)).rejects.toThrow("No se paga este mes");
    await borrarPago(arreglo.id);

    await actualizarFijo(id, fijo(casa, { nombre: "Internet Fibra", monto: 35000, dia: 20 }));
    expect(await item("2026-11", "Internet Fibra")).toMatchObject({ lugar: "Casa", monto: 35000, vence: "2026-11-20" });
    await expect(borrarLugar(casa)).rejects.toThrow("tiene pagos");

    await registrarPago((await item("2026-11", "Internet Fibra")).id, { formaId: transferencia });
    await verMes("2026-12");
    await borrarFijo(id);
    expect((await verMes("2026-11")).items.map((i) => [i.nombre, i.estado])).toEqual([["Internet Fibra", "pagado"]]); // Lo pagado queda.
    expect((await verMes("2026-12")).items).toEqual([]);
  });

  it("repartido entre locales y general: una vez en el mes, cada local con su parte en el resumen y en el CSV", async () => {
    const fontana = (await crearLugar({ nombre: "Fontana", tipo: "negocio" })).id;
    const reparto = [express, fontana].map((lugarId) => ({ lugarId, porcentaje: null }));
    await crearFijo({ ...fijo(express, { nombre: "Contador", categoria: "Honorarios", monto: 85000, dia: 10 }), alcance: "repartido", lugarId: null, reparto });
    await crearFijo({ ...fijo(express, { nombre: "Cuota Fiat", categoria: "Préstamos y cuotas", monto: 300000, dia: 15 }), alcance: "general", lugarId: null, tipo: "personal" });
    await expect(crearFijo({ ...fijo(express, { nombre: "Abogado" }), alcance: "repartido", reparto: [reparto[0]] })).rejects.toThrow("al menos 2");
    const mes = await verMes("2026-11");
    expect(mes.items.map((i) => [i.nombre, i.lugar, i.tipo, i.monto])).toEqual([
      ["Contador", "Repartido · 2 locales", "negocio", 85000],
      ["Cuota Fiat", "General", "personal", 300000],
    ]);
    expect(mes.items[0].partes.map((p) => [p.lugar, p.monto])).toEqual([
      ["Express 1", 42500],
      ["Fontana", 42500],
    ]);
    const resumen = await resumenPagos("2026-11");
    expect(resumen.mes.porLugar.map((g) => [g.nombre, g.total.ARS])).toEqual([
      ["General", 300000],
      ["Express 1", 42500],
      ["Fontana", 42500],
    ]);
    expect(resumen.mes.porTipo.map((g) => [g.nombre, g.total.ARS])).toEqual([
      ["Personal", 300000],
      ["Negocio", 85000],
    ]);
    const { app, headers } = await panelConSesion();
    const csv = (await app.inject({ url: "/api/pagos/exportar?desde=2026-11&hasta=2026-11", headers })).body;
    expect(csv).toContain("Express 1;Negocio;Honorarios;Contador;ARS;42500,00;0,00;Pendiente;;;50 % de $ 85.000,00 repartido;");
    expect(csv).toContain("Fontana;Negocio;Honorarios;Contador;ARS;42500,00");
    expect(csv).toContain("General;Personal;Préstamos y cuotas;Cuota Fiat;ARS;300000,00");
    await app.close();
    await expect(borrarLugar(fontana)).rejects.toThrow("tiene pagos");
    expect((await buscarPendientes("contador fontana")).map((i) => i.nombre)).toEqual(["Contador"]);
  });

  it("sin vencimiento: va al final de lo que falta, nunca queda vencido ni se avisa antes, y sí entra en lo que falta del mes", async () => {
    const wa = enviadorFalso();
    await crearFijo(fijo(express, { nombre: "Luz", monto: 70000, dia: 28 }));
    await crearFijo(fijo(casa, { nombre: "Ayuda a mamá", categoria: "Otros", monto: 50000, dia: null }));
    const mes = await verMes("2026-11");
    expect(mes.items.map((i) => [i.nombre, i.vence, i.vencido])).toEqual([
      ["Luz", "2026-11-28", false],
      ["Ayuda a mamá", null, false],
    ]);
    r.ir(local("2026-12-25T10:00"));
    expect((await verMes("2026-12")).totales.vencidos).toBe(0);
    await avisarPagos();
    expect(wa.enviados.map((e) => e.texto).join()).not.toContain("Ayuda a mamá");
    r.ir(local("2026-12-16T10:00"));
    await mensajesDelMesPagos();
    expect(wa.enviados.at(-1)?.texto).toContain("• Ayuda a mamá · Casa — $ 50.000,00 · sin vencimiento");
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
    // Sin la forma de pago no se marca.
    expect((await app.inject({ method: "POST", url: `/api/pagos/${id}/pagar`, headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/pagos/${id}/pagar`, headers, payload: { formaId: transferencia } })).json()).toMatchObject({ estado: "pagado", forma: "Transferencia" });
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
      cambios: [],
      borrar: [],
      mensaje: "",
      nuevos: [
        // Para un lugar que ya existe la IA deja el tipo vacío, y escribe la moneda y la frecuencia a su manera: no rompe.
        { alcance: "lugar", lugar: "express 1", tipo: "", repartir_entre: [], nombre: "Alquiler", categoria: "Alquiler", monto: 650000, variable: false, moneda: "pesos", dia: 5, frecuencia: "Bimestral", forma: "transferencia", cuenta: "", nota: "", como_figura: "" },
        { alcance: "lugar", lugar: "Fontana", tipo: "negocio", repartir_entre: [], nombre: "Luz", categoria: "Electricidad", monto: 0, variable: true, moneda: "USD", dia: 15, frecuencia: "mensual", forma: "", cuenta: "", nota: "", como_figura: "" },
        { alcance: "repartido", lugar: "", tipo: "", repartir_entre: [], nombre: "Contador", categoria: "Honorarios", monto: 85000, variable: false, moneda: "ARS", dia: 10, frecuencia: "mensual", forma: "", cuenta: "", nota: "", como_figura: "" },
        { alcance: "general", lugar: "", tipo: "personal", repartir_entre: [], nombre: "Cuota Fiat", categoria: "Préstamos y cuotas", monto: 300000, variable: false, moneda: "ARS", dia: 0, frecuencia: "mensual", forma: "", cuenta: "", nota: "", como_figura: "" },
      ],
    });
    const { nuevos: fijos } = await armarFijosConIa("en el express 1 pago alquiler 650 mil el 5, y en Fontana la luz a mitad de mes");
    expect(fijos.map((f) => [f.alcance, f.lugarId, f.lugarNuevo, f.categoria, f.moneda, f.frecuencia])).toEqual([
      ["lugar", express, undefined, "Alquiler", "ARS", "bimestral"],
      ["lugar", null, { nombre: "Fontana", tipo: "negocio" }, "Otros", "USD", "mensual"],
      ["general", null, undefined, "Honorarios", "ARS", "mensual"], // Un solo negocio: repartido no tiene sentido, queda general · negocio.
      ["general", null, undefined, "Préstamos y cuotas", "ARS", "mensual"],
    ]);
    expect(fijos.map((f) => f.tipo)).toEqual([null, null, "negocio", "personal"]);
    expect(fijos.map((f) => f.dia)).toEqual([5, 15, 10, null]); // Sin día dicho: sin vencimiento.
  });

  it("la IA también cambia y borra lo que ya está cargado; se revisa y se aplica todo junto", async () => {
    const alquiler = (await crearFijo(fijo(express, { nombre: "Alquiler", monto: 650000, dia: 5, nota: "Contrato hasta 2027" }))).id;
    const abl = (await crearFijo(fijo(casa, { nombre: "ABL", categoria: "Impuestos y tasas", monto: 38400, dia: 20 }))).id;
    const gym = (await crearFijo(fijo(casa, { nombre: "Gimnasio", monto: 25000, dia: 1 }))).id;
    pedir.mockResolvedValue({
      nuevos: [],
      cambios: [
        { id: alquiler, campo: "vence", valor: "0" },
        { id: alquiler, campo: "monto", valor: "$ 850.000" }, // Escrito a la argentina.
        { id: alquiler, campo: "nota", valor: "Contrato hasta 2027" }, // Mismo valor: no es un cambio.
        { id: abl, campo: "vence", valor: "0" },
        { id: abl, campo: "alcance", valor: "lugar: Fontana" },
        { id: abl, campo: "aviso", valor: "no" },
        { id: gym, campo: "Vence", valor: "15" }, // También pidió borrarlo: gana el borrado solo si no lo cambia.
        { id: 999, campo: "vence", valor: "0" }, // No existe: se ignora.
        { id: abl, campo: "frecuencia", valor: "cada tanto" }, // No se entiende: se ignora.
      ],
      borrar: [gym, 999],
      mensaje: "",
    });
    const r1 = await armarFijosConIa("sacale el vencimiento a todo, el alquiler subió a 850 mil, el ABL pasalo a Fontana sin aviso");
    expect(r1.cambios.map((c) => [c.id, c.campos])).toEqual([
      [alquiler, ["monto", "vence"]],
      [abl, ["alcance", "vence", "aviso"]],
      [gym, ["vence"]],
    ]);
    expect(r1.borrar).toEqual([]);
    const cambioAbl = r1.cambios[1].despues;
    expect([cambioAbl.dia, cambioAbl.avisoDias, cambioAbl.lugarNuevo, cambioAbl.frecuencia]).toEqual([null, -1, { nombre: "Fontana", tipo: "negocio" }, "mensual"]);

    // Sin cambios que tengan sentido: en lugar de una lista vacía, dice por qué.
    pedir.mockResolvedValue({ nuevos: [], cambios: [], borrar: [], mensaje: "" });
    expect((await armarFijosConIa("hola")).mensaje).toContain("No encontré nada para agregar, cambiar ni borrar");

    // Se aplica por el panel: el cambio llega al pago de este mes y el borrado se lleva sus pendientes.
    const { app, headers } = await panelConSesion();
    const aplicar = (payload: object) => app.inject({ method: "POST", url: "/api/pagos/fijos/aplicar", headers, payload });
    const res = await aplicar({ nuevos: [], cambios: r1.cambios.slice(0, 2).map((c) => ({ id: c.id, ...c.despues })), borrar: [gym] });
    expect(res.json()).toEqual({ creados: 0, cambiados: 2, borrados: 1 });
    const mes = await verMes("2026-11");
    expect(mes.items.map((i) => [i.nombre, i.lugar, i.vence, i.monto])).toEqual(
      expect.arrayContaining([
        ["Alquiler", "Express 1", null, 850000],
        ["ABL", "Fontana", null, 38400],
      ]),
    );
    expect(mes.items.some((i) => i.nombre === "Gimnasio")).toBe(false);
    // Algo que ya no existe frena todo antes de tocar nada.
    const mal = await aplicar({ nuevos: [fijo(casa, { nombre: "Gas" })], cambios: [], borrar: [gym] });
    expect(mal.statusCode).toBe(400);
    expect((await verMes("2026-11")).items.some((i) => i.nombre === "Gas")).toBe(false);
    await app.close();
  });

  it("la IA lee el resumen de la contadora (foto o PDF): montos del mes, pagos nuevos y control del total", async () => {
    await actualizarConfig({ pagosNotasIa: "Coffit es otro negocio." });
    const coffit = (await crearLugar({ nombre: "Coffit", tipo: "negocio" })).id;
    await crearFijo(fijo(coffit, { nombre: "F-931", categoria: "Sueldos y cargas", monto: 450000, variable: true }));
    await crearFijo(fijo(coffit, { nombre: "IPS", categoria: "Sueldos y cargas", monto: 26930, variable: true }));
    const f931 = await item("2026-11", "F-931");
    const ips = await item("2026-11", "IPS");
    pedir.mockResolvedValue({
      montos: [
        { id: f931.id, monto: 493430, como_figura: "F-931" },
        { id: ips.id, monto: 26930, como_figura: "IPS" }, // Mismo monto: igual se muestra (cuenta para el total).
        { id: f931.id, monto: 1, como_figura: "F-931" }, // Repetido: se toma el primero.
        { id: 999, monto: 5, como_figura: "?" }, // No existe: se ignora.
      ],
      nuevos: [
        { alcance: "lugar", lugar: "Coffit", tipo: "negocio", repartir_entre: [], nombre: "UTHGRA", categoria: "Sueldos y cargas", monto: 35412, variable: true, moneda: "ARS", dia: 0, frecuencia: "mensual", forma: "", cuenta: "", nota: "", como_figura: "UTHGRA" },
      ],
      total: 556000,
      mensaje: "",
    });
    const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#fff" } }).png().toBuffer();
    const r = await cargarMesConIa("2026-11", "", { mime: "image/png", datos: png });
    // A la IA le llega la imagen achicada, los pagos del mes con su id y lo que te dijo de tus negocios.
    const [, , system, mensajes] = pedir.mock.calls[0];
    expect(mensajes[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/webp" } });
    expect(system).toContain(`#${f931.id} | F-931 · Coffit | 450000 ARS | pendiente`);
    expect(system).toContain("Coffit es otro negocio.");
    const fijoF931 = (await listarFijos()).find((f) => f.nombre === "F-931")!.id;
    expect(r.montos).toEqual([
      { fijoId: fijoF931, monto: 493430, antes: 450000, nombre: "F-931", lugar: "Coffit", pagado: false, original: "F-931" },
      expect.objectContaining({ monto: 26930, antes: 26930, original: "IPS" }),
    ]);
    expect(r.nuevos.map((n) => [n.nombre, n.lugarId, n.monto, n.variable, n.dia, n.original])).toEqual([["UTHGRA", coffit, 35412, true, null, "UTHGRA"]]);
    expect(r.totalImagen).toBe(556000);

    // Se aplica: el monto va al pago del mes y lo nuevo queda como fijo desde ese mes.
    const { app, headers } = await panelConSesion();
    const res = await app.inject({ method: "POST", url: "/api/pagos/mes/aplicar", headers, payload: { periodo: "2026-11", montos: [{ fijoId: fijoF931, monto: 493430 }], nuevos: r.nuevos } });
    expect(res.json()).toEqual({ cambiados: 1, creados: 1 });
    expect(await item("2026-11", "F-931")).toMatchObject({ monto: 493430, boleta: 493430 });
    expect(await item("2026-11", "UTHGRA")).toMatchObject({ monto: 35412, lugar: "Coffit", vence: null });
    expect((await item("2026-12", "UTHGRA")).monto).toBe(35412);
    // Con el mes cambiado en la revisión, el monto va al pago de ese concepto en ese mes.
    await app.inject({ method: "POST", url: "/api/pagos/mes/aplicar", headers, payload: { periodo: "2026-12", montos: [{ fijoId: fijoF931, monto: 510000 }], nuevos: [] } });
    expect((await item("2026-12", "F-931")).monto).toBe(510000);
    expect((await item("2026-11", "F-931")).monto).toBe(493430);
    // Un pago puntual de otro mes no se puede: avisa en vez de cargarlo mal.
    const otro = await app.inject({ method: "POST", url: "/api/pagos/mes/aplicar", headers, payload: { periodo: "2026-12", montos: [{ itemId: f931.id, monto: 1 }], nuevos: [] } });
    expect(otro.json().error).toContain("no está en diciembre 2026");
    // Sin texto ni archivo no se puede; un PDF falso tampoco.
    expect((await app.inject({ method: "POST", url: "/api/pagos/ia/mes", headers, payload: { periodo: "2026-11", texto: "" } })).statusCode).toBe(400);
    const pdf = await app.inject({ method: "POST", url: "/api/pagos/ia/mes", headers, payload: { periodo: "2026-11", archivo: { mime: "application/pdf", base64: Buffer.from("hola").toString("base64") } } });
    expect(pdf.json().error).toBe("Ese archivo no es un PDF.");
    await app.close();
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

  it("formas de pago: las tarjetas aparecen solas, lo usado se archiva y el historial lo sigue nombrando", async () => {
    await expect(crearForma({ nombre: " transferencia ", tipo: "otro" })).rejects.toThrow("Ya tenés «Transferencia».");
    const visa = await crearTarjeta({ ...SIN_SALDOS, nombre: "Visa Galicia", ultimos4: "1376", cierre: null, vencimiento: null });
    expect((await listarFormas()).map((f) => [f.nombre, f.tipo])).toEqual([
      ["Transferencia", "transferencia"],
      ["Efectivo", "efectivo"],
      ["Visa Galicia ···1376", "credito"],
    ]);
    await actualizarTarjeta(visa.id, { ...SIN_SALDOS, nombre: "Visa Gold", ultimos4: "1376", cierre: null, vencimiento: null });
    expect((await listarFormas()).at(-1)?.nombre).toBe("Visa Gold ···1376");

    // Pagada con efectivo y después se borra la forma: queda archivada y el pago la sigue mostrando.
    const gym = await crearFijo(fijo(casa, { nombre: "Gimnasio", monto: 25000, formaId: efectivo }));
    await registrarPago((await item("2026-11", "Gimnasio")).id);
    await borrarForma(efectivo);
    expect((await listarFormas()).find((f) => f.id === efectivo)?.archivada).toBe(true);
    expect(await item("2026-11", "Gimnasio")).toMatchObject({ estado: "pagado", forma: "Efectivo" });
    expect((await listarFijos()).find((f) => f.id === gym.id)?.formaId).toBeNull();
    await expect(registrarPago((await crearSuelto({ nombre: "Café", lugarId: null, categoria: "Otros", monto: 100, moneda: "ARS", fecha: "2026-11-26", formaId: null, nota: "", pagado: false })).id, { formaId: efectivo })).rejects.toThrow("Esa forma de pago ya no está");
    // Una que nunca se usó se borra del todo; la de una tarjeta borrada queda archivada.
    const mp = await crearForma({ nombre: "Mercado Pago", tipo: "billetera" });
    await borrarForma(mp.id);
    await borrarTarjeta(visa.id);
    expect((await listarFormas()).map((f) => [f.nombre, f.archivada])).toEqual([
      ["Transferencia", false],
      ["Efectivo", true],
      ["Visa Gold ···1376", true],
    ]);
  });

  it("formas de pago: se sugiere la del fijo o la última usada, se corrige un pago hecho y el resumen las suma", async () => {
    const luz = await crearFijo(fijo(express, { nombre: "Luz", monto: 70000, formaId: null }));
    const nov = await item("2026-11", "Luz");
    expect(nov.formaId).toBeNull();
    await expect(registrarPago(nov.id)).rejects.toThrow("Falta con qué lo pagaste.");
    await registrarPago(nov.id, { formaId: efectivo, fecha: "2026-11-20" });
    // El mes que viene aparece marcada la última que usaste.
    expect((await item("2026-12", "Luz")).formaId).toBe(efectivo);
    // Si el fijo tiene una de siempre, gana esa (también en los meses ya armados sin pagar).
    await actualizarFijo(luz.id, fijo(express, { nombre: "Luz", monto: 70000, formaId: transferencia }));
    expect((await item("2026-12", "Luz")).formaId).toBe(transferencia);

    // La suscripción que se paga con una tarjeta sugiere esa tarjeta.
    const visa = await crearTarjeta({ ...SIN_SALDOS, nombre: "Visa", ultimos4: "", cierre: null, vencimiento: null });
    const formaVisa = (await listarFormas()).find((f) => f.tarjetaId === visa.id)!.id;
    const netflix = await crearSuscripcion({ nombre: "Netflix", url: "", fechaInicio: null, fechaVto: "2026-12-10", monto: 9999, moneda: "ARS", frecuencia: "mensual", observacion: "" });
    await pagarSuscripcionCon(netflix.id, visa.id);
    expect((await item("2026-12", "Netflix")).formaId).toBe(formaVisa);

    // Lo asentaste mal: se corrige forma, fecha y monto sin desmarcarlo (con menos, queda en parte).
    expect(await corregirPago(nov.id, { monto: 50000, fecha: "2026-11-18", formaId: transferencia })).toMatchObject({ estado: "parcial", pagado: 50000, pagadoEn: "2026-11-18", forma: "Transferencia" });
    await expect(corregirPago((await item("2026-12", "Luz")).id, { monto: 1, fecha: "2026-12-01", formaId: efectivo })).rejects.toThrow("todavía no está pagado");

    // Un pago suelto ya pagado necesita la forma.
    await expect(crearSuelto({ nombre: "Arreglo", lugarId: null, categoria: "Otros", monto: 8000, moneda: "ARS", fecha: "2026-11-21", formaId: null, nota: "", pagado: true })).rejects.toThrow("Falta con qué lo pagaste.");
    await crearSuelto({ nombre: "Arreglo", lugarId: null, categoria: "Otros", monto: 8000, moneda: "ARS", fecha: "2026-11-21", formaId: efectivo, nota: "", pagado: true });
    expect((await resumenPagos("2026-11")).mes.porForma.map((g) => [g.nombre, g.total.ARS])).toEqual([
      ["Transferencia", 50000],
      ["Efectivo", 8000],
    ]);
  });

  it("el estimado de un variable es el promedio de lo pagado; sin pagos, el monto aproximado", async () => {
    const luz = (await crearFijo(fijo(express, { nombre: "Luz", monto: 50000, variable: true }))).id;
    const alquiler = (await crearFijo(fijo(express, { nombre: "Alquiler", monto: 650000 }))).id;
    const estimado = async (id: number) => (await listarFijos()).find((f) => f.id === id)!.estimado;
    expect(await estimado(luz)).toBe(50000);
    await registrarPago((await item("2026-11", "Luz")).id, { monto: 70000 });
    await registrarPago((await item("2026-12", "Luz")).id, { monto: 90000 });
    expect(await estimado(luz)).toBe(80000);
    expect(await estimado(alquiler)).toBe(650000);
  });

  it("categorías: la lista es tuya; renombrar cambia todos los pagos y borrar pide a cuál pasarlos", async () => {
    const alquiler = (await listarCategorias()).find((c) => c.nombre === "Alquiler")!;
    await crearFijo(fijo(express, { nombre: "Alquiler local", categoria: "Alquiler", monto: 650000 }));
    await crearFijo(fijo(casa, { nombre: "Alquiler casa", categoria: "alquiler", monto: 400000 })); // Se escribe distinto: es la misma.
    await verMes("2026-11");
    // Una que no estaba se suma sola a la lista.
    await crearFijo(fijo(casa, { nombre: "Jardinero", categoria: "Mantenimiento", monto: 30000 }));
    expect((await listarCategorias()).map((c) => c.nombre)).toContain("Mantenimiento");
    await expect(crearCategoria(" ALQUILER ")).rejects.toThrow("Ya tenés la categoría «Alquiler».");

    await renombrarCategoria(alquiler.id, "Alquileres");
    expect((await verMes("2026-11")).items.filter((i) => i.categoria === "Alquileres").map((i) => i.nombre).sort()).toEqual(["Alquiler casa", "Alquiler local"]);
    expect((await listarCategorias()).find((c) => c.id === alquiler.id)).toMatchObject({ nombre: "Alquileres", fijos: 2, usos: 4 });

    const mantenimiento = (await listarCategorias()).find((c) => c.nombre === "Mantenimiento")!;
    await expect(borrarCategoria(mantenimiento.id)).rejects.toThrow("tiene pagos: elegí a qué categoría pasarlos");
    const otros = (await listarCategorias()).find((c) => c.nombre === "Otros")!;
    await borrarCategoria(mantenimiento.id, otros.id);
    expect((await item("2026-11", "Jardinero")).categoria).toBe("Otros");
    expect((await listarCategorias()).some((c) => c.nombre === "Mantenimiento")).toBe(false);
  });

  it("cuentas con personas: lo que pagó la contadora es gasto una vez y se debe; lo que le pagás baja la deuda", async () => {
    const contadora = await crearPersona({ nombre: "Contadora", saldoInicial: 20000 });
    await expect(crearPersona({ nombre: " contadora ", saldoInicial: 0 })).rejects.toThrow("Ya tenés la cuenta de «Contadora».");
    const pagoElla = (await listarFormas()).find((f) => f.personaId === contadora.id)!;
    expect([pagoElla.nombre, pagoElla.tipo]).toEqual(["Lo pagó: Contadora", "tercero"]);
    await expect(borrarForma(pagoElla.id)).rejects.toThrow("se saca borrando la persona");

    await crearFijo(fijo(express, { nombre: "F-931", monto: 493430 }));
    await crearFijo(fijo(express, { nombre: "IPS", monto: 26930 }));
    // El F-931 lo pagó ella entero; el IPS, una parte ella y el resto vos.
    await registrarPago((await item("2026-11", "F-931")).id, { formaId: pagoElla.id, fecha: "2026-11-10" });
    await registrarPago((await item("2026-11", "IPS")).id, { monto: 10000, formaId: pagoElla.id, fecha: "2026-11-11" });
    await registrarPago((await item("2026-11", "IPS")).id, { formaId: efectivo, fecha: "2026-11-12" });
    // Le pagaste 300 mil por transferencia: no con «Lo pagó: …».
    await expect(pagarAPersona(contadora.id, { monto: 1, fecha: "2026-11-20", formaId: pagoElla.id, nota: "" })).rejects.toThrow("Elegí con qué le pagaste vos");
    await pagarAPersona(contadora.id, { monto: 300000, fecha: "2026-11-20", formaId: transferencia, nota: "a cuenta" });

    const [c] = (await listarCuentas()).filter((x) => x.id === contadora.id);
    expect(c.saldo).toBe(20000 + 493430 + 10000 - 300000);
    expect(c.movimientos.map((m) => [m.tipo, m.fecha, m.monto])).toEqual([
      ["lePagaste", "2026-11-20", 300000],
      ["pago", "2026-11-11", 10000],
      ["pago", "2026-11-10", 493430],
    ]);
    // El gasto del mes no cambia por lo que le pagaste a ella.
    expect((await verMes("2026-11")).totales.pagado.ARS).toBe(493430 + 26930);
    expect((await resumenPagos("2026-11")).mes.porForma.find((g) => g.nombre === "Lo pagó: Contadora")?.total.ARS).toBe(503430);
    await expect(borrarPersona(contadora.id)).rejects.toThrow("tiene movimientos");

    // El día 1 te recuerda lo que le debés.
    const wa = enviadorFalso();
    r.ir(local("2026-12-01T10:00"));
    pedir.mockResolvedValue({ vinetas: ["Bien."] });
    await mensajesDelMesPagos();
    expect(wa.enviados[0].texto).toContain("🤝 Le debés a Contadora $ 223.430,00.");
  });

  it("cargar el mes con la IA: lo que ya pagó la contadora queda pagado por ella", async () => {
    const contadora = await crearPersona({ nombre: "Contadora", saldoInicial: 0 });
    const pagoElla = (await listarFormas()).find((f) => f.personaId === contadora.id)!.id;
    const f931 = (await crearFijo(fijo(express, { nombre: "F-931", monto: 450000, variable: true }))).id;
    const { app, headers } = await panelConSesion();
    const res = await app.inject({
      method: "POST",
      url: "/api/pagos/mes/aplicar",
      headers,
      payload: { periodo: "2026-11", montos: [{ fijoId: f931, monto: 493430, pagadoCon: pagoElla }], nuevos: [{ ...fijo(express, { nombre: "UTHGRA", monto: 35412, variable: true }), pagadoCon: pagoElla }] },
    });
    expect(res.statusCode).toBe(200);
    expect(await item("2026-11", "F-931")).toMatchObject({ estado: "pagado", pagado: 493430, forma: "Lo pagó: Contadora" });
    expect(await item("2026-11", "UTHGRA")).toMatchObject({ estado: "pagado", pagado: 35412, forma: "Lo pagó: Contadora" });
    expect((await listarCuentas()).find((c) => c.id === contadora.id)?.saldo).toBe(493430 + 35412);
    await app.close();
  });

  it("WhatsApp: si no se sabe con qué se pagó, lo pregunta con una encuesta y lo anota con lo que contesta", async () => {
    await crearFijo(fijo(casa, { nombre: "ABL", categoria: "Impuestos y tasas", monto: 38400, dia: 30, formaId: null }));
    const abl = await item("2026-11", "ABL");
    const respuestas: string[] = [];
    const encuestas: [string, string[]][] = [];
    let n = 0;
    const bot = new Procesador({
      responder: async (t: string) => (respuestas.push(t), `OUT${++n}`),
      responderImagen: async () => null,
      responderEncuesta: async (nombre: string, opciones: string[]) => (encuestas.push([nombre, opciones]), { id: `ENC${++n}`, secreto: "x" }),
      descifrarVoto: () => null,
      descargarMedia: async () => sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).jpeg().toBuffer(),
      reaccionar: async () => {},
    });
    const YO = "5491112345678@s.whatsapp.net";
    analizarFoto.mockResolvedValue({ tipo: "comprobante", descripcion: "", util: false, titulo: null, fecha_evento: null, monto: null, lugar: null, propuesta_fecha_hora: null, propuesta_avisos_previos_min: [], mensaje: "", texto_visible: null, monto_numero: 38400, pago_id: abl.id });
    await bot.procesar({ key: { id: "F1", remoteJid: YO }, message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000 } } });
    await bot.procesar({ key: { id: "T1", remoteJid: YO }, message: { conversation: "sí" } });
    expect(encuestas.at(-1)).toEqual(["💳 ¿Con qué pagaste ABL · Casa?", ["Transferencia", "Efectivo"]]);
    expect((await item("2026-11", "ABL")).estado).toBe("pendiente");
    await bot.procesar({ key: { id: "T2", remoteJid: YO }, message: { conversation: "en efectivo" } });
    expect(respuestas.at(-1)).toBe("✅ Anotado: *ABL · Casa* $ 38.400,00 (con Efectivo, comprobante guardado).\nYa pagaste todo lo del mes 🙌");
    expect(await item("2026-11", "ABL")).toMatchObject({ estado: "pagado", forma: "Efectivo", comprobante: "image/webp" });
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
    expect(respuestas.at(-1)).toBe("✅ Anotado: *ABL · Casa* $ 38.400,00 (con Transferencia, comprobante guardado).\nTe falta: Luz · Express 1.");
    expect(await item("2026-11", "ABL")).toMatchObject({ estado: "pagado", comprobante: "image/webp", pagadoEn: "2026-11-26" });

    analizarFoto.mockResolvedValue(analisis({ tipo: "factura", monto_numero: 96200, fecha_evento: "2026-11-29T00:00:00-03:00", pago_id: luz.id }));
    await bot.procesar(foto());
    expect(respuestas.at(-1)).toBe("📄 Anoté la boleta de *Luz · Express 1*: $ 96.200,00, vence en 3 días (dom 29/11). Te aviso antes.");

    // Un comprobante que no sabe de cuál es: pregunta, y con lo que le dice lo encuentra.
    analizarFoto.mockResolvedValue(analisis({ monto_numero: 96200 }));
    await bot.procesar(foto());
    expect(respuestas.at(-1)).toBe("🧾 Veo un pago de $ 96.200,00. ¿De cuál de tus pagos es? Decime, por ejemplo, «es la luz del Express 1».");
    await bot.procesar(texto("es la luz del express"));
    expect(respuestas.at(-1)).toBe("✅ Anotado: *Luz · Express 1* $ 96.200,00 (con Transferencia, comprobante guardado).\nYa pagaste todo lo del mes 🙌");
  });

  it("mes vencido: lo de octubre se paga en noviembre; cada mes muestra lo que se paga y el resumen lo que corresponde", async () => {
    await verMes("2026-11"); // Pagos se abrió por primera vez en noviembre.
    const f931 = (await crearFijo(fijo(express, { nombre: "F-931", categoria: "Sueldos y cargas", monto: 450000, variable: true, dia: 10, desde: "2026-10", desfase: 1 }))).id;
    const mono = (await crearFijo(fijo(express, { nombre: "Monotributo", categoria: "Impuestos y tasas", monto: 99800, dia: 20, desde: "2026-10" }))).id;
    await crearFijo(fijo(express, { nombre: "Alquiler", categoria: "Alquiler", monto: 650000, dia: 5 }));
    const vista = async (p: string) => (await verMes(p)).items.map((i) => [i.nombre, i.periodo, i.mesPago, i.vence]);

    // Noviembre: el F-931 de octubre (vence el 10/11), el monotributo y el alquiler de noviembre.
    expect(await vista("2026-11")).toEqual([
      ["Alquiler", "2026-11", "2026-11", "2026-11-05"],
      ["F-931", "2026-10", "2026-11", "2026-11-10"],
      ["Monotributo", "2026-11", "2026-11", "2026-11-20"],
    ]);
    // Octubre se arma aunque Pagos se haya abierto en noviembre: el monotributo de octubre (el F-931 se paga en noviembre).
    expect(await vista("2026-10")).toEqual([["Monotributo", "2026-10", "2026-10", "2026-10-20"]]);
    expect(await vista("2026-12")).toEqual([
      ["Alquiler", "2026-12", "2026-12", "2026-12-05"],
      ["F-931", "2026-11", "2026-12", "2026-12-10"],
      ["Monotributo", "2026-12", "2026-12", "2026-12-20"],
    ]);
    // Volver a abrir un mes no repite nada.
    expect((await vista("2026-11")).length).toBe(3);
    expect((await vista("2026-12")).length).toBe(3);

    // El resumen, de entrada, por el mes al que corresponde (el gasto); también por el mes en que se paga.
    const total = (r: Awaited<ReturnType<typeof resumenPagos>>) => r.mes.total.ARS;
    expect(total(await resumenPagos("2026-10"))).toBe(450000 + 99800);
    expect(total(await resumenPagos("2026-11"))).toBe(450000 + 99800 + 650000);
    expect(total(await resumenPagos("2026-10", "pago"))).toBe(99800);
    expect(total(await resumenPagos("2026-11", "pago"))).toBe(450000 + 99800 + 650000);

    // El resumen de la contadora de octubre, cargado en noviembre: va al F-931 de octubre y lo nuevo es de octubre en adelante.
    const contadora = await crearPersona({ nombre: "Contadora", saldoInicial: 0 });
    const pagoElla = (await listarFormas()).find((f) => f.personaId === contadora.id)!.id;
    const f931Oct = (await item("2026-11", "F-931")).id;
    pedir.mockResolvedValue({
      montos: [{ id: f931Oct, monto: 493430, como_figura: "F-931" }],
      nuevos: [
        { alcance: "lugar", lugar: "Express 1", tipo: "negocio", repartir_entre: [], nombre: "UTHGRA", categoria: "Sueldos y cargas", monto: 35412, variable: true, moneda: "ARS", dia: 0, mes_vencido: true, frecuencia: "mensual", forma: "", cuenta: "", nota: "", como_figura: "UTHGRA" },
      ],
      total: 528842,
      mensaje: "",
    });
    const leido = await cargarMesConIa("2026-10", "lo de octubre");
    const [, , system] = pedir.mock.calls[0];
    expect(system).toContain("Cargás los montos que corresponden a octubre 2026");
    expect(system).toContain(`#${f931Oct} | F-931 · Express 1 | 450000 ARS | pendiente`);
    expect(system).toContain("Mes vencido:");
    expect(leido.montos).toEqual([expect.objectContaining({ fijoId: f931, monto: 493430, antes: 450000 })]);
    expect(leido.nuevos[0]).toMatchObject({ nombre: "UTHGRA", desfase: 1 });
    const { app, headers } = await panelConSesion();
    const res = await app.inject({
      method: "POST",
      url: "/api/pagos/mes/aplicar",
      headers,
      payload: { periodo: "2026-10", montos: [{ fijoId: f931, monto: 493430, pagadoCon: pagoElla }], nuevos: leido.nuevos.map((n) => ({ ...n, pagadoCon: pagoElla })), fechaPago: "2026-11-12" },
    });
    expect(res.json()).toEqual({ cambiados: 1, creados: 1 });
    const nov = await verMes("2026-11");
    expect(nov.items.filter((i) => i.periodo === "2026-10").map((i) => [i.nombre, i.monto, i.estado, i.pagadoEn, i.forma])).toEqual([
      ["F-931", 493430, "pagado", "2026-11-12", "Lo pagó: Contadora"],
      ["UTHGRA", 35412, "pagado", "2026-11-12", "Lo pagó: Contadora"],
    ]);
    // El UTHGRA de noviembre se paga en diciembre; el de octubre no aparece en octubre.
    expect((await item("2026-12", "UTHGRA"))).toMatchObject({ periodo: "2026-11", estado: "pendiente" });
    expect(await item("2026-10", "UTHGRA")).toBeUndefined();
    expect((await listarCuentas()).find((c) => c.id === contadora.id)?.saldo).toBe(493430 + 35412);
    // El CSV dice a qué mes corresponde y en cuál se paga.
    const csv = await app.inject({ method: "GET", url: "/api/pagos/exportar?desde=2026-10&hasta=2026-10", headers });
    expect(csv.body).toContain("2026-10;2026-11;10/11/2026;Express 1;Negocio;Sueldos y cargas;F-931");
    await app.close();

    // Pasar el monotributo a mes vencido: el de noviembre se paga en diciembre (vence el 20/12).
    const m = (await listarFijos()).find((f) => f.id === mono)!;
    await actualizarFijo(mono, { ...m, desfase: 1 });
    expect(await item("2026-12", "Monotributo")).toMatchObject({ periodo: "2026-11", vence: "2026-12-20" });
    expect((await verMes("2026-11")).items.some((i) => i.nombre === "Monotributo")).toBe(false);

    // El aviso por WhatsApp dice de qué mes es.
    const wa = enviadorFalso();
    r.ir(local("2026-12-07T10:00"));
    await avisarPagos();
    expect(wa.enviados[0].texto).toContain("• F-931 (de noviembre) · Express 1 — $ 450.000,00 · vence en 3 días");
  });
});
