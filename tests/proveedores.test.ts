import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { comprobante, proveedor } from "../src/db/schema.js";
import type { ProductoNormalizado } from "../src/bot/ia-productos.js";
import { controlar } from "../src/lib/comprobantes.js";
import { asegurarAcceso } from "../src/http/rutas/auth.js";
import { crearServidor } from "../src/http/servidor.js";
import { confirmarComprobante, guardarComprobante, listarComprobantes, vincularProveedores } from "../src/servicios/compras.js";
import { guardarCompraManual } from "../src/servicios/compras-manuales.js";
import { crearUsuario } from "../src/servicios/panel-compras.js";
import { listarProductos, procesarPendientes, productosDeProveedor } from "../src/servicios/productos.js";
import { actualizarProveedor, borrarProveedor, crearProveedor, juntarProveedores, listarProveedores, obtenerProveedor } from "../src/servicios/proveedores.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const normalizarRenglones = vi.fn<(...a: unknown[]) => Promise<ProductoNormalizado[]>>();
vi.mock("../src/bot/ia-productos.js", async (orig) => ({ ...(await orig<object>()), normalizarRenglones: (...a: unknown[]) => normalizarRenglones(...a) }));

async function factura(numero: string, cambios: { razon?: string; cuit?: string; fecha?: string } = {}) {
  const f = facturaDePrueba();
  f.encabezado = { ...f.encabezado, numero, razonSocialEmisor: cambios.razon ?? f.encabezado.razonSocialEmisor, cuitEmisor: cambios.cuit ?? f.encabezado.cuitEmisor, fecha: cambios.fecha ?? f.encabezado.fecha };
  const { comprobante: datos, cierra } = controlar(f);
  return guardarComprobante({ chat: null, autor: "Martín", origen: "panel", datos, cierra, modelo: null, adjuntoIds: [] });
}

describe("proveedores", () => {
  beforeEach(async () => {
    await baseLimpia();
    normalizarRenglones.mockReset();
  });

  it("se crean solos con las facturas: por CUIT, y si no por nombre", async () => {
    const a = await factura("1");
    const b = await factura("2", { razon: "DISTRIBUIDORA DEL CAFE SA (otra forma de escribirlo)" }); // Mismo CUIT.
    const c = await factura("3", { razon: "Lácteos La Vaquita SRL", cuit: "" });
    const d = await factura("4", { razon: "lacteos la vaquita srl", cuit: "" }); // Mismo nombre normalizado.
    expect(a.proveedorId).toBe(b.proveedorId);
    expect(c.proveedorId).toBe(d.proveedorId);
    expect(a.proveedorId).not.toBe(c.proveedorId);
    const lista = await listarProveedores();
    expect(lista.map((p) => [p.nombre, p.compras])).toEqual([
      ["Distribuidora del Café SA", 2],
      ["Lácteos La Vaquita SRL", 2],
    ]);
  });

  it("un proveedor cargado a mano se completa con el CUIT de su primera factura", async () => {
    const p = await crearProveedor("Distribuidora del Café SA", "Entrega martes");
    const f = await factura("1");
    expect(f.proveedorId).toBe(p.id);
    const [fila] = await db.select().from(proveedor).where(eq(proveedor.id, p.id));
    expect(fila.cuit).toBe("30712345678");
  });

  it("las facturas de antes se vinculan solas al arrancar", async () => {
    const f = await factura("1");
    await db.update(comprobante).set({ proveedorId: null });
    await db.delete(proveedor);
    await vincularProveedores();
    const [c] = await db.select().from(comprobante).where(eq(comprobante.id, f.id));
    expect(c.proveedorId).not.toBeNull();
  });

  it("cambiar el nombre lo cambia en sus compras y en Productos; juntar y borrar", async () => {
    normalizarRenglones.mockResolvedValue([
      { renglon: 1, nombre: "Café en grano 1 kg", categoria: "Café", unidadCompra: "kg", unidadesPorBulto: 0, contenido: 0, medida: "" },
      { renglon: 2, nombre: "Leche entera 1 l", categoria: "Lácteos", unidadCompra: "bulto", unidadesPorBulto: 12, contenido: 1, medida: "l" },
    ]);
    const f = await factura("1", { fecha: new Date().toISOString().slice(0, 10) });
    await confirmarComprobante(f.id);
    await procesarPendientes();
    const id = f.proveedorId!;

    await actualizarProveedor(id, { nombre: "Café Cabrales", notas: "Pedir los lunes" });
    expect((await listarProductos()).every((p) => p.ultima!.proveedor === "Café Cabrales")).toBe(true);
    const [c] = await listarComprobantes();
    expect(c.fila.proveedorId).toBe(id);
    const ficha = await obtenerProveedor(id);
    expect(ficha).toMatchObject({ nombre: "Café Cabrales", notas: "Pedir los lunes", compras: 1, esteMes: 197160 });
    expect((await productosDeProveedor(id)).map((p) => p.nombre)).toEqual(["Café en grano 1 kg", "Leche entera 1 l"]);

    await expect(borrarProveedor(id)).rejects.toThrow("Tiene compras");
    await actualizarProveedor(id, { oculto: true });
    expect(await listarProveedores()).toHaveLength(0);
    expect(await listarProveedores(true)).toHaveLength(1);

    // Juntar: un proveedor cargado a mano con una compra sin factura pasa al de la factura.
    const otro = await crearProveedor("Cabrales (local)");
    await guardarCompraManual(
      { proveedorId: otro.id, fecha: "2026-11-05", renglones: [{ nombre: "Café en grano 1 kg", categoria: "", clase: "mercaderia", cantidad: 1, unidadCompra: "kg", unidadesPorBulto: 0, contenido: null, medida: null, total: 20000 }] },
      "Martín",
      null,
    );
    await juntarProveedores(otro.id, id);
    const juntos = await obtenerProveedor(id);
    expect(juntos.compras).toBe(2);
    const cafe = (await listarProductos()).find((p) => p.nombre === "Café en grano 1 kg")!;
    expect(cafe.proveedores.map((x) => x.proveedor)).toEqual(["Café Cabrales"]);

    const vacio = await crearProveedor("Sin compras");
    await borrarProveedor(vacio.id);
    await expect(crearProveedor("café cabrales")).rejects.toThrow("Ya hay un proveedor con ese nombre");
  });
});

