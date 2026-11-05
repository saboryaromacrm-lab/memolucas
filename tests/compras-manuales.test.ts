import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { adjunto, comprobante, producto } from "../src/db/schema.js";
import { crearServidor } from "../src/http/servidor.js";
import { asegurarAcceso } from "../src/http/rutas/auth.js";
import { borrarCompraManual, guardarCompraManual, obtenerCompraManual, type CompraManual } from "../src/servicios/compras-manuales.js";
import { enviarAlErp, listarComprobantes } from "../src/servicios/compras.js";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { crearUsuario } from "../src/servicios/panel-compras.js";
import { crearProveedor } from "../src/servicios/proveedores.js";
import { listarProductos, procesarPendientes } from "../src/servicios/productos.js";
import { baseLimpia } from "./ayuda.js";

const bidones = (cambios: Partial<CompraManual["renglones"][number]> = {}): CompraManual => ({
  proveedorId: null,
  formaPagoId: null,
  fecha: "2026-11-05",
  renglones: [
    { nombre: "Bidón de agua 20 l", categoria: "Bebidas", clase: "gasto", cantidad: 2, unidadCompra: "unidad", unidadesPorBulto: 0, contenido: 20, medida: "l", total: 14000, ...cambios },
  ],
});

describe("compras sin factura", () => {
  beforeEach(async () => {
    await baseLimpia();
  });

  it("2 bidones de 20 l por $ 14.000: unidad $ 7.000 y litro $ 350, confirmada y fuera del ERP", async () => {
    const aguas = await crearProveedor("Aguas del barrio");
    const id = await guardarCompraManual({ ...bidones(), proveedorId: aguas.id }, "Martín", null);
    const [p] = await listarProductos();
    expect(p).toMatchObject({ nombre: "Bidón de agua 20 l", categoria: "Bebidas", clase: "gasto", contenido: 20, medida: "l" });
    expect(p.ultima!.precios.unidad).toBe(7000);
    expect(p.ultima!.precios.porMedida).toEqual({ valor: 350, medida: "l" });

    const [c] = await listarComprobantes();
    expect(c.fila).toMatchObject({ id, origen: "manual", estado: "confirmado", autor: "Martín", clave: null, cierra: true, proveedorId: aguas.id });
    expect(p.ultima!.proveedor).toBe("Aguas del barrio");
    expect(c.datos.pie.total).toBe(14000);
    expect(c.datos.renglones[0]).toMatchObject({ descripcion: "Bidón de agua 20 l", cantidad: 2, precioUnitario: 7000 });

    await actualizarConfig({ erpUrl: "https://erp.ejemplo.com" });
    expect(await enviarAlErp(id)).toEqual({ ok: false, mensaje: "Las compras sin factura no se mandan al ERP" });
    // El barrido de Productos no la vuelve a procesar con la IA.
    await procesarPendientes();
    expect((await listarProductos())[0].compras).toBe(1);
  });

  it("la segunda compra con el mismo nombre se suma al historial; editar y borrar recalculan", async () => {
    await guardarCompraManual(bidones(), "Martín", null);
    const id = await guardarCompraManual({ ...bidones({ total: 16000 }), fecha: "2026-11-12" }, "Sofi", null);
    let [p] = await listarProductos();
    expect(p.compras).toBe(2);
    expect(p.variacion).toBeCloseTo(14.29, 1);

    // Editar: ahora fueron 4 bidones por $ 30.000.
    await guardarCompraManual({ ...bidones({ cantidad: 4, total: 30000 }), fecha: "2026-11-12" }, "Sofi", undefined, id);
    [p] = await listarProductos();
    expect(p.ultima!.precios.unidad).toBe(7500);
    expect(await obtenerCompraManual(id)).toMatchObject({ fecha: "2026-11-12", renglones: [{ nombre: "Bidón de agua 20 l", cantidad: 4, total: 30000 }] });

    await guardarCompraManual({ ...bidones({ nombre: "Soda en sifón 2 l", contenido: 2, total: 3000 }), fecha: "2026-11-12" }, "Sofi", undefined, id);
    expect((await listarProductos()).map((x) => x.nombre).sort()).toEqual(["Bidón de agua 20 l", "Soda en sifón 2 l"]);

    await borrarCompraManual(id);
    // El producto que quedó sin compras se borra; el otro sigue con la primera compra.
    expect((await listarProductos()).map((x) => x.nombre)).toEqual(["Bidón de agua 20 l"]);
    expect(await db.select().from(comprobante)).toHaveLength(1);
  });

  it("no se pueden editar ni borrar facturas leídas como si fueran manuales", async () => {
    const id = await guardarCompraManual(bidones(), "Martín", null);
    await db.update(comprobante).set({ origen: "panel" }).where(eq(comprobante.id, id));
    await expect(borrarCompraManual(id)).rejects.toThrow("No existe esa compra sin factura");
  });
});

