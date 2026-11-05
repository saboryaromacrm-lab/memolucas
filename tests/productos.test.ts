import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { comprobante, precioProducto } from "../src/db/schema.js";
import type { ProductoNormalizado } from "../src/bot/ia-productos.js";
import { controlar, type Comprobante } from "../src/lib/comprobantes.js";
import { costosFinales, preciosDe, variacion } from "../src/lib/precios.js";
import { confirmarComprobante, guardarComprobante } from "../src/servicios/compras.js";
import { actualizarCompra, actualizarProducto, juntarProductos, listarProductos, obtenerProducto, procesarPendientes, productosCsv, separarAlias } from "../src/servicios/productos.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const normalizarRenglones = vi.fn<(...a: unknown[]) => Promise<ProductoNormalizado[]>>();
vi.mock("../src/bot/ia-productos.js", async (orig) => ({ ...(await orig<object>()), normalizarRenglones: (...a: unknown[]) => normalizarRenglones(...a) }));

/** La factura de Salta Refrescos: los renglones ya traen IVA e impuesto interno. */
function salta(cambios: { numero?: string; fecha?: string; precio?: number } = {}): Comprobante {
  const f = facturaDePrueba();
  const precio = cambios.precio ?? 12499.93;
  f.encabezado = { ...f.encabezado, razonSocialEmisor: "SALTA REFRESCOS S.A.", cuitEmisor: "30-51840868-9", puntoVenta: "5693", numero: cambios.numero ?? "00112896", fecha: cambios.fecha ?? "2026-10-28" };
  f.renglones = [{ ...f.renglones[0], codigo: "2780", descripcion: "BENEDICTINO C/GAS 500*15 VR", cantidad: 2, unidad: "UN", unidadesPorBulto: 0, precioUnitario: precio, descuentos: [], importe: precio * 2 }];
  f.pie = { subtotal: 0, bonificacionPct: 0, bonificacionImporte: 0, ivas: [], percepciones: [{ nombre: "Percepc. IVA", tipo: "iva", alicuota: 0, importe: 500 }], impuestosInternos: 0, otrosImpuestos: 0, total: precio * 2 + 500 };
  return f;
}
const benedictino: ProductoNormalizado = { renglon: 1, nombre: "Agua Benedictino con gas 500 ml", categoria: "Bebidas", unidadCompra: "bulto", unidadesPorBulto: 15, contenido: 0.5, medida: "l" };

async function confirmada(c: Comprobante) {
  const { comprobante: datos, cierra } = controlar(c);
  const fila = await guardarComprobante({ chat: null, autor: "Martín", origen: "panel", datos, cierra, modelo: null, adjuntoIds: [] });
  await confirmarComprobante(fila.id);
  return fila;
}

describe("precios por unidad", () => {
  it("factura A con renglones netos: suma el IVA de cada renglón y no las percepciones", () => {
    const costos = costosFinales(facturaDePrueba());
    expect(costos[0]).toBeCloseTo(135000 * 1.21, 2);
    expect(costos[1]).toBeCloseTo(24000 * 1.21, 2);
  });

  it("renglones que ya traen los impuestos (Salta Refrescos): queda el importe tal cual", () => {
    expect(costosFinales(salta())[0]).toBeCloseTo(24999.86, 2);
  });

  it("la bonificación general baja el costo de cada renglón", () => {
    const f = facturaDePrueba();
    f.pie = { ...f.pie, bonificacionImporte: 15900, ivas: [{ alicuota: 21, importe: 30051 }], percepciones: [], total: 173151 };
    const costos = costosFinales(f);
    expect(costos[0] + costos[1]).toBeCloseTo(173151, 2);
    expect(costos[0]).toBeCloseTo(135000 * 0.9 * 1.21, 0);
  });

  it("por bulto, por unidad y por litro", () => {
    const p = preciosDe({ costoFinal: 24999.86, cantidad: 2, unidadCompra: "bulto", unidadesPorBulto: 15 }, { contenido: 0.5, medida: "l" });
    expect(p.bulto).toBeCloseTo(12499.93, 2);
    expect(p.unidad).toBeCloseTo(833.33, 2);
    expect(p.porMedida).toEqual({ valor: expect.closeTo(1666.66, 1), medida: "l" });
    const kg = preciosDe({ costoFinal: 30000, cantidad: 2, unidadCompra: "kg", unidadesPorBulto: 0 }, { contenido: null, medida: null });
    expect(kg).toEqual({ bulto: null, unidad: null, porMedida: { valor: 15000, medida: "kg" } });
  });

  it("la variación solo compara precios comparables", () => {
    const antes = preciosDe({ costoFinal: 1000, cantidad: 1, unidadCompra: "unidad", unidadesPorBulto: 0 }, { contenido: null, medida: null });
    const ahora = preciosDe({ costoFinal: 1100, cantidad: 1, unidadCompra: "unidad", unidadesPorBulto: 0 }, { contenido: null, medida: null });
    expect(variacion(ahora, antes)).toBeCloseTo(10, 5);
    const porKg = preciosDe({ costoFinal: 1100, cantidad: 1, unidadCompra: "kg", unidadesPorBulto: 0 }, { contenido: null, medida: null });
    expect(variacion(porKg, antes)).toBeNull();
  });
});

