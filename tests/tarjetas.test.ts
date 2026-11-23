import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { db } from "../src/db/index.js";
import { tarjeta, tarjetaCuota } from "../src/db/schema.js";
import { avisarTarjetas, estadoCuota, ultimoCierreHasta } from "../src/servicios/tarjetas.js";
import { baseLimpia, enviadorFalso, panelConSesion, reloj } from "./ayuda.js";

const Z = "America/Argentina/Buenos_Aires";
const local = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();
const dia = (iso: string) => DateTime.fromISO(iso, { zone: Z });

const VISA = {
  nombre: "VISA Banco Formosa",
  ultimos4: "1376",
  cierre: "2026-11-16",
  vencimiento: "2026-11-25",
  limiteCompra: 1_000_000,
  limiteCuotas: 1_000_000,
  disponibleCompra: 300_000,
  disponibleCuotas: 450_000,
  saldo: 250_000.5,
  pagoMinimo: 25_000,
};

describe("cuotas que avanzan solas en cada cierre", () => {
  it("la cuota de hoy es la del último resumen más los cierres que pasaron (el día del cierre todavía no cuenta)", () => {
    const c = { cuotaActual: 3, cuotaTotal: 6, cierreBase: "2026-10-16" };
    expect(estadoCuota(c, dia("2026-11-16"))).toEqual({ actual: 3, restantes: 3, finalizada: false, ultimoCierre: "2027-01-16" });
    expect(estadoCuota(c, dia("2026-11-17"))).toMatchObject({ actual: 4, restantes: 2 });
    expect(estadoCuota(c, dia("2027-06-01"))).toMatchObject({ actual: 6, restantes: 0, finalizada: true });
  });

  it("el último cierre hasta hoy, desde un cierre viejo, uno futuro o ninguno", () => {
    expect(ultimoCierreHasta("2026-10-16", dia("2026-11-20"))).toBe("2026-11-16");
    expect(ultimoCierreHasta("2026-12-16", dia("2026-11-20"))).toBe("2026-11-16");
    expect(ultimoCierreHasta("2026-11-16", dia("2026-11-16"))).toBe("2026-10-16");
    expect(ultimoCierreHasta(null, dia("2026-11-20"))).toBe("2026-11-20");
  });
});

