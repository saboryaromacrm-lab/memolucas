import { DateTime } from "luxon";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { comprobante, precioProducto, producto, type FilaComprobante } from "../db/schema.js";
import { tipoComprobante, type Comprobante } from "../lib/comprobantes.js";
import { celda, csv, numero } from "../lib/csv.js";
import { costosFinales, preciosDe, variacion } from "../lib/precios.js";
import { leerDatos, nombres } from "./compras.js";
import { fechaDeCompra } from "./proveedores.js";

// Métricas de compras de un período, comparadas con el anterior. Cuentan las compras en pesos por la fecha de la
// factura (las notas de crédito restan); los remitos no suman (se cuentan aparte) y lo que está en dólares va aparte.

export type Periodo = { desde: string; hasta: string };
type Grupo = { id: number | null; nombre: string; total: number; compras: number };
type Compra = { fila: FilaComprobante; datos: Comprobante; fecha: string; importe: number; mercaderia: number };

const suma = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const enPeriodo = (fecha: string, p: Periodo) => fecha >= p.desde && fecha <= p.hasta;
const porcentaje = (actual: number, anterior: number) => (anterior > 0 ? ((actual - anterior) / anterior) * 100 : null);

/** Con qué se compara: los mismos meses justo antes si el período son meses enteros; si no, los mismos días. */
export function periodoAnterior({ desde, hasta }: Periodo): Periodo {
  const d = DateTime.fromISO(desde);
  const h = DateTime.fromISO(hasta);
  const mesesEnteros = d.day === 1 && h.day === h.daysInMonth;
  const corrimiento = mesesEnteros ? { months: Math.round(h.plus({ days: 1 }).diff(d, "months").months) } : { days: h.diff(d, "days").days + 1 };
  return { desde: d.minus(corrimiento).toISODate()!, hasta: d.minus({ days: 1 }).toISODate()! };
}

/** La parte de mercadería de un comprobante, según el costo de sus renglones (el resto es gasto). */
function parteMercaderia(d: Comprobante): number {
  const costos = costosFinales(d);
  const total = suma(costos);
  if (total <= 0) return d.clase === "gasto" ? 0 : 1;
  return suma(costos.filter((_, i) => d.renglones[i].clase !== "gasto")) / total;
}

/** Un grupo se identifica por su id; los que no tienen (categoría, persona…), por su nombre. */
const claveDe = (g: { id: number | null; nombre: string }) => (g.id === null ? `n:${g.nombre}` : String(g.id));

/** Suma por grupo, de mayor a menor. Cuenta como compra lo que suma (una nota de crédito resta, no cuenta). */
function agrupar<T>(items: T[], de: (x: T) => { id: number | null; nombre: string }, valor: (x: T) => number): Grupo[] {
  const grupos = new Map<string, Grupo>();
  for (const x of items) {
    const { id, nombre } = de(x);
    const clave = claveDe({ id, nombre });
    const g = grupos.get(clave) ?? { id, nombre, total: 0, compras: 0 };
    g.total += valor(x);
    if (valor(x) > 0) g.compras++;
    grupos.set(clave, g);
  }
  return [...grupos.values()].sort((a, b) => b.total - a.total);
}

function resumir(compras: Compra[]) {
  const total = suma(compras.map((c) => c.importe));
  const mercaderia = suma(compras.map((c) => c.mercaderia));
  const cantidad = compras.filter((c) => c.importe > 0).length;
  return {
    total,
    compras: cantidad,
    promedio: cantidad ? total / cantidad : 0,
    proveedores: new Set(compras.flatMap((c) => (c.fila.proveedorId ? [c.fila.proveedorId] : []))).size,
    mercaderia,
    gasto: total - mercaderia,
  };
}

