import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { strFromU8, unzipSync } from "fflate";
import type { ProductoNormalizado } from "../src/bot/ia-productos.js";
import { asegurarAcceso } from "../src/http/rutas/auth.js";
import { crearServidor } from "../src/http/servidor.js";
import { controlar, type Comprobante } from "../src/lib/comprobantes.js";
import { guardarImagen } from "../src/servicios/adjuntos.js";
import { confirmarComprobante, descartarComprobante, guardarComprobante } from "../src/servicios/compras.js";
import { guardarCompraManual } from "../src/servicios/compras-manuales.js";
import { actualizarUsuario, crearUsuario } from "../src/servicios/panel-compras.js";
import { procesarPendientes } from "../src/servicios/productos.js";
import { crearFormaPago } from "../src/servicios/formas-pago.js";
import { crearProveedor } from "../src/servicios/proveedores.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const normalizarRenglones = vi.fn<(...a: unknown[]) => Promise<ProductoNormalizado[]>>();
vi.mock("../src/bot/ia-productos.js", async (orig) => ({ ...(await orig<object>()), normalizarRenglones: (...a: unknown[]) => normalizarRenglones(...a) }));

describe("exportar todo desde el 1/11", () => {
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

  async function factura(cambiar: (f: Comprobante) => void, foto = false) {
    const f = facturaDePrueba();
    cambiar(f);
    const { comprobante: datos, cierra } = controlar(f);
    const adjuntoIds = foto ? [(await guardarImagen(await sharp({ create: { width: 20, height: 30, channels: 3, background: "#fff" } }).jpeg().toBuffer(), "image/jpeg")).id] : [];
    return guardarComprobante({ chat: null, autor: "Martín", origen: "panel", datos, cierra, modelo: null, adjuntoIds });
  }

  it("solo con Métricas; trae las de noviembre (no las de antes ni las descartadas) con sus proveedores, productos, planillas y fotos", async () => {
    // Octubre (afuera), noviembre confirmada con foto, noviembre sin confirmar, noviembre descartada, una sin factura.
    await factura((f) => (f.encabezado = { ...f.encabezado, numero: "1", fecha: "2026-10-30", razonSocialEmisor: "Viejo SA", cuitEmisor: "30-99999999-9" }));
    const confirmada = await factura((f) => (f.encabezado = { ...f.encabezado, numero: "2", fecha: "2026-11-03" }), true);
    normalizarRenglones.mockResolvedValueOnce([
      { renglon: 1, nombre: "Café en grano 1 kg", categoria: "Café", unidadCompra: "kg", unidadesPorBulto: 0, contenido: 0, medida: "" },
      { renglon: 2, nombre: "Leche entera 1 l", categoria: "Lácteos", unidadCompra: "bulto", unidadesPorBulto: 12, contenido: 1, medida: "l" },
    ]);
    await confirmarComprobante(confirmada.id);
    await procesarPendientes();
    const pendiente = await factura((f) => (f.encabezado = { ...f.encabezado, numero: "3", fecha: "2026-11-05", razonSocialEmisor: "Lácteos La Vaquita", cuitEmisor: "30-11111111-1" }));
    const descartada = await factura((f) => (f.encabezado = { ...f.encabezado, numero: "4", fecha: "2026-11-06" }));
    await descartarComprobante(descartada.id);
    const efectivo = await crearFormaPago("Efectivo");
    const agua = await crearProveedor("Aguas del Sur");
    await guardarCompraManual(
      { proveedorId: agua.id, formaPagoId: efectivo.id, fecha: "2026-11-10", renglones: [{ nombre: "Bidón de agua 20 l", categoria: "Bebidas", clase: "gasto", cantidad: 2, unidadCompra: "unidad", unidadesPorBulto: 0, contenido: 20, medida: "l", total: 14000 }] },
      "Sofi",
      null,
    );

    expect((await app.inject({ url: "/api/c/exportar.zip", headers })).statusCode).toBe(403);
    await actualizarUsuario(usuarioId, { metricas: true });
    const r = await app.inject({ url: "/api/c/exportar.zip", headers });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    expect(r.headers["content-disposition"]).toContain("compras-coffit-desde-2026-11-01");

    const zip = unzipSync(new Uint8Array(r.rawPayload));
    expect(Object.keys(zip).sort()).toEqual(
      ["archivos/" + confirmada.id + "-distribuidora-del-cafe-sa-1.jpg", "datos.json", "facturas.csv", "productos.csv", "proveedores.csv", "renglones.csv"].sort(),
    );
    const datos = JSON.parse(strFromU8(zip["datos.json"]));
    expect(datos.desde).toBe("2026-11-01");
    expect(datos.compras.map((c: { titulo: string; estado: string; total: number }) => [c.titulo, c.estado, c.total])).toEqual([
      ["Factura A 0012-2", "confirmado", 197160],
      ["Factura A 0012-3", "pendiente", 197160],
      ["Sin factura", "confirmado", 14000],
    ]);
    expect(datos.compras[0].comprobante.renglones).toHaveLength(2);
    expect(datos.compras[0].archivos).toEqual([`archivos/${confirmada.id}-distribuidora-del-cafe-sa-1.jpg`]);
    expect(datos.compras[1].id).toBe(pendiente.id);
    // Solo los proveedores y productos de esas compras (no "Viejo SA").
    expect(datos.proveedores.map((p: { nombre: string }) => p.nombre)).toEqual(["Aguas del Sur", "Distribuidora del Café SA", "Lácteos La Vaquita"]);
    expect(datos.productos.map((p: { nombre: string }) => p.nombre)).toEqual(["Bidón de agua 20 l", "Café en grano 1 kg", "Leche entera 1 l"]);
    expect(datos.precios).toHaveLength(3);
    expect(datos.productosDeProveedores).toHaveLength(3);
    expect(datos.formasPago.map((f: { nombre: string }) => f.nombre)).toEqual(["Efectivo"]);
    expect(datos.compras[2].formaPago).toBe("Efectivo");

    const facturas = strFromU8(zip["facturas.csv"]);
    // Con BOM (Excel lee bien los acentos); al decodificar se saca.
    expect([...zip["facturas.csv"].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(facturas.startsWith("Id;Fecha;Comprobante")).toBe(true);
    expect(facturas.split("\r\n")).toHaveLength(4);
    expect(facturas).toContain('"Distribuidora del Café SA";"30-71234567-8";confirmado;panel;"";PES;159000,00;33390,00;4770,00;0,00;0,00;197160,00;Sí');
    expect(strFromU8(zip["renglones.csv"])).toContain('"Café en grano 1 kg"');
  });
});
