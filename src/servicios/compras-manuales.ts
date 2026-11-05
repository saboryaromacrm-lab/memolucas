import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { comprobante, precioProducto, producto, productoAlias, type FilaComprobante, type UnidadCompra } from "../db/schema.js";
import { controlar, type Comprobante } from "../lib/comprobantes.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { borrarAdjunto } from "./adjuntos.js";
import { columnas, leerDatos } from "./compras.js";
import { exigirFormaPago } from "./formas-pago.js";
import { claveProducto } from "./productos.js";
import { nombreDeProveedor } from "./proveedores.js";
import { ErrorUsuario } from "./recordatorios.js";

// Compras sin factura (ej. 2 bidones de agua de 20 l por $ 14.000), cargadas a mano.
// Se guardan como un comprobante más (origen "manual", ya confirmado, nunca va al ERP)
// y sus productos pasan directo a Productos, sin IA: el nombre es el que se escribió.

const Renglon = z.object({
  /** Si ya hay un producto con este nombre, se suma a su historial; si no, se crea. */
  nombre: z.string().trim().min(2).max(120),
  categoria: z.string().trim().max(40),
  clase: z.enum(["mercaderia", "gasto"]),
  cantidad: z.number().positive().max(1_000_000),
  unidadCompra: z.enum(["bulto", "unidad", "kg", "litro"]),
  unidadesPorBulto: z.number().min(0).max(100_000),
  contenido: z.number().positive().max(100_000).nullable(),
  medida: z.enum(["kg", "l"]).nullable(),
  /** Lo que se pagó en total por este producto. */
  total: z.number().positive().max(1_000_000_000),
});
export const EsquemaCompraManual = z.object({
  /** Proveedor elegido o creado en el momento (opcional). */
  proveedorId: z.number().int().positive().nullable(),
  /** Cómo se pagó (opcional). */
  formaPagoId: z.number().int().positive().nullable().default(null),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
  renglones: z.array(Renglon).min(1).max(50),
});
export type CompraManual = z.infer<typeof EsquemaCompraManual>;

const UNIDAD_IMPRESA: Record<UnidadCompra, string> = { bulto: "CJ", unidad: "UN", kg: "KG", litro: "LT" };