/** Por día si el período es de un mes o menos; si no, por mes. Con todas las barras, aunque estén vacías. */
function evolucion(compras: Compra[], p: Periodo) {
  const desde = DateTime.fromISO(p.desde);
  const hasta = DateTime.fromISO(p.hasta);
  const porDia = hasta.diff(desde, "days").days < 31;
  const largo = porDia ? 10 : 7;
  const barras = new Map<string, { clave: string; mercaderia: number; gasto: number }>();
  for (let x = porDia ? desde : desde.startOf("month"); x <= hasta; x = x.plus(porDia ? { days: 1 } : { months: 1 })) {
    const clave = x.toISODate()!.slice(0, largo);
    barras.set(clave, { clave, mercaderia: 0, gasto: 0 });
  }
  for (const c of compras) {
    const b = barras.get(c.fecha.slice(0, largo));
    if (!b) continue;
    b.mercaderia += c.mercaderia;
    b.gasto += c.importe - c.mercaderia;
  }
  return { porDia, barras: [...barras.values()] };
}

const PERCEPCIONES = { iva: "Percepciones de IVA", iibb: "Percepciones de IIBB", otro: "Otras percepciones" } as const;

/** IVA por alícuota (crédito fiscal), percepciones e impuestos internos. Las notas de crédito restan. */
function impuestos(compras: Compra[]) {
  const ivas = new Map<number, number>();
  const percepciones = new Map<string, number>();
  let internos = 0;
  let otros = 0;
  for (const { datos: d, importe } of compras) {
    const signo = Math.sign(importe);
    for (const i of d.pie.ivas) ivas.set(i.alicuota, (ivas.get(i.alicuota) ?? 0) + i.importe * signo);
    for (const x of d.pie.percepciones) percepciones.set(PERCEPCIONES[x.tipo], (percepciones.get(PERCEPCIONES[x.tipo]) ?? 0) + x.importe * signo);
    internos += d.pie.impuestosInternos * signo;
    otros += d.pie.otrosImpuestos * signo;
  }
  return {
    ivas: [...ivas].sort((a, b) => b[0] - a[0]).map(([alicuota, importe]) => ({ alicuota, importe })),
    percepciones: [...percepciones].map(([nombre, importe]) => ({ nombre, importe })),
    internos,
    otros,
  };
}

// ───────────── Productos ─────────────

/** Lo que pasó a Productos de esos comprobantes (solo los confirmados llegan), en orden de compra. */
async function filasDeProductos(comprobanteIds: number[]) {
  if (!comprobanteIds.length) return [];
  return db
    .select({ precio: precioProducto, producto: { id: producto.id, nombre: producto.nombre, categoria: producto.categoria, contenido: producto.contenido, medida: producto.medida } })
    .from(precioProducto)
    .innerJoin(producto, eq(producto.id, precioProducto.productoId))
    .where(inArray(precioProducto.comprobanteId, comprobanteIds))
    .orderBy(asc(precioProducto.fecha), asc(precioProducto.id));
}
type FilaProducto = Awaited<ReturnType<typeof filasDeProductos>>[number];

const gastoPorProducto = (filas: FilaProducto[]) =>
  agrupar(
    filas,
    (f) => ({ id: f.producto.id, nombre: f.producto.nombre }),
    (f) => f.precio.costoFinal,
  );

/** Cuánto cambió el precio de cada producto: su última compra contra la última de antes. */
function variaciones(actuales: FilaProducto[], anteriores: FilaProducto[]) {
  const antes = new Map(anteriores.map((f) => [f.producto.id, f]));
  const ultimas = new Map(actuales.map((f) => [f.producto.id, f]));
  return gastoPorProducto(actuales).flatMap((g) => {
    const a = ultimas.get(g.id!)!;
    const b = antes.get(g.id!);
    const v = b ? variacion(preciosDe(a.precio, a.producto), preciosDe(b.precio, b.producto)) : null;
    return v === null ? [] : [{ id: g.id!, nombre: g.nombre, variacion: v, gasto: g.total }];
  });
}

/** El promedio de las variaciones, pesando cada producto por lo que se gastó en él: la inflación de lo que se compra. */
function inflacion(vs: { variacion: number; gasto: number }[]) {
  const peso = suma(vs.map((v) => v.gasto));
  return peso > 0 ? suma(vs.map((v) => v.variacion * v.gasto)) / peso : null;
}

