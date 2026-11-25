import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import { usoIa } from "../src/db/schema.js";
import { anotarFallaIA } from "../src/bot/estado-ia.js";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { cargarSaldoIA, creditoIA, fijarSaldoIA, revisarCreditoIA } from "../src/servicios/credito-ia.js";
import { textoResumen } from "../src/servicios/resumen.js";
import { baseLimpia, enviadorFalso, panelConSesion, reloj } from "./ayuda.js";

const Z = "America/Argentina/Buenos_Aires";
const local = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();
/** Gasto de IA hace tantos días. */
const gasto = (usd: number, haceDias: number) =>
  db.insert(usoIa).values({ modelo: "claude-haiku-5-5", tokensEntrada: 1000, tokensSalida: 100, costoUsd: usd.toFixed(6), creadoEn: new Date(Date.now() - haceDias * 86_400_000) });

describe("crédito de Claude", () => {
  let wa: ReturnType<typeof enviadorFalso>;
  let r: ReturnType<typeof reloj>;
  beforeEach(async () => {
    await baseLimpia();
    wa = enviadorFalso();
    r = reloj(local("2026-11-25T12:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("descuenta lo gastado desde que se cargó y calcula para cuántos días alcanza", async () => {
    expect(await creditoIA()).toBeNull();
    // Antes de cargar el saldo ya venía gastando 0,12 por día (cuenta para el ritmo, no para el saldo).
    for (let d = 10; d >= 1; d--) await gasto(0.12, d);
    await fijarSaldoIA(3);
    r.avanzar(1);
    await gasto(0.5, 0);
    const c = (await creditoIA())!;
    expect(c.saldoUsd).toBeCloseTo(2.5);
    expect(c.porDiaUsd).toBeCloseTo((1.2 + 0.5) / 10);
    expect(c.dias).toBeCloseTo(2.5 / 0.17);
    // "cargué 10 dólares": se suma a lo que queda.
    r.avanzar(1);
    expect((await cargarSaldoIA(10))!.saldoUsd).toBeCloseTo(12.5);
  });

  it("avisa una vez a los 7 días y otra a los 2, nunca en silencio ni con la IA caída", async () => {
    for (let d = 14; d >= 1; d--) await gasto(0.5, d);
    await fijarSaldoIA(3); // 6 días.
    await revisarCreditoIA();
    await revisarCreditoIA();
    expect(wa.enviados).toHaveLength(1);
    expect(wa.enviados[0].texto).toContain("Te queda poco crédito de Claude");
    expect(wa.enviados[0].texto).toContain("*US$ 3,00*, que al ritmo de ahora te alcanzan para *6 días*");
    expect(wa.enviados[0].texto).toContain("«cargué 10 dólares»");
    expect(wa.enviados[0].texto).toContain("recarga automática");

    // En silencio, espera.
    r.avanzar(1);
    await gasto(2.2, 0); // Quedan 0,80: con el ritmo nuevo (0,66 por día), 1 día.
    await actualizarConfig({ silencioActivo: true, silencioDesde: "11:00", silencioHasta: "13:00", silencioDias: [1, 2, 3, 4, 5, 6, 7] });
    await revisarCreditoIA();
    expect(wa.enviados).toHaveLength(1);
    await actualizarConfig({ silencioActivo: false });
    await revisarCreditoIA();
    expect(wa.enviados).toHaveLength(2);
    expect(wa.enviados[1].texto).toContain("*US$ 0,80*, que al ritmo de ahora te alcanzan para *1 día*");

    // Con la IA caída por falta de crédito, el aviso de la falla dice lo mismo: el saldo queda en 0 y no se repite.
    await fijarSaldoIA(3);
    await anotarFallaIA("sin_credito");
    expect((await creditoIA())!.saldoUsd).toBe(0);
    await revisarCreditoIA();
    expect(wa.enviados).toHaveLength(2);
  });

  it("el resumen de la mañana suma una línea solo cuando queda poco", async () => {
    for (let d = 14; d >= 1; d--) await gasto(0.1, d);
    await fijarSaldoIA(5); // 50 días.
    expect(await textoResumen()).not.toContain("Crédito de Claude");
    await fijarSaldoIA(0.5); // 5 días.
    expect(await textoResumen()).toContain("🪫 Crédito de Claude: unos *US$ 0,50*, que al ritmo de ahora te alcanzan para *5 días*.");
  });

  it("el panel lo muestra y se actualiza desde Inicio", async () => {
    const { app, headers } = await panelConSesion();
    expect((await app.inject({ method: "GET", url: "/api/estado", headers })).json().ia.credito).toBeNull();
    const r = await app.inject({ method: "PUT", url: "/api/configuracion/saldo-ia", headers, payload: { saldoUsd: 4.5 } });
    expect(r.json()).toMatchObject({ saldoUsd: 4.5, porDiaUsd: 0, dias: null });
    expect((await app.inject({ method: "GET", url: "/api/estado", headers })).json().ia.credito.saldoUsd).toBe(4.5);
    expect((await app.inject({ method: "PUT", url: "/api/configuracion/saldo-ia", headers, payload: { saldoUsd: -1 } })).statusCode).toBe(400);
    await app.close();
  });
});
