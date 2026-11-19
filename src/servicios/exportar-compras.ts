import fs from "node:fs/promises";
import { and, asc, inArray, ne, sql } from "drizzle-orm";
import { zipSync, type Zippable } from "fflate";
import { db } from "../db/index.js";
import { adjunto, comprobante, formaPago, precioProducto, producto, productoAlias, productoProveedor, proveedor } from "../db/schema.js";
import { tipoComprobante, tituloComprobante, type Comprobante } from "../lib/comprobantes.js";
import { celda, csv, numero } from "../lib/csv.js";
import { preciosDe } from "../lib/precios.js";
import { normalizar } from "../lib/textos.js";
import { leerDatos } from "./compras.js";
import { fechaDeCompra } from "./proveedores.js";

// Todo lo cargado desde una fecha, descifrado, para llevarlo a otro sistema: un JSON completo para importar,
// planillas para Excel y las fotos y PDF de cada factura.

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
const suma = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const fila = (...celdas: string[]) => celdas.join(";");
/** "Distribuidora del Café SA" → "distribuidora-del-cafe-sa" (para el nombre de los archivos). */
const paraArchivo = (s: string) => normalizar(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "sin-proveedor";

/** Las compras con fecha (de la factura o, si no tiene, de carga) desde "desde", sin las descartadas. */
export async function exportarCompras(desde: string): Promise<Uint8Array> {
  const filas = await db
    .select()
    .from(comprobante)
    .where(and(ne(comprobante.estado, "descartado"), sql`${fechaDeCompra} >= ${desde}`))
    .orderBy(sql`${fechaDeCompra}`, asc(comprobante.id));
  const ids = filas.map((f) => f.id);
  const adjuntoIds = filas.flatMap((f) => f.adjuntoIds);

  // Solo los proveedores, productos y precios de esas compras; las formas de pago, todas (son pocas).
  const proveedorIds = [...new Set(filas.flatMap((f) => (f.proveedorId ? [f.proveedorId] : [])))];
  const precios = ids.length
    ? await db.select().from(precioProducto).where(inArray(precioProducto.comprobanteId, ids)).orderBy(asc(precioProducto.comprobanteId), asc(precioProducto.renglon))
    : [];
  const productoIds = [...new Set(precios.map((p) => p.productoId))];
  const hayProductos = productoIds.length > 0;
  const [proveedores, productos, alias, enlaces, formas, archivos] = await Promise.all([
    proveedorIds.length ? db.select().from(proveedor).where(inArray(proveedor.id, proveedorIds)).orderBy(asc(proveedor.nombre)) : [],
    hayProductos ? db.select().from(producto).where(inArray(producto.id, productoIds)).orderBy(asc(producto.nombre)) : [],
    hayProductos ? db.select().from(productoAlias).where(inArray(productoAlias.productoId, productoIds)) : [],
    hayProductos && proveedorIds.length
      ? db.select().from(productoProveedor).where(and(inArray(productoProveedor.productoId, productoIds), inArray(productoProveedor.proveedorId, proveedorIds)))
      : [],
    db.select().from(formaPago).orderBy(asc(formaPago.orden), asc(formaPago.id)),
    adjuntoIds.length ? db.select().from(adjunto).where(inArray(adjunto.id, adjuntoIds)) : [],
  ]);
  const nombreProveedor = new Map(proveedores.map((p) => [p.id, p.nombre]));
  const nombreForma = new Map(formas.map((f) => [f.id, f.nombre]));
  const nombreProducto = new Map(productos.map((p) => [p.id, p]));
  const adjuntos = new Map(archivos.map((a) => [a.id, a]));

  const zip: Zippable = {};
  const compras = [];
  for (const f of filas) {
    const datos = leerDatos(f);
    const proveedorNombre = (f.proveedorId && nombreProveedor.get(f.proveedorId)) || datos.encabezado.razonSocialEmisor || "";
    // Fotos y PDF: los que todavía están (se borran a los días configurados).
    const suyos: string[] = [];
    for (const [i, id] of f.adjuntoIds.entries()) {
      const a = adjuntos.get(id);
      const contenido = a && (await fs.readFile(a.rutaArchivo).catch(() => null));
      if (!a || !contenido) continue;
      const ruta = `archivos/${f.id}-${paraArchivo(proveedorNombre)}-${i + 1}.${EXTENSION[a.mime] ?? "bin"}`;
      // Fotos y PDF ya vienen comprimidos: se guardan tal cual (más rápido, mismo tamaño).
      zip[ruta] = [contenido, { level: 0 }];
      suyos.push(ruta);
    }
    compras.push({
      id: f.id,
      fecha: f.fecha ?? f.creadoEn.toISOString().slice(0, 10),
      titulo: f.origen === "manual" ? "Sin factura" : tituloComprobante(datos),
      estado: f.estado,
      origen: f.origen,
      cierra: f.cierra,
      cargo: f.autor,
      cargadaEn: f.creadoEn,
      confirmadaEn: f.confirmadoEn,
      proveedorId: f.proveedorId,
      proveedor: proveedorNombre || null,
      formaPagoId: f.formaPagoId,
      formaPago: (f.formaPagoId && nombreForma.get(f.formaPagoId)) || null,
      total: datos.pie.total,
      moneda: datos.encabezado.moneda || "PES",
      archivos: suyos,
      archivosBorrados: f.archivosBorrados,
      comprobante: datos,
    });
  }

  const datos = {
    exportadoEn: new Date().toISOString(),
    desde,
    aclaraciones: [
      "Compras con fecha de factura (o de carga, si no tiene) desde 'desde', sin las descartadas.",
      "Importes en pesos con decimales (o en dólares si moneda = DOL). 'total' es el total de la factura con percepciones.",
      "'comprobante' es la lectura completa de la factura (encabezado, renglones, pie). Las compras sin factura tienen origen 'manual'.",
      "'precios' es cada renglón que pasó a Productos (solo las confirmadas): costoFinal con IVA e impuestos internos, sin percepciones.",
    ],
    compras,
    proveedores: proveedores.map((p) => ({ id: p.id, nombre: p.nombre, cuit: p.cuit, notas: p.notas, oculto: p.oculto, formaPagoId: p.formaPagoId, formaPago: (p.formaPagoId && nombreForma.get(p.formaPagoId)) || null })),
    formasPago: formas.map((f) => ({ id: f.id, nombre: f.nombre, orden: f.orden, oculta: f.oculta })),
    productos: productos.map((p) => ({ id: p.id, nombre: p.nombre, categoria: p.categoria, clase: p.clase, contenido: p.contenido, medida: p.medida })),
    alias: alias.map((a) => ({ clave: a.clave, productoId: a.productoId, proveedor: a.proveedor })),
    productosDeProveedores: enlaces.map((e) => ({ productoId: e.productoId, proveedorId: e.proveedorId })),
    precios: precios.map((p) => {
      const { id: _, creadoEn: __, ...resto } = p;
      return { ...resto, precios: preciosDe(p, nombreProducto.get(p.productoId) ?? { contenido: null, medida: null }) };
    }),
  };
  const texto = (s: string) => new TextEncoder().encode(s);
  zip["datos.json"] = texto(JSON.stringify(datos, null, 2));
  zip["facturas.csv"] = texto(facturasCsv(compras));
  zip["renglones.csv"] = texto(renglonesCsv(compras, precios, nombreProducto));
  zip["proveedores.csv"] = texto(
    csv([
      "Id;Proveedor;CUIT;Forma de pago habitual;Oculto;Notas",
      ...datos.proveedores.map((p) => fila(String(p.id), celda(p.nombre), celda(p.cuit ?? ""), celda(p.formaPago ?? ""), p.oculto ? "Sí" : "No", celda(p.notas))),
    ]),
  );
  zip["productos.csv"] = texto(
    csv([
      "Id;Producto;Categoría;Clase;Contenido;Medida",
      ...productos.map((p) => fila(String(p.id), celda(p.nombre), celda(p.categoria), p.clase === "gasto" ? "Gasto" : "Mercadería", numero(p.contenido), p.medida ?? "")),
    ]),
  );
  return zipSync(zip, { level: 6 });
}

type CompraExportada = { id: number; fecha: string; titulo: string; estado: string; origen: string; cierra: boolean; cargo: string | null; proveedor: string | null; formaPago: string | null; moneda: string; archivos: string[]; comprobante: Comprobante };

function facturasCsv(compras: CompraExportada[]): string {
  return csv([
    "Id;Fecha;Comprobante;Tipo;Proveedor;CUIT;Estado;Origen;Forma de pago;Moneda;Subtotal;IVA;Percepciones;Impuestos internos;Otros impuestos;Total;Cierra;Cargó;Archivos",
    ...compras.map((c) => {
      const p = c.comprobante.pie;
      return fila(
        String(c.id),
        c.fecha,
        celda(c.titulo),
        celda(tipoComprobante(c.comprobante)),
        celda(c.proveedor ?? ""),
        celda(c.comprobante.encabezado.cuitEmisor),
        c.estado,
        c.origen,
        celda(c.formaPago ?? ""),
        c.moneda,
        numero(p.subtotal),
        numero(suma(p.ivas.map((i) => i.importe))),
        numero(suma(p.percepciones.map((x) => x.importe))),
        numero(p.impuestosInternos),
        numero(p.otrosImpuestos),
        numero(p.total),
        c.cierra ? "Sí" : "No",
        celda(c.cargo ?? ""),
        celda(c.archivos.join(" ")),
      );
    }),
  ]);
}

function renglonesCsv(compras: CompraExportada[], precios: (typeof precioProducto.$inferSelect)[], productos: Map<number, { nombre: string }>): string {
  const deRenglon = new Map(precios.map((p) => [`${p.comprobanteId}|${p.renglon}`, p]));
  return csv([
    "Factura;Fecha;Proveedor;Renglón;Código;Descripción;Cantidad;Unidad;Unidades por bulto;Precio unitario;Descuentos %;Importe;Alícuota IVA;Clase;Producto;Costo final",
    ...compras.flatMap((c) =>
      c.comprobante.renglones.map((r, i) => {
        const precio = deRenglon.get(`${c.id}|${i + 1}`);
        return fila(
          String(c.id),
          c.fecha,
          celda(c.proveedor ?? ""),
          String(i + 1),
          celda(r.codigo),
          celda(r.descripcion),
          numero(r.cantidad),
          celda(r.unidad),
          numero(r.unidadesPorBulto),
          numero(r.precioUnitario),
          celda(r.descuentos.join("+")),
          numero(r.importe),
          numero(r.alicuotaIva),
          r.clase === "gasto" ? "Gasto" : "Mercadería",
          celda((precio && productos.get(precio.productoId)?.nombre) ?? ""),
          numero(precio?.costoFinal),
        );
      }),
    ),
  ]);
}
