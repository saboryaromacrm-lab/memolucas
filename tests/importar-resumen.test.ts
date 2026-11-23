import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { db } from "../src/db/index.js";
import { tarjetaResumen } from "../src/db/schema.js";
import type { EsquemaResumen } from "../src/servicios/importar-resumen.js";
import type { z } from "zod";
import { baseLimpia, panelConSesion, reloj } from "./ayuda.js";

type Lectura = z.infer<typeof EsquemaResumen>;
const pedir = vi.fn<(...a: unknown[]) => Promise<Lectura>>();
vi.mock("../src/bot/ia.js", async (orig) => ({ ...(await orig<object>()), pedir: (...a: unknown[]) => pedir(...a) }));

const local = (iso: string) => DateTime.fromISO(iso, { zone: "America/Argentina/Buenos_Aires" }).toJSDate();
const TEXTO = "VISA BANCO FORMOSA · CIERRE ACTUAL 16 Nov 26 · VENCIMIENTO 25 Nov 26 · SALDO ACTUAL $ 386.540,75 …";

const NOVIEMBRE: Lectura = {
  cierre: "2026-11-16",
  vencimiento: "2026-11-25",
  saldo: 386540.75,
  pagoMinimo: 38654,
  disponibleCompra: 420000,
  disponibleCuotas: 0,
  no_encontrado: ["disponibleCuotas"],
  cuotas: [
    { comercio: "GARBARINO", fechaCompra: "2026-07-20", cuotaActual: 4, cuotaTotal: 12, montoCuota: 45999.9 },
    { comercio: "MERCADOLIBRE", fechaCompra: "", cuotaActual: 2, cuotaTotal: 3, montoCuota: 12500 },
    { comercio: "MERCADOLIBRE", fechaCompra: "", cuotaActual: 1, cuotaTotal: 3, montoCuota: 12500 },
  ],
  consumos: [
    { nombre: "NETFLIX.COM", monto: 4599, recurrente: true },
    { nombre: "SUPERMERCADO EL TOTAL", monto: 85000, recurrente: false },
  ],
  cargos: [{ descripcion: "IVA S/COMISION", monto: 420 }],
};

