import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ProductoNormalizado } from "../src/bot/ia-productos.js";
import { asegurarAcceso } from "../src/http/rutas/auth.js";
import { crearServidor } from "../src/http/servidor.js";
import { controlar, type Comprobante } from "../src/lib/comprobantes.js";
import { confirmarComprobante, descartarComprobante, guardarComprobante } from "../src/servicios/compras.js";
import { guardarCompraManual } from "../src/servicios/compras-manuales.js";
import { metricas, periodoAnterior } from "../src/servicios/metricas.js";
import { actualizarUsuario, crearUsuario } from "../src/servicios/panel-compras.js";
import { procesarPendientes } from "../src/servicios/productos.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const normalizarRenglones = vi.fn<(...a: unknown[]) => Promise<ProductoNormalizado[]>>();
vi.mock("../src/bot/ia-productos.js", async (orig) => ({ ...(await orig<object>()), normalizarRenglones: (...a: unknown[]) => normalizarRenglones(...a) }));

const OCTUBRE = { desde: "2026-10-01", hasta: "2026-10-31" };

/** Guarda un comprobante a partir de la factura de prueba (Distribuidora del Café, 28/10, $ 197.160). */
async function comprobanteDe(cambiar: (f: Comprobante) => void, confirmar = true) {
  const f = facturaDePrueba();
  cambiar(f);
  const { comprobante: datos, cierra } = controlar(f);
  const fila = await guardarComprobante({ chat: null, autor: "Martín", origen: "panel", datos, cierra, modelo: null, adjuntoIds: [] });
  if (confirmar) await confirmarComprobante(fila.id);
  return fila;
}

/** Septiembre: el café más barato. Octubre: la factura de prueba, una nota de crédito, un remito, una en dólares,
 * una sin factura, una sin confirmar de otro proveedor y una descartada. */
async function cargarCompras() {
  normalizarRenglones.mockResolvedValueOnce([
    { renglon: 1, nombre: "Café en grano 1 kg", categoria: "Café", unidadCompra: "kg", unidadesPorBulto: 0, contenido: 0, medida: "" },
    { renglon: 2, nombre: "Leche entera 1 l", categoria: "Lácteos", unidadCompra: "bulto", unidadesPorBulto: 12, contenido: 1, medida: "l" },
  ]);
  await comprobanteDe((f) => {
    f.encabezado = { ...f.encabezado, numero: "1", fecha: "2026-09-15" };
    f.renglones[0] = { ...f.renglones[0], importe: 120000 };
    f.pie = { ...f.pie, subtotal: 144000, ivas: [{ alicuota: 21, importe: 30240 }], percepciones: [{ nombre: "Perc. IIBB", tipo: "iibb", alicuota: 3, importe: 4320 }], total: 178560 };
  });
  await procesarPendientes();
  await comprobanteDe((f) => (f.encabezado = { ...f.encabezado, numero: "2" }));
  await comprobanteDe((f) => {
    f.encabezado = { ...f.encabezado, tipo: "nota_credito", numero: "3", fecha: "2026-10-29" };
    f.renglones = [{ ...f.renglones[0], descripcion: "Devolución", cantidad: 1, importe: 10000 }];
    f.pie = { ...f.pie, subtotal: 10000, ivas: [{ alicuota: 21, importe: 2100 }], percepciones: [], total: 12100 };
  });
  await comprobanteDe((f) => (f.encabezado = { ...f.encabezado, tipo: "remito", numero: "4", fecha: "2026-10-29" }));
  await comprobanteDe((f) => {
    f.encabezado = { ...f.encabezado, numero: "5", moneda: "DOL", razonSocialEmisor: "Import SA", cuitEmisor: "30-22222222-2" };
    f.renglones = [{ ...f.renglones[0], importe: 100, alicuotaIva: 0 }];
    f.pie = { ...f.pie, subtotal: 100, ivas: [], percepciones: [], total: 100 };
  });
  await guardarCompraManual(
    { proveedorId: null, formaPagoId: null, fecha: "2026-10-10", renglones: [{ nombre: "Bidón de agua 20 l", categoria: "Bebidas", clase: "gasto", cantidad: 2, unidadCompra: "unidad", unidadesPorBulto: 0, contenido: 20, medida: "l", total: 14000 }] },
    "Sofi",
    null,
  );
  const vaquita = (f: Comprobante, numero: string) => {
    f.encabezado = { ...f.encabezado, numero, razonSocialEmisor: "Lácteos La Vaquita", cuitEmisor: "30-11111111-1" };
    f.renglones = [f.renglones[1]];
    f.pie = { ...f.pie, subtotal: 24000, ivas: [{ alicuota: 21, importe: 5040 }], percepciones: [], total: 29040 };
  };
  await comprobanteDe((f) => vaquita(f, "6"), false);
  const descartada = await comprobanteDe((f) => vaquita(f, "7"), false);
  await descartarComprobante(descartada.id);
  await procesarPendientes();
}