/** La inflación de cada mes del período, contra el mes anterior. */
function inflacionPorMes(filas: FilaProducto[], p: Periodo) {
  const porMes = new Map<string, FilaProducto[]>();
  for (const f of filas) {
    const mes = f.precio.fecha.slice(0, 7);
    const lista = porMes.get(mes);
    if (lista) lista.push(f);
    else porMes.set(mes, [f]);
  }
  const meses = [];
  for (let m = DateTime.fromISO(p.desde).startOf("month"); m <= DateTime.fromISO(p.hasta); m = m.plus({ months: 1 })) {
    const mes = m.toFormat("yyyy-MM");
    meses.push({ mes, variacion: inflacion(variaciones(porMes.get(mes) ?? [], porMes.get(m.minus({ months: 1 }).toFormat("yyyy-MM")) ?? [])) });
  }
  return meses;
}

// ───────────── Todo junto ─────────────

export async function metricas(p: Periodo, soloConfirmadas: boolean) {
  const anterior = periodoAnterior(p);
  const [filas, n] = await Promise.all([
    db
      .select()
      .from(comprobante)
      .where(
        and(
          soloConfirmadas ? eq(comprobante.estado, "confirmado") : ne(comprobante.estado, "descartado"),
          sql`${fechaDeCompra} between ${anterior.desde} and ${p.hasta}`,
        ),
      ),
    nombres(),
  ]);

  const todas: Compra[] = filas.map((fila) => {
    const datos = leerDatos(fila);
    const importe = datos.pie.total * (datos.encabezado.tipo === "nota_credito" ? -1 : 1);
    return { fila, datos, fecha: fila.fecha ?? fila.creadoEn.toISOString().slice(0, 10), importe, mercaderia: importe * parteMercaderia(datos) };
  });
  const delPeriodo = todas.filter((c) => enPeriodo(c.fecha, p));
  const enPesos = (c: Compra) => c.datos.encabezado.moneda !== "DOL" && c.datos.encabezado.tipo !== "remito";
  const actuales = delPeriodo.filter(enPesos);
  const previas = todas.filter((c) => enPesos(c) && enPeriodo(c.fecha, anterior));
  const dolares = delPeriodo.filter((c) => c.datos.encabezado.moneda === "DOL" && c.datos.encabezado.tipo !== "remito");

  const productos = await filasDeProductos([...actuales, ...previas].map((c) => c.fila.id));
  const productosActuales = productos.filter((f) => enPeriodo(f.precio.fecha, p));
  const cambios = variaciones(
    productosActuales,
    productos.filter((f) => enPeriodo(f.precio.fecha, anterior)),
  );

  const deProveedor = (c: Compra) => ({
    id: c.fila.proveedorId,
    nombre: (c.fila.proveedorId && n.proveedores.get(c.fila.proveedorId)) || c.datos.encabezado.razonSocialEmisor || "Sin proveedor",
  });
  const importe = (c: Compra) => c.importe;
  const totalAnteriorPorProveedor = new Map(agrupar(previas, deProveedor, importe).map((g) => [claveDe(g), g.total]));

  return {
    periodo: p,
    anterior,
    resumen: { ...resumir(actuales), inflacion: inflacion(cambios) },
    resumenAnterior: resumir(previas),
    remitos: delPeriodo.filter((c) => c.datos.encabezado.tipo === "remito").length,
    dolares: { total: suma(dolares.map(importe)), compras: dolares.length },
    evolucion: evolucion(actuales, p),
    proveedores: agrupar(actuales, deProveedor, importe).map((g) => ({ ...g, variacion: porcentaje(g.total, totalAnteriorPorProveedor.get(claveDe(g)) ?? 0) })),
    categorias: agrupar(
      productosActuales,
      (f) => ({ id: null, nombre: f.producto.categoria }),
      (f) => f.precio.costoFinal,
    ),
    productos: gastoPorProducto(productosActuales),
    subas: cambios.filter((c) => c.variacion > 0).sort((a, b) => b.variacion - a.variacion),
    bajas: cambios.filter((c) => c.variacion < 0).sort((a, b) => a.variacion - b.variacion),
    inflacionPorMes: inflacionPorMes(productos, p),
    formasPago: agrupar(actuales, (c) => ({ id: c.fila.formaPagoId, nombre: (c.fila.formaPagoId && n.formasPago.get(c.fila.formaPagoId)) || "Sin especificar" }), importe),
    impuestos: impuestos(actuales),
    autores: agrupar(actuales, (c) => ({ id: null, nombre: c.fila.autor || "Sin dato" }), importe),
    origen: agrupar(actuales, (c) => ({ id: null, nombre: c.fila.origen === "manual" ? "Sin factura" : "Con factura" }), importe),
    tipos: agrupar(actuales, (c) => ({ id: null, nombre: tipoComprobante(c.datos) || "Otro" }), importe),
  };
}
export type Metricas = Awaited<ReturnType<typeof metricas>>;

