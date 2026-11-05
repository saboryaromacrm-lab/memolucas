import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db/index.js";
import { formaPago } from "../src/db/schema.js";
import { asegurarAcceso } from "../src/http/rutas/auth.js";
import { crearServidor } from "../src/http/servidor.js";
import { controlar } from "../src/lib/comprobantes.js";
import { actualizarDatos, fijarFormaPago, guardarComprobante, obtenerComprobante } from "../src/servicios/compras.js";
import { guardarCompraManual } from "../src/servicios/compras-manuales.js";
import { actualizarFormaPago, borrarFormaPago, crearFormaPago, listarFormasPago, moverFormaPago } from "../src/servicios/formas-pago.js";
import { crearUsuario } from "../src/servicios/panel-compras.js";
import { actualizarProveedor, crearProveedor } from "../src/servicios/proveedores.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const hoy = () => new Date().toISOString().slice(0, 10);

/** Una factura de Cabrales; medio: lo que dice la factura sobre cómo se pagó. */
async function factura(numero: string, medio = "") {
  const f = facturaDePrueba();
  f.encabezado = { ...f.encabezado, numero, fecha: hoy() };
  f.pagoQueFigura = { ...f.pagoQueFigura, figura: !!medio, medio: medio as typeof f.pagoQueFigura.medio };
  const { comprobante: datos, cierra } = controlar(f);
  return guardarComprobante({ chat: null, autor: "Martín", origen: "panel", datos, cierra, modelo: null, adjuntoIds: [] });
}

const bidon = (proveedorId: number | null, formaPagoId: number | null) => ({
  proveedorId,
  formaPagoId,
  fecha: hoy(),
  renglones: [{ nombre: "Bidón de agua 20 l", categoria: "", clase: "gasto" as const, cantidad: 2, unidadCompra: "unidad" as const, unidadesPorBulto: 0, contenido: 20, medida: "l" as const, total: 14000 }],
});

describe("formas de pago", () => {
  beforeEach(async () => {
    await baseLimpia();
  });

  it("se crean al final, se ordenan, se ocultan y solo se borran si no se usaron", async () => {
    const efectivo = await crearFormaPago("Efectivo");
    const transferencia = await crearFormaPago("Transferencia");
    const cheque = await crearFormaPago("Cheque");
    await expect(crearFormaPago("  efectivo ")).rejects.toThrow("Ya hay una forma de pago con ese nombre");

    await moverFormaPago(cheque.id, -1);
    await moverFormaPago(efectivo.id, -1); // Ya es la primera: no cambia.
    expect((await listarFormasPago()).map((f) => f.nombre)).toEqual(["Efectivo", "Cheque", "Transferencia"]);

    await actualizarFormaPago(cheque.id, { oculta: true, nombre: "Cheque diferido" });
    expect((await listarFormasPago()).map((f) => f.nombre)).toEqual(["Efectivo", "Transferencia"]);
    expect((await listarFormasPago(true)).find((f) => f.id === cheque.id)).toMatchObject({ nombre: "Cheque diferido", oculta: true });

    await guardarCompraManual(bidon(null, transferencia.id), "Martín", null);
    expect((await listarFormasPago()).find((f) => f.id === transferencia.id)!.compras).toBe(1);
    await expect(borrarFormaPago(transferencia.id)).rejects.toThrow("Se usó en compras");
    await borrarFormaPago(cheque.id);
    expect(await listarFormasPago(true)).toHaveLength(2);
    await expect(guardarCompraManual(bidon(null, cheque.id), "Martín", null)).rejects.toThrow("Esa forma de pago ya no existe");
  });

  it("se preelige la que dice la factura o, si no dice, la habitual del proveedor; la elegida a mano se respeta", async () => {
    const [efectivo, transferencia] = await db
      .insert(formaPago)
      .values([
        { nombre: "Efectivo", clave: "efectivo", medio: "efectivo", orden: 1 },
        { nombre: "Transferencia", clave: "transferencia", medio: "transferencia", orden: 2 },
      ])
      .returning();

    const dice = await factura("1", "efectivo");
    expect(dice.formaPagoId).toBe(efectivo.id);
    const noDice = await factura("2");
    expect(noDice.formaPagoId).toBeNull();

    // Cabrales paga siempre por transferencia: las facturas que no dicen nada la toman.
    await actualizarProveedor(noDice.proveedorId!, { formaPagoId: transferencia.id });
    expect((await factura("3")).formaPagoId).toBe(transferencia.id);
    // Una forma oculta no se preelige: queda la habitual.
    await actualizarFormaPago(efectivo.id, { oculta: true });
    expect((await factura("4", "efectivo")).formaPagoId).toBe(transferencia.id);

    // Al corregir, la que se eligió a mano no cambia; la que no tenía, se completa.
    await fijarFormaPago(dice.id, null);
    await actualizarDatos(noDice.id, (await obtenerComprobante(noDice.id))!.datos);
    expect((await obtenerComprobante(noDice.id))!.fila.formaPagoId).toBe(transferencia.id);
    await fijarFormaPago(noDice.id, efectivo.id);
    await actualizarDatos(noDice.id, (await obtenerComprobante(noDice.id))!.datos);
    expect((await obtenerComprobante(noDice.id))!.fila.formaPagoId).toBe(efectivo.id);
  });
});