/** El comprobante que se muestra en Facturas (mismo formato que los leídos). */
function comprobanteDe(d: CompraManual, proveedor: string, clases: Comprobante["renglones"][number]["clase"][]): Comprobante {
  const renglones = d.renglones.map((r, i) => ({
    clase: clases[i],
    codigo: "",
    descripcion: r.nombre,
    cantidad: r.cantidad,
    unidad: UNIDAD_IMPRESA[r.unidadCompra],
    unidadesPorBulto: r.unidadCompra === "bulto" ? r.unidadesPorBulto : 0,
    precioUnitario: r.total / r.cantidad,
    descuentos: [],
    importe: r.total,
    alicuotaIva: 0,
    cierra: true,
  }));
  const datos: Comprobante = {
    archivo: "",
    clase: new Set(clases).size === 1 ? clases[0] : "mixta",
    motivoClase: "",
    encabezado: {
      tipo: "otro",
      letra: "X",
      codigoArca: 0,
      puntoVenta: "",
      numero: "",
      fecha: d.fecha,
      cae: "",
      cuitEmisor: "",
      razonSocialEmisor: proveedor,
      domicilioEmisor: "",
      condicionIvaEmisor: "",
      cuitReceptor: "",
      razonSocialReceptor: "",
      moneda: "PES",
      condicionVentaImpresa: "",
      vencimientoPago: "",
      comprobanteQueAjusta: "",
    },
    renglones,
    pie: {
      subtotal: 0,
      bonificacionPct: 0,
      bonificacionImporte: 0,
      ivas: [],
      percepciones: [],
      impuestosInternos: 0,
      otrosImpuestos: 0,
      total: renglones.reduce((t, r) => t + r.importe, 0),
    },
    pagoQueFigura: { figura: false, medio: "", fecha: "", importe: 0, referencia: "" },
    controles: { sumaRenglones: 0, cierraSubtotal: true, cierraTotal: true, diferencias: "" },
    dudas: ["Compra sin comprobante, cargada a mano"],
  };
  return controlar(datos).comprobante;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** El producto de cada renglón: el que tiene ese nombre o uno nuevo. El contenido escrito se guarda en el producto. */
async function productoDe(tx: Tx, r: CompraManual["renglones"][number]) {
  const contenido = r.contenido && r.medida ? { contenido: r.contenido, medida: r.medida } : {};
  const [existente] = await tx.select().from(producto).where(eq(producto.clave, claveProducto(r.nombre)));
  if (existente) {
    if (contenido.contenido) await tx.update(producto).set({ ...contenido, actualizadoEn: new Date() }).where(eq(producto.id, existente.id));
    return existente;
  }
  const [nuevo] = await tx
    .insert(producto)
    .values({ nombre: r.nombre, clave: claveProducto(r.nombre), categoria: r.categoria || "Otros", clase: r.clase, ...contenido })
    .returning();
  return nuevo;
}

type ProductoElegido = Awaited<ReturnType<typeof productoDe>>;

/** Pasa la compra a Productos (reemplaza lo que tenía, si se edita). */
async function registrarPrecios(tx: Tx, comprobanteId: number, d: CompraManual, proveedor: string, productos: ProductoElegido[]) {
  await tx.delete(precioProducto).where(eq(precioProducto.comprobanteId, comprobanteId));
  for (const [i, r] of d.renglones.entries()) {
    const p = productos[i];
    const alias = `${normalizar(proveedor)}|m:${p.clave}`;
    await tx.insert(productoAlias).values({ clave: alias, productoId: p.id, proveedor }).onConflictDoNothing();
    await tx.insert(precioProducto).values({
      productoId: p.id,
      comprobanteId,
      renglon: i + 1,
      aliasClave: alias,
      proveedor,
      fecha: d.fecha,
      descripcion: p.nombre,
      cantidad: r.cantidad,
      unidadCompra: r.unidadCompra,
      unidadesPorBulto: r.unidadCompra === "bulto" ? r.unidadesPorBulto : 0,
      costoFinal: r.total,
    });
  }
}

/** Los productos que quedaron sin ninguna compra (por editar o borrar) se borran. */
async function borrarHuerfanos(tx: Tx, ids: number[]) {
  if (!ids.length) return;
  await tx
    .delete(producto)
    .where(and(inArray(producto.id, ids), notExists(tx.select({ uno: sql`1` }).from(precioProducto).where(eq(precioProducto.productoId, producto.id)))));
}

async function manual(id: number): Promise<FilaComprobante> {
  const [fila] = await db.select().from(comprobante).where(and(eq(comprobante.id, id), eq(comprobante.origen, "manual")));
  if (!fila) throw new ErrorUsuario("No existe esa compra sin factura");
  return fila;
}

/** Crea (sin id) o reemplaza una compra sin factura. foto: el adjunto nuevo, null para quitarla, undefined para dejarla. */
export async function guardarCompraManual(d: CompraManual, autor: string | null, foto: number | null | undefined, id?: number): Promise<number> {
  const anterior = id ? await manual(id) : null;
  const nombreProveedor = d.proveedorId ? await nombreDeProveedor(d.proveedorId) : "";
  await exigirFormaPago(d.formaPagoId);
  const adjuntoIds = foto === undefined ? (anterior?.adjuntoIds ?? []) : foto === null ? [] : [foto];
  const nuevoId = await db.transaction(async (tx) => {
    const productosAntes = anterior ? (await tx.select({ id: precioProducto.productoId }).from(precioProducto).where(eq(precioProducto.comprobanteId, anterior.id))).map((p) => p.id) : [];
    const productos: ProductoElegido[] = [];
    for (const r of d.renglones) productos.push(await productoDe(tx, r));
    // Sin clave: no tiene número, así que no se usa para detectar facturas repetidas.
    const datos = {
      ...columnas(comprobanteDe(d, nombreProveedor, productos.map((p) => p.clase)), true),
      clave: null,
      proveedorId: d.proveedorId,
      formaPagoId: d.formaPagoId,
      adjuntoIds,
      actualizadoEn: new Date(),
    };
    const [fila] = anterior
      ? await tx.update(comprobante).set(datos).where(eq(comprobante.id, anterior.id)).returning()
      : await tx.insert(comprobante).values({ ...datos, chat: null, autor, origen: "manual", estado: "confirmado", confirmadoEn: new Date(), productosEn: new Date() }).returning();
    await registrarPrecios(tx, fila.id, d, nombreProveedor || "Sin proveedor", productos);
    await borrarHuerfanos(tx, productosAntes);
    return fila.id;
  });
  // La foto anterior se borra recién cuando quedó guardado lo nuevo.
  for (const a of anterior?.adjuntoIds ?? []) if (!adjuntoIds.includes(a)) await borrarAdjunto(a);
  bus.avisar("compras");
  return nuevoId;
}

/** Los datos para editarla, como se cargaron. */
export async function obtenerCompraManual(id: number): Promise<CompraManual & { fotoId: number | null }> {
  const fila = await manual(id);
  const datos = leerDatos(fila);
  const filas = await db
    .select({ precio: precioProducto, producto })
    .from(precioProducto)
    .innerJoin(producto, eq(producto.id, precioProducto.productoId))
    .where(eq(precioProducto.comprobanteId, id))
    .orderBy(precioProducto.renglon);
  return {
    proveedorId: fila.proveedorId,
    formaPagoId: fila.formaPagoId,
    fecha: datos.encabezado.fecha,
    fotoId: fila.adjuntoIds[0] ?? null,
    renglones: filas.map(({ precio: r, producto: p }) => ({
      nombre: p.nombre,
      categoria: p.categoria,
      clase: p.clase,
      cantidad: r.cantidad,
      unidadCompra: r.unidadCompra,
      unidadesPorBulto: r.unidadesPorBulto,
      contenido: p.contenido,
      medida: p.medida,
      total: r.costoFinal,
    })),
  };
}

export async function borrarCompraManual(id: number) {
  const fila = await manual(id);
  await db.transaction(async (tx) => {
    const productos = (await tx.select({ id: precioProducto.productoId }).from(precioProducto).where(eq(precioProducto.comprobanteId, id))).map((p) => p.id);
    await tx.delete(comprobante).where(eq(comprobante.id, id));
    await borrarHuerfanos(tx, productos);
  });
  for (const a of fila.adjuntoIds) await borrarAdjunto(a);
  bus.avisar("compras");
}