describe("importar el resumen de la tarjeta", () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let id = 0;

  beforeEach(async () => {
    await baseLimpia();
    pedir.mockReset();
    reloj(local("2026-11-20T08:00"));
    ({ app, headers } = await panelConSesion());
    const base = { nombre: "VISA Banco Formosa", ultimos4: "1376", cierre: null, vencimiento: null, limiteCompra: 1_500_000, limiteCuotas: 1_500_000, disponibleCompra: 0, disponibleCuotas: 0, saldo: 0, pagoMinimo: 0 };
    id = (await app.inject({ method: "POST", url: "/api/tarjetas", headers, payload: base })).json().id;
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  const leer = async (l: Lectura) => {
    pedir.mockResolvedValueOnce(l);
    return (await app.inject({ method: "POST", url: "/api/tarjetas/leer-resumen", headers, payload: { texto: TEXTO } })).json();
  };
  const guardar = (r: object) => app.inject({ method: "POST", url: `/api/tarjetas/${id}/resumenes`, headers, payload: r });
  const vista = async () => (await app.inject({ url: "/api/tarjetas", headers })).json().tarjetas[0];

  it("lee, se guarda y reimportar no duplica; el mes siguiente actualiza cuotas y consumos; uno viejo no pisa nada", async () => {
    // Leer: dice qué falta y deja solo los consumos que se repiten cada mes.
    const leido = await leer(NOVIEMBRE);
    expect(leido.faltan).toEqual(["disponibleCuotas"]);
    expect(leido.consumos).toEqual([{ nombre: "NETFLIX.COM", monto: 4599 }]);
    expect(leido.cuotas[1].fechaCompra).toBeNull();
    expect(String((pedir.mock.calls[0][3] as { content: string }[])[0].content)).toBe(TEXTO);
    expect((await app.inject({ method: "POST", url: "/api/tarjetas/leer-resumen", headers, payload: { texto: "corto" } })).statusCode).toBe(400);

    const { faltan: _, ...revisado } = leido;
    const r = await guardar({ ...revisado, disponibleCuotas: 600_000 });
    expect(r.json()).toEqual({ masNuevo: true, cuotasNuevas: 3, cuotasActualizadas: 0, consumos: 1 });
    // Reimportar el mismo resumen: un solo resumen, las mismas cuotas (las dos de Mercado Libre siguen siendo dos).
    expect((await guardar({ ...revisado, disponibleCuotas: 600_000 })).json()).toMatchObject({ cuotasNuevas: 0, cuotasActualizadas: 3 });
    expect(await db.select().from(tarjetaResumen)).toHaveLength(1);
    let t = await vista();
    expect(t).toMatchObject({ cierre: "2026-11-16", vencimiento: "2026-11-25", saldo: 386540.75, disponibleCuotas: 600_000, limiteCompra: 1_500_000, cantidadResumenes: 1 });
    expect(t.ultimoResumen).toEqual({ cierre: "2026-11-16", vencimiento: "2026-11-25" });
    expect(t.cuotas).toHaveLength(3);
    expect(t.consumos).toEqual([{ id: expect.any(Number), nombre: "NETFLIX.COM", periodo: "2026-11", monto: 4599, anterior: null, variacion: null }]);

    // Diciembre: las cuotas avanzan (una de Mercado Libre termina), Netflix sube y hay una compra nueva.
    vi.setSystemTime(local("2026-12-20T08:00"));
    const diciembre = await leer({
      ...NOVIEMBRE,
      cierre: "2026-12-16",
      vencimiento: "2026-12-26",
      saldo: 400000,
      no_encontrado: [],
      cuotas: [
        { comercio: "Garbarino", fechaCompra: "2026-07-20", cuotaActual: 5, cuotaTotal: 12, montoCuota: 45999.9 },
        { comercio: "MERCADOLIBRE", fechaCompra: "", cuotaActual: 3, cuotaTotal: 3, montoCuota: 12500 },
        { comercio: "Mercado Libre", fechaCompra: "", cuotaActual: 2, cuotaTotal: 3, montoCuota: 12500 },
        { comercio: "FRAVEGA", fechaCompra: "2026-12-01", cuotaActual: 1, cuotaTotal: 6, montoCuota: 30000 },
      ],
      consumos: [{ nombre: "Netflix.com", monto: 5299, recurrente: true }],
    });
    const { faltan: __, ...revisadoDic } = diciembre;
    expect((await guardar(revisadoDic)).json()).toEqual({ masNuevo: true, cuotasNuevas: 1, cuotasActualizadas: 3, consumos: 1 });
    t = await vista();
    expect(t.cuotas.map((c: { comercio: string; actual: number }) => [c.comercio, c.actual])).toEqual([
      ["MERCADOLIBRE", 2],
      ["FRAVEGA", 1],
      ["GARBARINO", 5],
    ]);
    expect(t.finalizadas.map((c: { comercio: string }) => c.comercio)).toEqual(["MERCADOLIBRE"]);
    expect(t.consumos[0]).toMatchObject({ monto: 5299, anterior: 4599 });
    expect(t.consumos[0].variacion).toBeCloseTo(15.22, 2);

    // Un resumen viejo queda en el historial, pero no cambia la tarjeta ni las cuotas.
    const octubre = await leer({ ...NOVIEMBRE, cierre: "2026-10-16", vencimiento: "2026-10-26", saldo: 1, no_encontrado: [], cuotas: [], consumos: [] });
    const { faltan: ___, ...revisadoOct } = octubre;
    expect((await guardar(revisadoOct)).json()).toMatchObject({ masNuevo: false });
    t = await vista();
    expect(t).toMatchObject({ cierre: "2026-12-16", saldo: 400000, cantidadResumenes: 3 });
    expect(t.ultimoResumen.cierre).toBe("2026-12-16");
    expect((await guardar({ ...revisadoOct, cierre: "" })).statusCode).toBe(400);
  });
});