// ───────────── Excel ─────────────

/** Todo el detalle del período en un CSV para Excel, por secciones. */
export function metricasCsv(m: Metricas): string {
  const linea = (...celdas: string[]) => celdas.join(";");
  const seccion = (titulo: string, encabezado: string, filas: string[]) => ["", celda(titulo), encabezado, ...filas];
  const grupos = (titulo: string, gs: Grupo[]) => seccion(titulo, "Nombre;Total;Compras", gs.map((g) => linea(celda(g.nombre), numero(g.total), String(g.compras))));
  const { resumen: r, resumenAnterior: a, impuestos: i } = m;
  const dato = (nombre: string, actual: number | null, anterior?: number) => linea(celda(nombre), numero(actual), numero(anterior));
  const cantidad = (nombre: string, actual: number, anterior?: number) => linea(celda(nombre), String(actual), anterior === undefined ? "" : String(anterior));
  return csv([
    linea("Período", m.periodo.desde, m.periodo.hasta, "Se compara con", m.anterior.desde, m.anterior.hasta),
    ...seccion("Resumen (en pesos)", "Dato;Este período;Período anterior", [
      dato("Total comprado", r.total, a.total),
      cantidad("Compras", r.compras, a.compras),
      dato("Compra promedio", r.promedio, a.promedio),
      cantidad("Proveedores", r.proveedores, a.proveedores),
      dato("Mercadería", r.mercaderia, a.mercaderia),
      dato("Gastos", r.gasto, a.gasto),
      dato("Variación de precios %", r.inflacion),
      cantidad("Remitos (no suman)", m.remitos),
      dato("En dólares (aparte)", m.dolares.total),
    ]),
    ...seccion(
      m.evolucion.porDia ? "Por día" : "Por mes",
      "Fecha;Mercadería;Gastos;Total",
      m.evolucion.barras.map((b) => linea(b.clave, numero(b.mercaderia), numero(b.gasto), numero(b.mercaderia + b.gasto))),
    ),
    ...seccion(
      "Por proveedor",
      "Nombre;Total;Compras;Variación %",
      m.proveedores.map((g) => linea(celda(g.nombre), numero(g.total), String(g.compras), numero(g.variacion))),
    ),
    ...grupos("Por categoría (según los productos)", m.categorias),
    ...grupos("Por producto", m.productos),
    ...seccion(
      "Cambios de precio",
      "Producto;Variación %;Gasto",
      [...m.subas, ...m.bajas].map((v) => linea(celda(v.nombre), numero(v.variacion), numero(v.gasto))),
    ),
    ...seccion(
      "Variación de precios por mes",
      "Mes;Variación %",
      m.inflacionPorMes.map((x) => linea(x.mes, numero(x.variacion))),
    ),
    ...grupos("Por forma de pago", m.formasPago),
    ...seccion("Impuestos", "Concepto;Importe", [
      ...i.ivas.map((x) => linea(`IVA ${String(x.alicuota).replace(".", ",")} %`, numero(x.importe))),
      ...i.percepciones.map((x) => linea(celda(x.nombre), numero(x.importe))),
      linea("Impuestos internos", numero(i.internos)),
      linea("Otros impuestos", numero(i.otros)),
    ]),
    ...grupos("Por persona que cargó", m.autores),
    ...grupos("Con y sin factura", m.origen),
    ...grupos("Por tipo de comprobante", m.tipos),
  ]);
}
