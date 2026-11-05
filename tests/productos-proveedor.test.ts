import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db/index.js";
import { producto, productoAlias } from "../src/db/schema.js";
import type { ProductoNormalizado } from "../src/bot/ia-productos.js";
import { asegurarAcceso } from "../src/http/rutas/auth.js";
import { crearServidor } from "../src/http/servidor.js";
import { controlar, type Comprobante } from "../src/lib/comprobantes.js";
import { confirmarComprobante, guardarComprobante } from "../src/servicios/compras.js";
import { guardarCompraManual } from "../src/servicios/compras-manuales.js";
import { crearUsuario } from "../src/servicios/panel-compras.js";
import { juntarProductos, listarProductos, procesarPendientes, productosDeProveedor, reasignarRenglon } from "../src/servicios/productos.js";
import { crearProveedor, desenlazarProducto, enlazarProducto, juntarProveedores } from "../src/servicios/proveedores.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const normalizarRenglones = vi.fn<(...a: unknown[]) => Promise<ProductoNormalizado[]>>();
vi.mock("../src/bot/ia-productos.js", async (orig) => ({ ...(await orig<object>()), normalizarRenglones: (...a: unknown[]) => normalizarRenglones(...a) }));

const cafe: ProductoNormalizado = { renglon: 1, nombre: "Café en grano 1 kg", categoria: "Café", unidadCompra: "kg", unidadesPorBulto: 0, contenido: 0, medida: "" };
const leche: ProductoNormalizado = { renglon: 2, nombre: "Leche entera 1 l", categoria: "Lácteos", unidadCompra: "bulto", unidadesPorBulto: 12, contenido: 1, medida: "l" };

/** Una factura confirmada y pasada a Productos (por defecto, de Distribuidora del Café con café y leche). */
async function confirmada(numero: string, cambios: (f: Comprobante) => void = () => {}) {
  const f = facturaDePrueba();
  f.encabezado = { ...f.encabezado, numero };
  cambios(f);
  const { comprobante: datos, cierra } = controlar(f);
  const fila = await guardarComprobante({ chat: null, autor: "Martín", origen: "panel", datos, cierra, modelo: null, adjuntoIds: [] });
  await confirmarComprobante(fila.id);
  await procesarPendientes();
  return fila;
}

const nombres = (l: { nombre: string }[]) => l.map((x) => x.nombre);

