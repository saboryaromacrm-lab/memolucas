import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { db } from "../src/db/index.js";
import { tarjeta, tarjetaCuota, tarjetaGasto } from "../src/db/schema.js";
import { avisarCierres, avisarTarjetas, estadoCuota, ultimoCierreHasta } from "../src/servicios/tarjetas.js";
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
    expect(t.proximoResumen).toMatchObject({ cierre: "2026-12-16", vencimiento: "2026-12-25", totalArs: 17_000, totalUsd: 0, sinImportar: null, faltaPago: "2026-11-16" });
    expect(t.proximoResumen.lineas.map((l: { descripcion: string; detalle: string }) => `${l.descripcion} ${l.detalle}`)).toEqual([
      "Mercado Libre Cuota 12/12",
      "Garbarino Cuota 5/6",
      "Frávega Cuota 2/3",
    ]);
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

  it("próximo resumen: cuotas, suscripciones de la tarjeta, débitos sin duplicar, compras cargadas y saldo sin pagar", async () => {
    const wa = enviadorFalso();
    const { id } = (await app.inject({ method: "POST", url: "/api/tarjetas", headers, payload: VISA })).json();
    const post = (url: string, payload: object) => app.inject({ method: "POST", url, headers, payload });
    // El resumen de noviembre trae dos débitos que se repiten.
    const resumen = (cierre: string, vencimiento: string, consumos: object[]) =>
      post(`/api/tarjetas/${id}/resumenes`, { ...VISA, cierre, vencimiento, limiteCompra: null, limiteCuotas: null, ultimos4: "", cuotas: [], consumos, cargos: [] });
    await resumen("2026-11-16", "2026-11-25", [
      { nombre: "NETFLIX.COM", monto: 4_599 },
      { nombre: "SPOTIFY P2B3", monto: 2_999 },
    ]);
    const susc = (nombre: string, extra: object) => post("/api/suscripciones", { nombre, frecuencia: "mensual", monto: 0, ...extra });
    await susc("Netflix", { fechaVto: "2026-11-05", monto: 4_999, tarjetaId: id }); // ya se cobró el 5/11: el próximo, el 5/12
    await susc("ChatGPT", { fechaVto: "2026-11-28", monto: 20, moneda: "USD", tarjetaId: id });
    await susc("Dominio", { fechaVto: "2027-03-01", monto: 15_000, frecuencia: "anual", tarjetaId: id }); // fuera de este resumen
    await susc("Spotify", { fechaVto: "2026-12-01", monto: 2_999 }); // sin definir: se sugiere la Visa
    await susc("HBO", { fechaVto: "2026-12-01", monto: 3_000, sinTarjeta: true });

    // Compras: una de este período, una del anterior (ya cerró) y una en 6 cuotas.
    await post(`/api/tarjetas/${id}/compras`, { descripcion: "Súper", monto: 30_000, fecha: "2026-11-18" });
    await post(`/api/tarjetas/${id}/compras`, { descripcion: "Nafta", monto: 40_000, fecha: "2026-11-10" });
    await post(`/api/tarjetas/${id}/compras`, { descripcion: "Heladera", monto: 600_000, fecha: "2026-11-19", cuotas: 6 });
    // Del resumen de noviembre pagaste 200.000 de 250.000,50.
    await app.inject({ method: "PUT", url: `/api/tarjetas/${id}/pago`, headers, payload: { monto: 200_000 } });

    const p = (await listar()).tarjetas[0].proximoResumen;
    expect(p.lineas.map((l: { tipo: string; descripcion: string; detalle: string | null; monto: number; moneda: string }) => [l.tipo, l.descripcion, l.detalle, l.monto, l.moneda])).toEqual([
      ["cuota", "Heladera", "Cuota 1/6", 100_000, "ARS"],
      ["suscripcion", "Netflix", "en el resumen figura como NETFLIX.COM", 4_999, "ARS"],
      ["suscripcion", "ChatGPT", null, 20, "USD"],
      ["debito", "SPOTIFY P2B3", "como en el último resumen", 2_999, "ARS"],
      ["compra", "Súper", "18/11", 30_000, "ARS"],
      ["saldo", "Lo que quedó sin pagar", "pagaste $ 200.000,00 de $ 250.000,50", 50_000.5, "ARS"],
    ]);
    expect(p).toMatchObject({ cierre: "2026-12-16", vencimiento: "2026-12-25", totalArs: 187_998.5, totalUsd: 20, faltaPago: null, pagado: 200_000 });
    expect(JSON.stringify(await db.select().from(tarjetaGasto))).not.toContain("Súper");

    // La suscripción sin tarjeta que aparece en los débitos se sugiere; la de "otro medio", no.
    const { suscripciones, sugerencias } = (await app.inject({ url: "/api/suscripciones", headers })).json();
    const spotify = suscripciones.find((x: { nombre: string }) => x.nombre === "Spotify");
    expect(sugerencias).toEqual({ [spotify.id]: { tarjetaId: id, tarjeta: "VISA Banco Formosa ···1376", comoAparece: "SPOTIFY P2B3" } });

    // Dos días antes del cierre te llega lo que viene, una sola vez.
    await avisarCierres();
    expect(wa.enviados).toHaveLength(0);
    vi.setSystemTime(local("2026-12-14T09:00"));
    await avisarCierres();
    await avisarCierres();
    expect(wa.enviados.map((e) => e.texto)).toEqual([
      [
        "🧾 *VISA Banco Formosa ···1376* cierra mié 16/12 y vence 25/12",
        "Te viene aprox. *$ 187.998,50 + US$ 20,00*",
        "• Cuotas: $ 100.000,00",
        "• Suscripciones y débitos (3): $ 7.998,00 + US$ 20,00",
        "• Compras que cargaste: $ 30.000,00",
        "• Saldo sin pagar del anterior: $ 50.000,50",
        "_Sin impuestos, percepciones ni intereses. El detalle, en el panel._",
      ].join("\n"),
    ]);

    // Pasado el cierre, si no importaste el resumen te lo marca; al importarlo, las compras cargadas se van.
    vi.setSystemTime(local("2026-12-18T09:00"));
    expect((await listar()).tarjetas[0].proximoResumen).toMatchObject({ cierre: "2027-01-16", sinImportar: "2026-12-16", pagado: null });
    await resumen("2026-12-16", "2026-12-25", []);
    expect(await db.select().from(tarjetaGasto)).toEqual([]);
    expect((await listar()).tarjetas[0].proximoResumen).toMatchObject({ sinImportar: null, faltaPago: "2026-12-16" });
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