describe("métricas de compras", () => {
  beforeEach(async () => {
    await baseLimpia();
    normalizarRenglones.mockReset();
  });

  it("compara con los mismos meses de antes, o con los mismos días", () => {
    expect(periodoAnterior(OCTUBRE)).toEqual({ desde: "2026-09-01", hasta: "2026-09-30" });
    expect(periodoAnterior({ desde: "2026-09-01", hasta: "2026-11-30" })).toEqual({ desde: "2026-06-01", hasta: "2026-08-31" });
    expect(periodoAnterior({ desde: "2026-01-01", hasta: "2026-12-31" })).toEqual({ desde: "2025-01-01", hasta: "2025-12-31" });
    expect(periodoAnterior({ desde: "2026-10-11", hasta: "2026-10-20" })).toEqual({ desde: "2026-10-01", hasta: "2026-10-10" });
  });

  it("suma en pesos por fecha de factura: la nota de crédito resta, el remito y los dólares van aparte", async () => {
    await cargarCompras();
    const m = await metricas(OCTUBRE, false);

    expect(m.resumen).toMatchObject({ total: 228100, compras: 3, proveedores: 2, mercaderia: 214100, gasto: 14000 });
    expect(m.resumen.promedio).toBeCloseTo(76033.33, 2);
    expect(m.resumenAnterior).toMatchObject({ total: 178560, compras: 1, mercaderia: 178560, gasto: 0 });
    expect(m.remitos).toBe(1);
    expect(m.dolares).toEqual({ total: 100, compras: 1 });

    expect(m.proveedores.map((g) => [g.nombre, g.total, g.compras])).toEqual([
      ["Distribuidora del Café SA", 185060, 1],
      ["Lácteos La Vaquita", 29040, 1],
      ["Sin proveedor", 14000, 1],
    ]);
    expect(m.proveedores[0].variacion).toBeCloseTo(3.64, 2);
    expect(m.proveedores[1].variacion).toBeNull();

    // Café: de $ 14.520 a $ 16.335 el kg (+12,5 %); la leche no cambió. Pesado por lo gastado: +10,61 %.
    expect(m.subas.map((s) => [s.nombre, Math.round(s.variacion * 10) / 10])).toEqual([["Café en grano 1 kg", 12.5]]);
    expect(m.bajas).toEqual([]);
    expect(m.resumen.inflacion).toBeCloseTo(10.61, 2);
    expect(m.inflacionPorMes).toEqual([{ mes: "2026-10", variacion: expect.closeTo(10.61, 2) }]);
    expect(m.categorias.map((c) => [c.nombre, c.total])).toEqual([
      ["Café", 163350],
      ["Lácteos", 29040],
      ["Bebidas", 14000],
    ]);

    expect(m.impuestos).toEqual({ ivas: [{ alicuota: 21, importe: 36330 }], percepciones: [{ nombre: "Percepciones de IIBB", importe: 4770 }], internos: 0, otros: 0 });
    expect(m.formasPago).toEqual([{ id: null, nombre: "Sin especificar", total: 228100, compras: 3 }]);
    expect(m.origen.map((g) => [g.nombre, g.total])).toEqual([
      ["Con factura", 214100],
      ["Sin factura", 14000],
    ]);
    expect(m.autores.map((g) => g.nombre)).toEqual(["Martín", "Sofi"]);
    expect(m.tipos[0]).toMatchObject({ nombre: "Factura A", total: 226200, compras: 2 });

    expect(m.evolucion.porDia).toBe(true);
    expect(m.evolucion.barras).toHaveLength(31);
    expect(m.evolucion.barras.find((b) => b.clave === "2026-10-28")).toEqual({ clave: "2026-10-28", mercaderia: 226200, gasto: 0 });

    // Solo confirmadas: queda afuera la de la Vaquita.
    expect((await metricas(OCTUBRE, true)).resumen.total).toBe(199060);
    // Un trimestre va por mes.
    expect((await metricas({ desde: "2026-08-01", hasta: "2026-10-31" }, false)).evolucion.barras.map((b) => b.clave)).toEqual(["2026-08", "2026-09", "2026-10"]);
  });
});

describe("métricas desde el panel", () => {
  const HOST = "comprascoff.saboryaroma.com";
  let app: FastifyInstance;
  let headers: Record<string, string> = {};
  let usuarioId = 0;

  beforeEach(async () => {
    await baseLimpia();
    normalizarRenglones.mockReset();
    await asegurarAcceso();
    app = await crearServidor();
    usuarioId = (await crearUsuario("Martín", "4321")).id;
    const r = await app.inject({ method: "POST", url: "/api/c/ingresar", headers: { host: HOST }, payload: { clave: "4321" } });
    headers = { host: HOST, cookie: `compras_sesion=${r.cookies.find((c) => c.name === "compras_sesion")!.value}` };
  });
  afterEach(async () => app.close());

  it("solo para quien la tiene permitida; también en Excel, y Facturas filtra por mes", async () => {
    await cargarCompras();
    const url = "/api/c/metricas?desde=2026-10-01&hasta=2026-10-31";
    expect((await app.inject({ url: "/api/c/yo", headers })).json()).toEqual({ nombre: "Martín", metricas: false });
    expect((await app.inject({ url, headers })).statusCode).toBe(403);

    await actualizarUsuario(usuarioId, { metricas: true });
    expect((await app.inject({ url: "/api/c/yo", headers })).json().metricas).toBe(true);
    expect((await app.inject({ url: `${url}&confirmadas=1`, headers })).json().resumen.total).toBe(199060);
    expect((await app.inject({ url: "/api/c/metricas?desde=2026-10-31&hasta=2026-10-01", headers })).statusCode).toBe(400);

    const excel = await app.inject({ url: url.replace("/metricas?", "/metricas.csv?"), headers });
    expect(excel.headers["content-type"]).toContain("text/csv");
    expect(excel.body).toContain('"Por proveedor"');
    expect(excel.body).toContain('"Distribuidora del Café SA";185060,00;1;3,64');

    const septiembre = (await app.inject({ url: "/api/c/compras?periodo=2026-09", headers })).json();
    expect(septiembre.compras).toHaveLength(1);
    expect((await app.inject({ url: "/api/c/compras?periodo=2026-10-10", headers })).json().compras.map((c: { titulo: string }) => c.titulo)).toEqual(["Sin factura"]);
  });
});