describe("productos de cada proveedor", () => {
  beforeEach(async () => {
    await baseLimpia();
    normalizarRenglones.mockReset();
  });

  it("cada compra enlaza sus productos con el proveedor, y la IA recibe primero los de ese proveedor", async () => {
    normalizarRenglones.mockResolvedValueOnce([cafe, leche]);
    const f = await confirmada("1");
    expect(nombres(await productosDeProveedor(f.proveedorId!))).toEqual(["Café en grano 1 kg", "Leche entera 1 l"]);

    // Otro proveedor vende la misma leche: queda enlazada a los dos y la IA la tenía entre los "otros".
    normalizarRenglones.mockResolvedValueOnce([{ ...leche, renglon: 1 }]);
    const otra = await confirmada("2", (x) => {
      x.encabezado = { ...x.encabezado, razonSocialEmisor: "Lácteos La Vaquita", cuitEmisor: "30-11111111-1" };
      x.renglones = [{ ...x.renglones[1], codigo: "VQ1" }];
      x.pie = { ...x.pie, subtotal: 24000, ivas: [{ alicuota: 21, importe: 5040 }], percepciones: [], total: 29040 };
    });
    const existentes = normalizarRenglones.mock.calls[1][3] as { delProveedor: { nombre: string }[]; otros: { nombre: string }[] };
    expect(existentes.delProveedor).toEqual([]);
    expect(nombres(existentes.otros).sort()).toEqual(["Café en grano 1 kg", "Leche entera 1 l"]);

    const lecheEnLista = (await listarProductos()).find((p) => p.nombre === "Leche entera 1 l")!;
    expect(lecheEnLista.proveedores.map((x) => [x.proveedor, x.compras])).toEqual([
      ["Distribuidora del Café SA", 1],
      ["Lácteos La Vaquita", 1],
    ]);
    expect(lecheEnLista.proveedores.every((x) => x.ultima?.proveedorId === x.proveedorId)).toBe(true);

    // Un renglón nuevo de la Vaquita: la IA recibe la leche como producto de ese proveedor.
    normalizarRenglones.mockResolvedValueOnce([{ ...cafe, renglon: 1 }]);
    await confirmada("3", (x) => {
      x.encabezado = { ...x.encabezado, razonSocialEmisor: "Lácteos La Vaquita", cuitEmisor: "30-11111111-1" };
      x.renglones = [{ ...x.renglones[0], codigo: "VQ2" }];
      x.pie = { ...x.pie, subtotal: 135000, ivas: [{ alicuota: 21, importe: 28350 }], percepciones: [], total: 163350 };
    });
    const segunda = normalizarRenglones.mock.calls[2][3] as typeof existentes;
    expect(nombres(segunda.delProveedor)).toEqual(["Leche entera 1 l"]);
    expect(nombres(segunda.otros)).toEqual(["Café en grano 1 kg"]);
    expect(nombres(await productosDeProveedor(otra.proveedorId!))).toEqual(["Café en grano 1 kg", "Leche entera 1 l"]);
  });

  it("se enlazan y se quitan a mano; juntar productos o proveedores conserva los enlaces", async () => {
    normalizarRenglones.mockResolvedValueOnce([cafe, leche]);
    const f = await confirmada("1");
    const nuevo = await crearProveedor("Almacén de la esquina");
    const [lecheId, cafeId] = [(await listarProductos()).find((p) => p.nombre === "Leche entera 1 l")!.id, (await listarProductos()).find((p) => p.nombre === "Café en grano 1 kg")!.id];

    await enlazarProducto(nuevo.id, lecheId);
    expect(await productosDeProveedor(nuevo.id)).toEqual([{ id: lecheId, nombre: "Leche entera 1 l", categoria: "Lácteos", compras: 0, ultima: null }]);
    await expect(enlazarProducto(nuevo.id, 999)).rejects.toThrow("No existe ese producto");

    // Quitado a mano: sus compras quedan, pero ya no figura como producto del proveedor.
    await desenlazarProducto(f.proveedorId!, cafeId);
    expect(nombres(await productosDeProveedor(f.proveedorId!))).toEqual(["Leche entera 1 l"]);
    expect((await listarProductos()).find((p) => p.id === cafeId)!.compras).toBe(1);

    // Una compra sin factura al almacén de café: vuelve a quedar enlazado solo.
    await guardarCompraManual(
      { proveedorId: nuevo.id, formaPagoId: null, fecha: "2026-11-05", renglones: [{ nombre: "Café en grano 1 kg", categoria: "", clase: "mercaderia", cantidad: 1, unidadCompra: "kg", unidadesPorBulto: 0, contenido: null, medida: null, total: 20000 }] },
      "Martín",
      null,
    );
    expect((await productosDeProveedor(nuevo.id)).map((p) => [p.nombre, p.compras])).toEqual([
      ["Café en grano 1 kg", 1],
      ["Leche entera 1 l", 0],
    ]);

    await juntarProductos(lecheId, cafeId);
    expect(nombres(await productosDeProveedor(f.proveedorId!))).toEqual(["Café en grano 1 kg"]);
    await juntarProveedores(nuevo.id, f.proveedorId!);
    expect((await productosDeProveedor(f.proveedorId!)).map((p) => [p.nombre, p.compras])).toEqual([["Café en grano 1 kg", 3]]);
  });

  it("corregir el producto de un renglón mueve sus compras, el alias y el enlace", async () => {
    normalizarRenglones.mockResolvedValueOnce([cafe, { ...leche, nombre: "Leche descremada 1 l" }]);
    const f = await confirmada("1");
    normalizarRenglones.mockResolvedValueOnce([{ ...leche, renglon: 1 }]);
    await confirmada("9", (x) => {
      x.encabezado = { ...x.encabezado, razonSocialEmisor: "Lácteos La Vaquita", cuitEmisor: "30-11111111-1" };
      x.renglones = [x.renglones[1]];
      x.pie = { ...x.pie, subtotal: 24000, ivas: [{ alicuota: 21, importe: 5040 }], percepciones: [], total: 29040 };
    });
    const entera = (await listarProductos()).find((p) => p.nombre === "Leche entera 1 l")!;

    await reasignarRenglon(f.id, 2, entera.id);
    // La descremada quedó sin compras y se borró; la entera la vende ahora también la distribuidora.
    expect(nombres(await listarProductos())).toEqual(["Café en grano 1 kg", "Leche entera 1 l"]);
    expect(nombres(await productosDeProveedor(f.proveedorId!))).toEqual(["Café en grano 1 kg", "Leche entera 1 l"]);
    expect((await db.select().from(productoAlias)).filter((a) => a.productoId === entera.id)).toHaveLength(2);

    // La próxima factura con el mismo renglón ya va a la entera, sin pasar por la IA.
    await confirmada("2");
    expect(normalizarRenglones).toHaveBeenCalledTimes(2);
    expect((await listarProductos()).find((p) => p.id === entera.id)!.compras).toBe(3);

    await expect(reasignarRenglon(f.id, 7, entera.id)).rejects.toThrow("Ese renglón todavía no pasó a Productos");
    await expect(reasignarRenglon(f.id, 1, 999)).rejects.toThrow("No existe ese producto");
    expect(await db.select().from(producto)).toHaveLength(2);
  });
});