describe("formas de pago desde el panel", () => {
  const HOST = "comprascoff.saboryaroma.com";
  let app: FastifyInstance;
  let headers: Record<string, string> = {};

  beforeEach(async () => {
    await baseLimpia();
    await asegurarAcceso();
    app = await crearServidor();
    await crearUsuario("Martín", "4321");
    const r = await app.inject({ method: "POST", url: "/api/c/ingresar", headers: { host: HOST }, payload: { clave: "4321" } });
    headers = { host: HOST, cookie: `compras_sesion=${r.cookies.find((c) => c.name === "compras_sesion")!.value}` };
  });
  afterEach(async () => app.close());

  it("se administran, se eligen en cada compra y la ficha del proveedor suma lo de este mes por forma", async () => {
    const efectivo = (await app.inject({ method: "POST", url: "/api/c/formas-pago", headers, payload: { nombre: "Efectivo" } })).json();
    const mp = (await app.inject({ method: "POST", url: "/api/c/formas-pago", headers, payload: { nombre: "Mercado Pago" } })).json();
    expect((await app.inject({ method: "POST", url: "/api/c/formas-pago", headers, payload: { nombre: "efectivo" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/c/formas-pago/${mp.id}/mover`, headers, payload: { paso: -1 } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/c/formas-pago", headers })).json().map((f: { nombre: string }) => f.nombre)).toEqual(["Mercado Pago", "Efectivo"]);

    const aguas = await crearProveedor("Aguas del barrio", "", mp.id);
    await guardarCompraManual(bidon(aguas.id, efectivo.id), "Martín", null);
    await guardarCompraManual(bidon(aguas.id, null), "Martín", null);
    const factura = await guardarCompraManual(bidon(aguas.id, null), "Martín", null);

    expect((await app.inject({ method: "PUT", url: `/api/c/compras/${factura}/forma-pago`, headers, payload: { formaPagoId: mp.id } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/c/compras/${factura}/forma-pago`, headers, payload: { formaPagoId: 999 } })).statusCode).toBe(400);
    const { compras } = (await app.inject({ url: "/api/c/compras?estado=confirmado", headers })).json();
    expect(compras.map((c: { formaPago: string | null }) => c.formaPago)).toEqual(["Mercado Pago", null, "Efectivo"]);

    const ficha = (await app.inject({ url: `/api/c/proveedores/${aguas.id}`, headers })).json();
    expect(ficha.formaPagoId).toBe(mp.id);
    expect(ficha.pagos).toEqual([
      { forma: "Mercado Pago", total: 14000 },
      { forma: "Efectivo", total: 14000 },
      { forma: null, total: 14000 },
    ]);

    expect((await app.inject({ method: "PUT", url: `/api/c/proveedores/${aguas.id}`, headers, payload: { formaPagoId: null } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/c/formas-pago/${efectivo.id}`, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/api/c/formas-pago/${efectivo.id}`, headers, payload: { oculta: true } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/c/formas-pago", headers })).json()).toHaveLength(1);
  });
});