describe("tarjetas desde el panel", () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await baseLimpia();
    reloj(local("2026-11-20T08:00"));
    ({ app, headers } = await panelConSesion());
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  const listar = async () => (await app.inject({ url: "/api/tarjetas", headers })).json();

  it("estado de cuenta, cuotas, proyección e historial; los importes y comercios quedan cifrados", async () => {
    const { id } = (await app.inject({ method: "POST", url: "/api/tarjetas", headers, payload: VISA })).json();
    expect((await app.inject({ method: "POST", url: "/api/tarjetas", headers, payload: { ...VISA, ultimos4: "4509 1234 5678 1376" } })).statusCode).toBe(400);
    const cuota = (c: object) => app.inject({ method: "POST", url: `/api/tarjetas/${id}/cuotas`, headers, payload: { fechaCompra: null, ...c } });
    await cuota({ comercio: "Garbarino", montoCuota: 10_000, cuotaActual: 4, cuotaTotal: 6 }); // faltan 2
    await cuota({ comercio: "Frávega", montoCuota: 5_000, cuotaActual: 1, cuotaTotal: 3 }); // faltan 2
    await cuota({ comercio: "Mercado Libre", montoCuota: 2_000, cuotaActual: 11, cuotaTotal: 12 }); // falta 1
    await cuota({ comercio: "Ya pagada", montoCuota: 1_000, cuotaActual: 12, cuotaTotal: 12 });
    expect((await cuota({ comercio: "Mal", montoCuota: 1, cuotaActual: 5, cuotaTotal: 3 })).statusCode).toBe(400);

    const { tarjetas, diasAviso } = await listar();
    expect(diasAviso).toBe(2);
    const t = tarjetas[0];
    expect(t).toMatchObject({ nombre: "VISA Banco Formosa", ultimos4: "1376", saldo: 250_000.5, pagoMinimo: 25_000, usoLimite: 70 });
    expect(t.cuotas.map((c: { comercio: string; actual: number; restantes: number }) => [c.comercio, c.actual, c.restantes])).toEqual([
      ["Mercado Libre", 11, 1],
      ["Garbarino", 4, 2],
      ["Frávega", 1, 2],
    ]);
    expect(t.proximoResumenCuotas).toBe(17_000);
    expect(t.totalAdeudado).toBe(2_000 + 20_000 + 10_000);
    expect(t.finalizadas.map((c: { comercio: string }) => c.comercio)).toEqual(["Ya pagada"]);
    // Próximos cierres: en diciembre se paga todo y termina Mercado Libre; en enero terminan las otras dos.
    expect(t.proyeccion.slice(0, 3)).toEqual([
      { mes: "dic 2026", cuotas: 17_000, libera: 2_000, disponible: 302_000, terminan: ["Mercado Libre"] },
      { mes: "ene 2027", cuotas: 15_000, libera: 15_000, disponible: 317_000, terminan: ["Garbarino", "Frávega"] },
      { mes: "feb 2027", cuotas: 0, libera: 0, disponible: 317_000, terminan: [] },
    ]);
    expect(t.proyeccion).toHaveLength(12);

    const [fila] = await db.select().from(tarjeta);
    expect(fila.datosCifrados).not.toContain("250000");
    expect((await db.select().from(tarjetaCuota)).some((c) => c.datosCifrados.includes("Garbarino"))).toBe(false);

    // Pasado el cierre de diciembre, avanzan solas: Mercado Libre termina.
    vi.setSystemTime(local("2026-12-17T08:00"));
    const despues = (await listar()).tarjetas[0];
    expect(despues.cuotas.map((c: { comercio: string; actual: number }) => [c.comercio, c.actual])).toEqual([
      ["Garbarino", 5],
      ["Frávega", 2],
    ]);
    expect(despues.finalizadas.map((c: { comercio: string }) => c.comercio)).toEqual(["Mercado Libre", "Ya pagada"]);

    // Editar una cuota, borrarla y borrar la tarjeta (con todo lo suyo).
    const garbarino = despues.cuotas[0];
    await app.inject({ method: "PUT", url: `/api/tarjetas/cuotas/${garbarino.id}`, headers, payload: { comercio: "Garbarino", montoCuota: 10_000, fechaCompra: null, cuotaActual: 6, cuotaTotal: 6 } });
    expect((await listar()).tarjetas[0].cuotas.map((c: { comercio: string }) => c.comercio)).toEqual(["Frávega"]);
    await app.inject({ method: "DELETE", url: `/api/tarjetas/${id}`, headers });
    expect((await listar()).tarjetas).toEqual([]);
    expect(await db.select().from(tarjetaCuota)).toEqual([]);
    expect((await app.inject({ url: "/api/tarjetas" })).statusCode).toBe(401);
  });

  it("avisa por WhatsApp unos días antes del vencimiento, con el saldo y el pago mínimo, una sola vez", async () => {
    const wa = enviadorFalso();
    await app.inject({ method: "POST", url: "/api/tarjetas", headers, payload: VISA });
    // Cargada cuando ya debería haber salido su aviso: no avisa.
    await app.inject({ method: "POST", url: "/api/tarjetas", headers, payload: { ...VISA, nombre: "Master", ultimos4: "", vencimiento: "2026-11-21" } });
    await avisarTarjetas();
    expect(wa.enviados).toHaveLength(0);
    vi.setSystemTime(local("2026-11-23T09:00"));
    await avisarTarjetas();
    await avisarTarjetas();
    expect(wa.enviados.map((e) => e.texto)).toEqual(["💳 *VISA Banco Formosa ···1376* vence en 2 días (mié 25/11)\nSaldo $ 250.000,50 · Pago mínimo $ 25.000,00"]);
  });
});
