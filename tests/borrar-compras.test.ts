import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { db } from "../src/db/index.js";
import { adjunto, comprobante, producto } from "../src/db/schema.js";
import type { ProductoNormalizado } from "../src/bot/ia-productos.js";
import { asegurarAcceso } from "../src/http/rutas/auth.js";
import { crearServidor } from "../src/http/servidor.js";
import { controlar } from "../src/lib/comprobantes.js";
import { guardarImagen } from "../src/servicios/adjuntos.js";
import { buscarDuplicado, confirmarComprobante, guardarComprobante } from "../src/servicios/compras.js";
import { actualizarUsuario, crearUsuario } from "../src/servicios/panel-compras.js";
import { listarProductos, procesarPendientes } from "../src/servicios/productos.js";
import { listarProveedores } from "../src/servicios/proveedores.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const normalizarRenglones = vi.fn<(...a: unknown[]) => Promise<ProductoNormalizado[]>>();
vi.mock("../src/bot/ia-productos.js", async (orig) => ({ ...(await orig<object>()), normalizarRenglones: (...a: unknown[]) => normalizarRenglones(...a) }));

describe("borrar facturas desde el panel", () => {
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

  /** Una factura de prueba con su foto; confirmada, también pasa a Productos. */
  async function factura(numero: string, confirmar: boolean) {
    const f = facturaDePrueba();
    f.encabezado = { ...f.encabezado, numero };
    const { comprobante: datos, cierra } = controlar(f);
    const foto = await guardarImagen(await sharp({ create: { width: 20, height: 30, channels: 3, background: "#fff" } }).jpeg().toBuffer(), "image/jpeg");
    const fila = await guardarComprobante({ chat: null, autor: "Martín", origen: "panel", datos, cierra, modelo: null, adjuntoIds: [foto.id] });
    if (confirmar) {
      normalizarRenglones.mockResolvedValueOnce([
        { renglon: 1, nombre: "Café en grano 1 kg", categoria: "Café", unidadCompra: "kg", unidadesPorBulto: 0, contenido: 0, medida: "" },
        { renglon: 2, nombre: "Leche entera 1 l", categoria: "Lácteos", unidadCompra: "bulto", unidadesPorBulto: 12, contenido: 1, medida: "l" },
      ]);
      await confirmarComprobante(fila.id);
      await procesarPendientes();
    }
    return { fila, datos };
  }
  const borrar = (ids: number[]) => app.inject({ method: "POST", url: "/api/c/compras/borrar", headers, payload: { ids } });

  it("las sin confirmar las borra cualquiera; las confirmadas, solo quien tiene Métricas, y salen de Productos", async () => {
    const confirmada = await factura("1", true);
    const pendiente = await factura("2", false);
    const otra = await factura("3", false);
    expect(await listarProductos()).toHaveLength(2);

    // Sin Métricas: las sin confirmar sí, la confirmada no (y no borra nada si hay una mezclada).
    expect((await borrar([pendiente.fila.id])).statusCode).toBe(200);
    const mezcla = await borrar([otra.fila.id, confirmada.fila.id]);
    expect(mezcla.statusCode).toBe(400);
    expect(mezcla.json().error).toContain("solo las puede borrar quien tiene Métricas");
    expect(await db.select().from(comprobante)).toHaveLength(2);

    // Con Métricas: se borran juntas, con sus fotos y sus productos; el proveedor queda.
    await actualizarUsuario(usuarioId, { metricas: true });
    expect((await borrar([otra.fila.id, confirmada.fila.id])).statusCode).toBe(200);
    expect(await db.select().from(comprobante)).toHaveLength(0);
    expect(await db.select().from(adjunto)).toHaveLength(0);
    expect(await db.select().from(producto)).toHaveLength(0);
    expect(await listarProveedores()).toHaveLength(1);

    // Se puede volver a cargar: ya no figura como repetida.
    expect(await buscarDuplicado(confirmada.datos)).toBeNull();
    expect((await borrar([confirmada.fila.id])).statusCode).toBe(400);
  });
});