describe("productos", () => {
  beforeEach(async () => {
    await baseLimpia();
    normalizarRenglones.mockReset();
  });

  it("las facturas confirmadas pasan a Productos; la segunda compra no usa la IA y marca la suba", async () => {
    normalizarRenglones.mockResolvedValue([benedictino]);
    await confirmada(salta());
    // Una sin confirmar no entra.
    const { comprobante: pendiente } = controlar(salta({ numero: "00112999" }));
    await guardarComprobante({ chat: null, autor: null, origen: "panel", datos: pendiente, cierra: true, modelo: null, adjuntoIds: [] });
    await procesarPendientes();

    let [p] = await listarProductos();
    expect(p).toMatchObject({ nombre: "Agua Benedictino con gas 500 ml", categoria: "Bebidas", compras: 1, alerta: false });
    expect(p.ultima!.precios.unidad).toBeCloseTo(833.33, 2);
    expect(p.ultima!.precios.porMedida!.valor).toBeCloseTo(1666.66, 1);

    await confirmada(salta({ numero: "00113000", fecha: "2026-11-04", precio: 13999.92 }));
    await procesarPendientes();
    expect(normalizarRenglones).toHaveBeenCalledTimes(1);
    [p] = await listarProductos();
    expect(p.compras).toBe(2);
    expect(p.variacion).toBeCloseTo(12, 0);
    expect(p.alerta).toBe(true);
    expect(p.ultima!.unidadesPorBulto).toBe(15); // Lo toma de la compra anterior del mismo renglón.
  });

  it("si la IA falla se reintenta en la próxima vuelta", async () => {
    normalizarRenglones.mockRejectedValueOnce(new Error("caída")).mockResolvedValueOnce([benedictino]);
    const fila = await confirmada(salta());
    await procesarPendientes();
    expect(await listarProductos()).toHaveLength(0);
    await procesarPendientes();
    expect(await listarProductos()).toHaveLength(1);
    const [c] = await db.select().from(comprobante).where(eq(comprobante.id, fila.id));
    expect(c.productosEn).not.toBeNull();
  });

  it("notas de crédito y remitos no cargan precios", async () => {
    const nc = salta();
    nc.encabezado.tipo = "nota_credito";
    await confirmada(nc);
    await procesarPendientes();
    expect(normalizarRenglones).not.toHaveBeenCalled();
    expect(await db.select().from(precioProducto)).toHaveLength(0);
  });

  it("el mismo producto de otro proveedor se junta; se puede separar, juntar y corregir", async () => {
    normalizarRenglones.mockResolvedValue([benedictino]);
    await confirmada(salta());
    const otro = salta({ numero: "00000001" });
    otro.encabezado = { ...otro.encabezado, razonSocialEmisor: "Distribuidora Norte", cuitEmisor: "30-11111111-1" };
    await confirmada(otro);
    await procesarPendientes();
    let lista = await listarProductos();
    expect(lista).toHaveLength(1);
    expect(lista[0].proveedores.map((x) => x.proveedor).sort()).toEqual(["Distribuidora Norte", "SALTA REFRESCOS S.A."]);

    const detalle = await obtenerProducto(lista[0].id);
    const nuevoId = await separarAlias(detalle.id, detalle.alias.find((a) => a.proveedor === "Distribuidora Norte")!.clave);
    expect(await listarProductos()).toHaveLength(2);
    await juntarProductos(nuevoId, detalle.id);
    lista = await listarProductos();
    expect(lista).toHaveLength(1);

    // Corregir el contenido recalcula todos sus precios; corregir una compra también.
    await actualizarProducto(detalle.id, { contenido: 1, medida: "l" });
    lista = await listarProductos();
    expect(lista[0].ultima!.precios.porMedida!.valor).toBeCloseTo(833.33, 2);
    await actualizarCompra(lista[0].ultima!.id, { unidadesPorBulto: 12 });
    lista = await listarProductos();
    expect(lista[0].ultima!.precios.unidad).toBeCloseTo(12499.93 / 12, 2);

    await expect(actualizarProducto(nuevoId, { nombre: "x" })).rejects.toThrow("No existe"); // Ya se juntó con el otro.
    const csv = await productosCsv();
    expect(csv).toContain("Agua Benedictino con gas 500 ml");
    expect(csv).toContain("1041,66"); // Precio por unidad con coma decimal.
  });
});