describe("productos de cada proveedor desde el panel", () => {
  const HOST = "comprascoff.saboryaroma.com";
  let app: FastifyInstance;
  let headers: Record<string, string> = {};

  beforeEach(async () => {
    await baseLimpia();
    normalizarRenglones.mockReset();
    await asegurarAcceso();
    app = await crearServidor();
    await crearUsuario("Martín", "4321");
    const r = await app.inject({ method: "POST", url: "/api/c/ingresar", headers: { host: HOST }, payload: { clave: "4321" } });
    headers = { host: HOST, cookie: `compras_sesion=${r.cookies.find((c) => c.name === "compras_sesion")!.value}` };
  });
  afterEach(async () => app.close());

  it("muestra a qué producto fue cada renglón, lo corrige y enlaza o quita productos del proveedor", async () => {
    normalizarRenglones.mockResolvedValueOnce([cafe, leche]);
    const f = await confirmada("1");
    const detalle = (await app.inject({ url: `/api/c/compras/${f.id}`, headers })).json();
    expect(detalle.productos.map((x: { renglon: number; nombre: string }) => [x.renglon, x.nombre])).toEqual([
      [1, "Café en grano 1 kg"],
      [2, "Leche entera 1 l"],
    ]);
    const [cafeId, lecheId] = detalle.productos.map((x: { productoId: number }) => x.productoId);

    expect((await app.inject({ method: "PUT", url: `/api/c/compras/${f.id}/renglones/2/producto`, headers, payload: { productoId: cafeId } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/c/compras/${f.id}`, headers })).json().productos.map((x: { productoId: number }) => x.productoId)).toEqual([cafeId, cafeId]);
    expect((await app.inject({ method: "PUT", url: `/api/c/compras/${f.id}/renglones/2/producto`, headers, payload: { productoId: lecheId } })).statusCode).toBe(400);

    const almacen = await crearProveedor("Almacén");
    expect((await app.inject({ method: "POST", url: `/api/c/proveedores/${almacen.id}/productos`, headers, payload: { productoId: cafeId } })).statusCode).toBe(200);
    let ficha = (await app.inject({ url: `/api/c/proveedores/${almacen.id}`, headers })).json();
    expect(ficha.productos).toEqual([{ id: cafeId, nombre: "Café en grano 1 kg", categoria: "Café", compras: 0, ultima: null }]);
    expect((await app.inject({ method: "DELETE", url: `/api/c/proveedores/${almacen.id}/productos/${cafeId}`, headers })).statusCode).toBe(200);
    ficha = (await app.inject({ url: `/api/c/proveedores/${almacen.id}`, headers })).json();
    expect(ficha.productos).toEqual([]);

    const { productos } = (await app.inject({ url: "/api/c/productos", headers })).json();
    expect(productos[0].proveedores).toMatchObject([{ proveedorId: f.proveedorId, proveedor: "Distribuidora del Café SA", oculto: false, compras: 2 }]);
  });
});