describe("proveedores desde el panel", () => {
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

  it("crea, muestra la ficha con sus compras, renombra, oculta y borra", async () => {
    const creado = await app.inject({ method: "POST", url: "/api/c/proveedores", headers, payload: { nombre: "Aguas del barrio" } });
    expect(creado.statusCode).toBe(200);
    const { id } = creado.json();
    expect((await app.inject({ method: "POST", url: "/api/c/proveedores", headers, payload: { nombre: "aguas del barrio" } })).statusCode).toBe(400);

    let ficha = (await app.inject({ url: `/api/c/proveedores/${id}`, headers })).json();
    expect(ficha).toMatchObject({ nombre: "Aguas del barrio", compras: 0, ultimas: [], productos: [] });
    await guardarCompraManual(
      { proveedorId: id, fecha: "2026-11-05", renglones: [{ nombre: "Bidón de agua 20 l", categoria: "", clase: "gasto", cantidad: 2, unidadCompra: "unidad", unidadesPorBulto: 0, contenido: 20, medida: "l", total: 14000 }] },
      "Martín",
      null,
    );
    ficha = (await app.inject({ url: `/api/c/proveedores/${id}`, headers })).json();
    expect(ficha.compras).toBe(1);
    expect(ficha.ultimas).toMatchObject([{ titulo: "Sin factura", proveedorId: id, proveedor: "Aguas del barrio" }]);
    expect(ficha.productos).toMatchObject([{ nombre: "Bidón de agua 20 l" }]);

    expect((await app.inject({ method: "PUT", url: `/api/c/proveedores/${id}`, headers, payload: { nombre: "Aguas Don Pedro", oculto: true } })).statusCode).toBe(200);
    const compras = (await app.inject({ url: `/api/c/compras?estado=confirmado`, headers })).json().compras;
    expect(compras[0]).toMatchObject({ proveedorId: id, proveedor: "Aguas Don Pedro" });
    expect((await app.inject({ url: "/api/c/proveedores", headers })).json()).toHaveLength(0);
    expect((await app.inject({ url: "/api/c/proveedores?ocultos=1", headers })).json()).toMatchObject([{ id, oculto: true }]);
    expect((await app.inject({ method: "DELETE", url: `/api/c/proveedores/${id}`, headers })).statusCode).toBe(400);
  });
});