describe("compras sin factura desde el panel", () => {
  const HOST = "comprascoff.saboryaroma.com";
  let app: FastifyInstance;
  let cookie = "";

  beforeEach(async () => {
    await baseLimpia();
    await asegurarAcceso();
    app = await crearServidor();
    await crearUsuario("Martín", "4321");
    const r = await app.inject({ method: "POST", url: "/api/c/ingresar", headers: { host: HOST }, payload: { clave: "4321" } });
    cookie = `compras_sesion=${r.cookies.find((c) => c.name === "compras_sesion")!.value}`;
  });
  afterEach(async () => app.close());

  function formulario(campos: Record<string, string>, foto?: Buffer) {
    const limite = "----manual";
    const partes = Object.entries(campos).map(([k, v]) => Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (foto) partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="foto"; filename="ticket.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), foto, Buffer.from("\r\n"));
    partes.push(Buffer.from(`--${limite}--\r\n`));
    return { payload: Buffer.concat(partes), headers: { host: HOST, cookie, "content-type": `multipart/form-data; boundary=${limite}` } };
  }

  it("crea con foto, la muestra como “Sin factura”, edita quitando la foto y borra", async () => {
    const foto = await sharp({ create: { width: 30, height: 40, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const r = await app.inject({ method: "POST", url: "/api/c/manuales", ...formulario({ datos: JSON.stringify(bidones()) }, foto) });
    expect(r.statusCode).toBe(200);
    const { id } = r.json();

    const lista = (await app.inject({ url: "/api/c/compras?estado=confirmado", headers: { host: HOST, cookie } })).json();
    expect(lista.compras[0]).toMatchObject({ id, titulo: "Sin factura", origen: "manual", autor: "Martín" });
    expect(lista.compras[0].archivos).toHaveLength(1);

    const editar = await app.inject({ method: "PUT", url: `/api/c/manuales/${id}`, ...formulario({ datos: JSON.stringify(bidones({ total: 15000 })), quitarFoto: "1" }) });
    expect(editar.statusCode).toBe(200);
    expect(await db.select().from(adjunto)).toHaveLength(0);
    expect((await app.inject({ url: `/api/c/manuales/${id}`, headers: { host: HOST, cookie } })).json()).toMatchObject({ fotoId: null, renglones: [{ total: 15000 }] });

    const mal = await app.inject({ method: "POST", url: "/api/c/manuales", ...formulario({ datos: "{roto" }) });
    expect(mal.statusCode).toBe(400);
    const sinRenglones = await app.inject({ method: "POST", url: "/api/c/manuales", ...formulario({ datos: JSON.stringify({ ...bidones(), renglones: [] }) }, foto) });
    expect(sinRenglones.statusCode).toBe(400);
    expect(await db.select().from(adjunto)).toHaveLength(0); // La foto de lo que no se guardó no queda.

    expect((await app.inject({ method: "DELETE", url: `/api/c/manuales/${id}`, headers: { host: HOST, cookie } })).statusCode).toBe(200);
    expect(await db.select().from(producto)).toHaveLength(0);
  });
});
