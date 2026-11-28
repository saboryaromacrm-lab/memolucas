import fs from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import { pagoCarga, pagoFijo, pagoLugar } from "../src/db/schema.js";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { crearFijo, crearLugar, listarFijos, listarLugares, registrarPago, verMes, type EntradaFijo } from "../src/servicios/pagos.js";
import { listarCargas, purgarCargas, verDeshacer } from "../src/servicios/pagos-cargas.js";
import { crearCategoria, listarCategorias } from "../src/servicios/pagos-categorias.js";
import { crearPersona, listarCuentas } from "../src/servicios/pagos-cuentas.js";
import { crearForma, listarFormas } from "../src/servicios/pagos-formas.js";
import { baseLimpia, panelConSesion, reloj } from "./ayuda.js";

const pedir = vi.fn();
vi.mock("../src/bot/ia.js", async (orig) => ({ ...(await orig<object>()), pedir: (...a: unknown[]) => pedir(...a) }));

const Z = "America/Argentina/Buenos_Aires";
let transferencia: number;
const fijo = (lugarId: number | null, e: Partial<EntradaFijo>): EntradaFijo => ({
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
const item = async (periodo: string, nombre: string) => (await verMes(periodo)).items.find((i) => i.nombre === nombre);
const nombres = async () => (await listarFijos()).map((f) => f.nombre).sort();

describe("Cargas con IA", () => {
  let express: number;
  beforeEach(async () => {
    await baseLimpia();
    reloj(DateTime.fromISO("2026-11-26T08:00", { zone: Z }).toJSDate());
    pedir.mockReset();
    for (const c of ["Alquiler", "Servicios", "Impuestos y tasas", "Sueldos y cargas"]) await crearCategoria(c);
    transferencia = (await crearForma({ nombre: "Transferencia", tipo: "transferencia" })).id;
    express = (await crearLugar({ nombre: "Express 1", tipo: "negocio" })).id;
  });
  afterEach(() => vi.useRealTimers());

  it("conceptos: queda lo que le pasaste y lo que hizo, y deshacerla deja todo como estaba", async () => {
    await actualizarConfig({ pagosDesde: "2026-10" });
    const alquiler = (await crearFijo(fijo(express, { nombre: "Alquiler", categoria: "Alquiler", monto: 650000, dia: 5 }))).id;
    const gym = (await crearFijo(fijo(express, { nombre: "Gimnasio", monto: 25000, dia: 1, desde: "2026-10" }))).id;
    // El gimnasio de octubre ya está pagado (queda en el historial) y el de noviembre tiene la boleta cargada.
    await registrarPago((await item("2026-10", "Gimnasio"))!.id, { formaId: transferencia });
    const { app, headers } = await panelConSesion();
    await app.inject({ method: "PUT", url: `/api/pagos/${(await item("2026-11", "Gimnasio"))!.id}`, headers, payload: { monto: 27000 } });

    // La IA lee (con una foto): la respuesta trae el id de la carga.
    pedir.mockResolvedValue({
      nuevos: [
        { alcance: "lugar", lugar: "Fontana", tipo: "negocio", repartir_entre: [], nombre: "Gas", categoria: "Gas y calefacción", monto: 30000, variable: true, moneda: "ARS", dia: 0, frecuencia: "mensual", forma: "", cuenta: "", nota: "", como_figura: "" },
        { alcance: "lugar", lugar: "Express 1", tipo: "negocio", repartir_entre: [], nombre: "Luz", categoria: "Servicios", monto: 70000, variable: true, moneda: "ARS", dia: 0, frecuencia: "mensual", forma: "", cuenta: "", nota: "", como_figura: "" },
      ],
      cambios: [{ id: alquiler, campo: "monto", valor: "850000" }],
      borrar: [gym],
      total: 0,
      mensaje: "",
    });
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).png().toBuffer();
    const leido = (await app.inject({ method: "POST", url: "/api/pagos/ia/armar", headers, payload: { texto: "luz y gas, el alquiler subió, borrá el gimnasio", archivo: { mime: "image/png", base64: png.toString("base64") } } })).json();
    expect(leido.cargaId).toEqual(expect.any(Number));
    // Lo que leyó pero no aplicaste no aparece.
    expect(await listarCargas()).toEqual([]);

    const res = await app.inject({
      method: "POST",
      url: "/api/pagos/fijos/aplicar",
      headers,
      payload: { cargaId: leido.cargaId, nuevos: leido.nuevos, cambios: leido.cambios.map((c: { id: number; despues: object }) => ({ id: c.id, ...c.despues })), borrar: leido.borrar },
    });
    expect(res.json()).toEqual({ creados: 2, cambiados: 1, borrados: 1 });
    expect(await nombres()).toEqual(["Alquiler", "Gas", "Luz"]);

    const [carga] = await listarCargas();
    expect(carga).toMatchObject({ id: leido.cargaId, tipo: "config", texto: "luz y gas, el alquiler subió, borrá el gimnasio", archivo: "image/webp", reconstruida: false });
    expect(carga.lineas.map((l) => [l.tipo, l.nombre, l.detalle])).toEqual([
      ["lugar", "Fontana", "Lugar nuevo · negocio"],
      ["categoria", "Otros", "Categoría nueva"],
      ["nuevo", "Gas", "Fontana · Otros · $ 30.000,00"],
      ["nuevo", "Luz", "Express 1 · Servicios · $ 70.000,00"],
      ["cambio", "Alquiler", "monto: $ 650.000,00 → $ 850.000,00"],
      ["borrar", "Gimnasio", "Express 1 · Servicios"],
    ]);
    // El archivo, como lo leyó la IA (cifrado en el disco).
    const archivo = await app.inject({ method: "GET", url: `/api/pagos/cargas/${carga.id}/archivo`, headers });
    expect([archivo.statusCode, archivo.headers["content-type"]]).toEqual([200, "image/webp"]);

    // Antes de deshacer, lo que va a pasar.
    expect((await app.inject({ method: "GET", url: `/api/pagos/cargas/${carga.id}/deshacer`, headers })).json()).toEqual({
      borra: ["Gas", "Luz"],
      vuelve: ["Alquiler"],
      recrea: ["Gimnasio"],
      montos: [],
      quedan: [],
      lugares: ["Fontana"],
      categorias: ["Otros"],
      reconstruida: false,
    });
    expect((await app.inject({ method: "DELETE", url: `/api/pagos/cargas/${carga.id}`, headers })).statusCode).toBe(200);

    // Todo como antes: el alquiler con su monto, el gimnasio con el mismo id, su boleta y su historial.
    expect(await nombres()).toEqual(["Alquiler", "Gimnasio"]);
    expect((await listarFijos()).find((f) => f.id === alquiler)?.monto).toBe(650000);
    expect((await listarFijos()).some((f) => f.id === gym)).toBe(true);
    expect(await item("2026-11", "Gimnasio")).toMatchObject({ monto: 27000, fijoId: gym });
    expect(await item("2026-10", "Gimnasio")).toMatchObject({ estado: "pagado", fijoId: gym });
    expect((await item("2026-11", "Alquiler"))?.monto).toBe(650000);
    expect((await listarLugares()).map((l) => l.nombre)).toEqual(["Express 1"]);
    expect((await listarCategorias()).map((c) => c.nombre)).not.toContain("Otros");
    expect(await listarCargas()).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/pagos/cargas/${carga.id}/archivo`, headers })).statusCode).toBe(400);
    await app.close();
  });

  it("montos del mes: lo que tocaste después queda como lo dejaste, y entonces no se puede corregir", async () => {
    const contadora = await crearPersona({ nombre: "Contadora", saldoInicial: 0 });
    const pagoElla = (await listarFormas()).find((f) => f.personaId === contadora.id)!.id;
    const f931 = (await crearFijo(fijo(express, { nombre: "F-931", categoria: "Sueldos y cargas", monto: 450000, variable: true }))).id;
    const ips = (await crearFijo(fijo(express, { nombre: "IPS", categoria: "Sueldos y cargas", monto: 26000, variable: true }))).id;
    const { app, headers } = await panelConSesion();
    const aplicar = await app.inject({
      method: "POST",
      url: "/api/pagos/mes/aplicar",
      headers,
      payload: {
        periodo: "2026-11",
        montos: [
          { fijoId: f931, monto: 493430, pagadoCon: pagoElla },
          { fijoId: ips, monto: 26930 },
        ],
        nuevos: [{ ...fijo(express, { nombre: "UTHGRA", categoria: "Sueldos y cargas", monto: 35412, variable: true }), pagadoCon: pagoElla }],
      },
    });
    expect(aplicar.json()).toEqual({ cambiados: 2, creados: 1 });
    const [carga] = await listarCargas();
    expect(carga.lineas.map((l) => [l.tipo, l.nombre, l.detalle])).toEqual([
      ["nuevo", "UTHGRA", "Express 1 · Sueldos y cargas · $ 35.412,00 · pagado con Lo pagó: Contadora"],
      ["monto", "F-931", "Noviembre 2026 · Express 1 · $ 450.000,00 → $ 493.430,00 · pagado con Lo pagó: Contadora"],
      ["monto", "IPS", "Noviembre 2026 · Express 1 · $ 26.000,00 → $ 26.930,00"],
    ]);

    // Después: pagaste el IPS de noviembre y el UTHGRA de diciembre.
    await registrarPago((await item("2026-11", "IPS"))!.id, { formaId: transferencia });
    await registrarPago((await item("2026-12", "UTHGRA"))!.id, { formaId: transferencia });
    expect(await verDeshacer(carga.id)).toMatchObject({
      borra: ["UTHGRA"],
      montos: ["F-931 · Noviembre 2026"],
      quedan: [
        { nombre: "IPS · Noviembre 2026", motivo: "lo cambiaste o pagaste después" },
        { nombre: "UTHGRA · Diciembre 2026", motivo: "lo pagaste después: queda en el historial" },
      ],
    });
    // Corregir pisaría lo tuyo: no deja.
    const corregir = await app.inject({ method: "GET", url: `/api/pagos/cargas/${carga.id}/corregir`, headers });
    expect(corregir.json().error).toContain("Después de esta carga tocaste cosas que hizo (IPS · Noviembre 2026, UTHGRA · Diciembre 2026)");

    await app.inject({ method: "DELETE", url: `/api/pagos/cargas/${carga.id}`, headers });
    expect(await item("2026-11", "F-931")).toMatchObject({ monto: 450000, estado: "pendiente", boleta: null });
    expect(await item("2026-11", "IPS")).toMatchObject({ monto: 26930, estado: "pagado" });
    expect(await item("2026-11", "UTHGRA")).toBeUndefined();
    expect(await item("2026-12", "UTHGRA")).toMatchObject({ estado: "pagado", fijoId: null });
    expect(await nombres()).toEqual(["F-931", "IPS"]);
    // Lo que «pagó» la contadora en esa carga ya no se le debe.
    expect((await listarCuentas()).find((c) => c.id === contadora.id)?.saldo).toBe(0);
    await app.close();
  });

  it("corregir: se abre con lo que hizo, se cambia y queda una sola carga con lo corregido", async () => {
    const f931 = (await crearFijo(fijo(express, { nombre: "F-931", categoria: "Sueldos y cargas", monto: 450000, variable: true }))).id;
    const { app, headers } = await panelConSesion();
    pedir.mockResolvedValue({ montos: [], nuevos: [], total: 0, mensaje: "" });
    const leido = (await app.inject({ method: "POST", url: "/api/pagos/ia/mes", headers, payload: { periodo: "2026-11", texto: "lo de la contadora de octubre" } })).json();
    await app.inject({
      method: "POST",
      url: "/api/pagos/mes/aplicar",
      headers,
      payload: { cargaId: leido.cargaId, periodo: "2026-11", montos: [{ fijoId: f931, monto: 493430 }], nuevos: [fijo(null, { nombre: "Gas", lugarNuevo: { nombre: "Fontana", tipo: "negocio" } } as Partial<EntradaFijo>)] },
    });
    const abierta = (await app.inject({ method: "GET", url: `/api/pagos/cargas/${leido.cargaId}/corregir`, headers })).json();
    const gas = (await listarFijos()).find((f) => f.nombre === "Gas")!;
    expect(abierta).toMatchObject({ tipo: "mes", periodo: "2026-11", propios: [gas.id], montos: [{ fijoId: f931, monto: 493430, antes: 450000, nombre: "F-931", lugar: "Express 1" }] });
    // El concepto nuevo vuelve con su lugar nuevo (que al corregir se vuelve a crear).
    expect(abierta.nuevos[0]).toMatchObject({ nombre: "Gas", lugarId: null, lugarNuevo: { nombre: "Fontana", tipo: "negocio" } });

    const r = await app.inject({
      method: "POST",
      url: `/api/pagos/cargas/${leido.cargaId}/corregir`,
      headers,
      payload: { periodo: "2026-11", montos: [{ fijoId: f931, monto: 500000 }], nuevos: [{ ...abierta.nuevos[0], nombre: "Gas natural" }] },
    });
    expect(r.json()).toEqual({ cambiados: 1, creados: 1 });
    expect(await nombres()).toEqual(["F-931", "Gas natural"]);
    expect((await listarLugares()).map((l) => l.nombre)).toEqual(["Express 1", "Fontana"]);
    expect((await item("2026-11", "F-931"))?.monto).toBe(500000);
    const cargas = await listarCargas();
    expect(cargas.map((c) => [c.id, c.texto])).toEqual([[leido.cargaId, "lo de la contadora de octubre"]]);
    expect(cargas[0].lineas.map((l) => l.nombre)).toEqual(["Fontana", "Gas natural", "F-931"]);
    // Corregido sin nada elegido: es como deshacerla.
    await app.inject({ method: "POST", url: `/api/pagos/cargas/${leido.cargaId}/corregir`, headers, payload: { periodo: "2026-11", montos: [], nuevos: [] } });
    expect([await nombres(), (await item("2026-11", "F-931"))?.monto, await listarCargas()]).toEqual([["F-931"], 450000, []]);
    await app.close();
  });

  it("corregir lo de un mes anterior: vuelve con el mes al que corresponde y la fecha en que se pagó", async () => {
    const contadora = await crearPersona({ nombre: "Contadora", saldoInicial: 0 });
    const pagoElla = (await listarFormas()).find((f) => f.personaId === contadora.id)!.id;
    const f931 = (await crearFijo(fijo(express, { nombre: "F-931", categoria: "Sueldos y cargas", monto: 450000, variable: true, desde: "2026-10", desfase: 1 }))).id;
    const { app, headers } = await panelConSesion();
    await app.inject({ method: "POST", url: "/api/pagos/mes/aplicar", headers, payload: { periodo: "2026-10", montos: [{ fijoId: f931, monto: 493430, pagadoCon: pagoElla }], nuevos: [], fechaPago: "2026-11-12" } });
    const [carga] = await listarCargas();
    expect(carga.lineas.map((l) => l.detalle)).toEqual(["Octubre 2026 · Express 1 · $ 450.000,00 → $ 493.430,00 · pagado con Lo pagó: Contadora"]);
    const abierta = (await app.inject({ method: "GET", url: `/api/pagos/cargas/${carga.id}/corregir`, headers })).json();
    expect(abierta).toMatchObject({ periodo: "2026-10", fechaPago: "2026-11-12", montos: [{ fijoId: f931, monto: 493430, antes: 450000, pagadoCon: pagoElla }] });
    await app.inject({ method: "POST", url: `/api/pagos/cargas/${carga.id}/corregir`, headers, payload: { periodo: "2026-10", montos: [{ fijoId: f931, monto: 500000, pagadoCon: pagoElla }], nuevos: [], fechaPago: "2026-11-13" } });
    expect(await item("2026-11", "F-931")).toMatchObject({ periodo: "2026-10", monto: 500000, estado: "pagado", pagadoEn: "2026-11-13" });
    expect((await listarCuentas()).find((c) => c.id === contadora.id)?.saldo).toBe(500000);
    await app.close();
  });

  it("las de antes del registro se reconstruyen con lo que se creó junto, y se pueden deshacer", async () => {
    const hace = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();
    const a = (await crearFijo(fijo(express, { nombre: "Agua" }))).id;
    const fontana = (await crearLugar({ nombre: "Fontana", tipo: "negocio" })).id;
    const b = (await crearFijo(fijo(fontana, { nombre: "Luz" }))).id;
    const suelto = (await crearFijo(fijo(express, { nombre: "Internet" }))).id;
    // Agua, Fontana y Luz, juntos en octubre; Internet, días después (a mano).
    const fecha = async (tabla: typeof pagoFijo | typeof pagoLugar, id: number, d: Date) =>
      tabla === pagoFijo ? db.update(pagoFijo).set({ creadoEn: d, actualizadoEn: d }).where(eq(pagoFijo.id, id)) : db.update(pagoLugar).set({ creadoEn: d }).where(eq(pagoLugar.id, id));
    await fecha(pagoFijo, a, hace("2026-10-02T10:00:00"));
    await fecha(pagoLugar, fontana, hace("2026-10-02T10:00:02"));
    await fecha(pagoFijo, b, hace("2026-10-02T10:00:03"));
    await fecha(pagoFijo, suelto, hace("2026-10-09T18:00:00"));
    await db.update(pagoLugar).set({ creadoEn: hace("2026-01-01") }).where(eq(pagoLugar.id, express));
    // La luz de noviembre la pagaste vos (queda en el historial).
    await registrarPago((await item("2026-11", "Luz"))!.id, { formaId: transferencia });

    const migracion = await fs.readFile(new URL("../drizzle/0036_cargas_ia.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(migracion.split("--> statement-breakpoint")[1]));
    const cargas = await listarCargas();
    expect(cargas.map((c) => [c.reconstruida, c.texto, c.lineas.map((l) => [l.tipo, l.nombre])])).toEqual([
      [true, "", [["lugar", "Fontana"], ["nuevo", "Agua"], ["nuevo", "Luz"]]],
    ]);
    const { app, headers } = await panelConSesion();
    expect((await app.inject({ method: "GET", url: `/api/pagos/cargas/${cargas[0].id}/corregir`, headers })).json().error).toContain("solo se puede deshacer");
    expect(await verDeshacer(cargas[0].id)).toMatchObject({ borra: ["Agua", "Luz"], quedan: [{ nombre: "Luz · Noviembre 2026", motivo: "lo pagaste después: queda en el historial" }], lugares: ["Fontana"], reconstruida: true });
    await app.inject({ method: "DELETE", url: `/api/pagos/cargas/${cargas[0].id}`, headers });
    expect(await nombres()).toEqual(["Internet"]);
    // Fontana queda: lo usa la luz pagada del historial.
    expect((await listarLugares()).map((l) => l.nombre)).toEqual(["Express 1", "Fontana"]);
    expect(await item("2026-11", "Luz")).toMatchObject({ estado: "pagado", fijoId: null });
    await app.close();
  });

  it("mantenimiento: las lecturas sin aplicar se borran al día y los archivos a los 12 meses", async () => {
    const { app, headers } = await panelConSesion();
    pedir.mockResolvedValue({ nuevos: [], cambios: [], borrar: [], total: 0, mensaje: "" });
    const pdf = Buffer.from("%PDF-1.4 prueba").toString("base64");
    const sinAplicar = (await app.inject({ method: "POST", url: "/api/pagos/ia/armar", headers, payload: { texto: "nada", archivo: { mime: "application/pdf", base64: pdf } } })).json().cargaId;
    const vieja = (await app.inject({ method: "POST", url: "/api/pagos/ia/armar", headers, payload: { texto: "luz", archivo: { mime: "application/pdf", base64: pdf } } })).json().cargaId;
    await app.inject({ method: "POST", url: "/api/pagos/fijos/aplicar", headers, payload: { cargaId: vieja, nuevos: [fijo(express, { nombre: "Luz" })], cambios: [], borrar: [] } });
    await db.update(pagoCarga).set({ creadoEn: new Date("2025-01-01"), aplicadaEn: new Date("2025-01-01") });
    await purgarCargas();
    const filas = await db.select().from(pagoCarga);
    expect(filas.map((c) => [c.id, c.archivo])).toEqual([[vieja, null]]);
    expect(sinAplicar).not.toBe(vieja);
    expect((await listarCargas())[0]).toMatchObject({ texto: "luz", archivo: null });
    await app.close();
  });
});
