import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db/index.js";
import { notaCalculadora } from "../src/db/schema.js";
import { bavosi, encadenar, proporcion, variacion } from "../web/src/lib/calculos.js";
import { aNumero, pct, plata } from "../web/src/lib/numeros.js";
import { baseLimpia, panelConSesion } from "./ayuda.js";

describe("cálculos", () => {
  it("lee los números como se escriben en Argentina", () => {
    expect([aNumero("1.234,56"), aNumero("14.000"), aNumero("3,5"), aNumero("3.5"), aNumero("$ 100"), aNumero("21%"), aNumero(""), aNumero("abc")]).toEqual([
      1234.56, 14000, 3.5, 3.5, 100, 21, null, null,
    ]);
    expect(plata(1234.5)).toBe("$ 1.234,50");
    expect(pct(12.5, true)).toBe("+12,50 %");
  });

  it("Bavosi: precio → descuento → IVA → flete → markup → por unidad", () => {
    const r = bavosi({ precio: 1000, descuento: 10, iva: 21, flete: 5, markup: 30, cantidad: 4 });
    expect(r.conDescuento).toBeCloseTo(900);
    expect(r.conIva).toBeCloseTo(1089);
    expect(r.miCosto).toBeCloseTo(1143.45);
    expect(r.total).toBeCloseTo(1486.485);
    expect(r.unitario).toBeCloseTo(371.62125);
    // Sin cantidad (o 0) se toma 1.
    expect(bavosi({ precio: 100, descuento: 0, iva: 21, flete: 0, markup: 0, cantidad: 0 }).unitario).toBeCloseTo(121);
  });

  it("aumento, proporción y porcentajes encadenados (cada uno sobre el resultado anterior)", () => {
    expect(variacion(100, 125)).toBe(25);
    expect(variacion(0, 10)).toBeNull();
    expect(proporcion(25, 200)).toBe(12.5);
    expect(proporcion(1, 0)).toBeNull();
    const pasos = encadenar(100, [
      { tipo: "+", valor: 40 },
      { tipo: "+", valor: 20 },
      { tipo: "-", valor: 10 },
    ]);
    expect(pasos.map((p) => Math.round(p.resultado * 100) / 100)).toEqual([140, 168, 151.2]);
  });
});

describe("nota de Bavosi", () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await baseLimpia();
    ({ app, headers } = await panelConSesion());
  });
  afterEach(async () => app.close());

  it("arranca vacía, se guarda cifrada y se vuelve a leer; sin sesión no", async () => {
    const url = "/api/calculadoras/notas/bavosi";
    expect((await app.inject({ url, headers })).json()).toEqual({ texto: "", actualizadoEn: null });
    const guardada = await app.inject({ method: "PUT", url, headers, payload: { texto: "Lista de precios de noviembre" } });
    expect(guardada.statusCode).toBe(200);
    expect((await app.inject({ url, headers })).json().texto).toBe("Lista de precios de noviembre");
    const [fila] = await db.select().from(notaCalculadora);
    expect(fila.textoCifrado).not.toContain("noviembre");
    await app.inject({ method: "PUT", url, headers, payload: { texto: "Cambió" } });
    expect((await app.inject({ url, headers })).json().texto).toBe("Cambió");
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/calculadoras/notas/Clave Rara", headers })).statusCode).toBe(400);
  });
});
