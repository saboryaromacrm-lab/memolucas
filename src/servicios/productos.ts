import { and, asc, eq, inArray, isNull, lt, notExists, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  comprobante,
  precioProducto,
  producto,
  productoAlias,
  productoProveedor,
  proveedor,
  type FilaComprobante,
  type PrecioProducto,
  type Producto,
} from "../db/schema.js";
import { normalizarRenglones, type ProductoNormalizado } from "../bot/ia-productos.js";
import type { Comprobante } from "../lib/comprobantes.js";
import { bus } from "../lib/eventos.js";
import { registrar } from "../lib/log.js";
import { celda, csv, numero } from "../lib/csv.js";
import { costosFinales, preciosDe, variacion, type Precios } from "../lib/precios.js";
import { normalizar } from "../lib/textos.js";
import { leerDatos } from "./compras.js";
import { obtenerConfig } from "./configuracion.js";
import { enlazarSegunCompras, sincronizarNombres } from "./proveedores.js";
import { ErrorUsuario } from "./recordatorios.js";

const MAX_INTENTOS = 5;
/** Tipos que no sirven para precios: las notas de crédito restan y los remitos no traen precio. */
const SIN_PRECIOS = new Set(["nota_credito", "remito"]);

export const claveProducto = (nombre: string) => normalizar(nombre);
const proveedorDe = (c: Comprobante) => c.encabezado.razonSocialEmisor.trim() || "Proveedor sin nombre";
const claveAlias = (c: Comprobante, r: Comprobante["renglones"][number]) =>
  `${c.encabezado.cuitEmisor.replace(/\D/g, "") || normalizar(proveedorDe(c))}|${r.codigo.trim() ? `c:${normalizar(r.codigo)}` : `d:${normalizar(r.descripcion)}`}`;

// ───────────── De las facturas confirmadas a Productos ─────────────

let procesando = false;

/** Pasa a Productos las facturas confirmadas que falten (también las viejas). Lo llama el barrido cada minuto. */
export async function procesarPendientes(): Promise<void> {
  if (procesando) return;
  procesando = true;
  try {
    const pendientes = await db
      .select()
      .from(comprobante)
      .where(and(eq(comprobante.estado, "confirmado"), isNull(comprobante.productosEn), lt(comprobante.productosIntentos, MAX_INTENTOS)))
      .orderBy(asc(comprobante.id))
      .limit(20);
    for (const fila of pendientes) {
      try {
        await registrarComprobante(fila);
      } catch (err) {
        await db
          .update(comprobante)
          .set({ productosIntentos: sql`${comprobante.productosIntentos} + 1` })
          .where(eq(comprobante.id, fila.id));
        await registrar("aviso", "productos", `No se pudieron pasar a Productos los renglones del comprobante ${fila.id}`, err);
      }
    }
    if (pendientes.length) {
      await sincronizarNombres();
      bus.avisar("compras");
    }
  } finally {
    procesando = false;
  }
}

async function registrarComprobante(fila: FilaComprobante) {
  const c = leerDatos(fila);
  const costos = costosFinales(c);
  const renglones = SIN_PRECIOS.has(c.encabezado.tipo) ? [] : c.renglones.flatMap((r, i) => (r.cantidad > 0 && costos[i] > 0 ? [{ r, i, alias: claveAlias(c, r) }] : []));

  // Los renglones que ya se conocen (mismo proveedor y código o descripción) no pasan por la IA.
  const conocidos = new Map<string, { productoId: number; ultima: PrecioProducto | null }>();
  if (renglones.length) {
    const alias = await db.select().from(productoAlias).where(inArray(productoAlias.clave, renglones.map((x) => x.alias)));
    for (const a of alias) {
      const [ultima] = await db.select().from(precioProducto).where(eq(precioProducto.aliasClave, a.clave)).orderBy(sql`${precioProducto.id} desc`).limit(1);
      conocidos.set(a.clave, { productoId: a.productoId, ultima: ultima ?? null });
    }
  }
  const nuevos = renglones.filter((x) => !conocidos.has(x.alias));
  const normalizados = new Map<number, ProductoNormalizado>();
  if (nuevos.length) {
    const lista = await normalizarRenglones(
      await obtenerConfig(),
      proveedorDe(c),
      nuevos.map(({ r, i }) => ({ renglon: i + 1, codigo: r.codigo, descripcion: r.descripcion, cantidad: r.cantidad, unidad: r.unidad, unidadesPorBulto: r.unidadesPorBulto })),
      await existentesPara(fila.proveedorId),
    );
    for (const n of lista) normalizados.set(n.renglon - 1, n);
  }

  await db.transaction(async (tx) => {
    // Idempotente: si se vuelve a procesar, se rehacen sus precios.
    await tx.delete(precioProducto).where(eq(precioProducto.comprobanteId, fila.id));
    for (const { r, i, alias } of renglones) {
      const conocido = conocidos.get(alias);
      const n = normalizados.get(i);
      if (!conocido && !n?.nombre.trim()) continue;
      let productoId = conocido?.productoId;
      if (!productoId) {
        const [p] = await tx
          .insert(producto)
          .values({
            nombre: n!.nombre.trim(),
            clave: claveProducto(n!.nombre),
            categoria: n!.categoria.trim() || "Otros",
            clase: r.clase,
            contenido: n!.contenido > 0 && n!.medida ? n!.contenido : null,
            medida: n!.medida || null,
          })
          .onConflictDoUpdate({ target: producto.clave, set: { actualizadoEn: sql`now()` } })
          .returning({ id: producto.id });
        productoId = p.id;
        await tx.insert(productoAlias).values({ clave: alias, productoId, proveedor: proveedorDe(c) }).onConflictDoNothing();
      }
      // Lo impreso manda; si no figura, se usa lo que dijo la IA o la compra anterior del mismo renglón.
      const unidadCompra = n?.unidadCompra ?? conocido?.ultima?.unidadCompra ?? "unidad";
      const unidadesPorBulto = r.unidadesPorBulto || n?.unidadesPorBulto || conocido?.ultima?.unidadesPorBulto || 0;
      await tx.insert(precioProducto).values({
        productoId,
        comprobanteId: fila.id,
        renglon: i + 1,
        aliasClave: alias,
        proveedor: proveedorDe(c),
        fecha: c.encabezado.fecha || fila.creadoEn.toISOString().slice(0, 10),
        descripcion: r.descripcion,
        cantidad: r.cantidad,
        unidadCompra,
        unidadesPorBulto,
        costoFinal: costos[i],
      });
    }
    await enlazarSegunCompras(tx, sql`c.id = ${fila.id}`);
    await tx.update(comprobante).set({ productosEn: new Date() }).where(eq(comprobante.id, fila.id));
  });
}

/** Los productos que ya existen, para que la IA los reconozca: primero los de este proveedor. */
async function existentesPara(proveedorId: number | null) {
  const campos = { id: producto.id, nombre: producto.nombre, categoria: producto.categoria };
  const delProveedor = proveedorId
    ? await db.select(campos).from(producto).innerJoin(productoProveedor, eq(productoProveedor.productoId, producto.id)).where(eq(productoProveedor.proveedorId, proveedorId))
    : [];
  const otros = await db
    .select(campos)
    .from(producto)
    .where(delProveedor.length ? notInArray(producto.id, delProveedor.map((p) => p.id)) : undefined)
    .orderBy(sql`${producto.id} desc`)
    .limit(1500);
  return { delProveedor, otros };
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Los productos que quedaron sin ninguna compra (por editar, borrar o mover compras) se borran. */
export async function borrarHuerfanos(tx: Tx, ids: number[]) {
  if (!ids.length) return;
  await tx
    .delete(producto)
    .where(and(inArray(producto.id, ids), notExists(tx.select({ uno: sql`1` }).from(precioProducto).where(eq(precioProducto.productoId, producto.id)))));
}

// ───────────── Consultas ─────────────

/** Cada compra con el proveedor de su comprobante (null si la compra no tiene proveedor). */
type FilaPrecio = PrecioProducto & { proveedorId: number | null };
export type Compra = FilaPrecio & { precios: Precios; variacion: number | null };
/** Un proveedor que vende el producto, con lo que se le compró (ultima null si todavía nada). */
type ProveedorDelProducto = { proveedorId: number; proveedor: string; oculto: boolean; compras: number; ultima: Compra | null };
export type ResumenProducto = Producto & {
  ultima: Compra | null;
  variacion: number | null;
  alerta: boolean;
  proveedores: ProveedorDelProducto[];
  compras: number;
};
type Enlace = Omit<ProveedorDelProducto, "compras" | "ultima">;

/** Precios y variación de cada compra (contra la anterior del mismo producto) y lo de cada proveedor que lo vende. */
function armar(p: Producto, filas: FilaPrecio[], enlaces: Enlace[], alertaPct: number): ResumenProducto & { historial: Compra[] } {
  const historial: Compra[] = [];
  for (const f of filas) {
    const precios = preciosDe(f, p);
    const anterior = historial.at(-1);
    historial.push({ ...f, precios, variacion: anterior ? variacion(precios, anterior.precios) : null });
  }
  const ultima = historial.at(-1) ?? null;
  return {
    ...p,
    ultima,
    variacion: ultima?.variacion ?? null,
    alerta: (ultima?.variacion ?? 0) >= alertaPct,
    proveedores: enlaces.map((e) => {
      const suyas = historial.filter((h) => h.proveedorId === e.proveedorId);
      return { ...e, compras: suyas.length, ultima: suyas.at(-1) ?? null };
    }),
    compras: historial.length,
    historial,
  };
}

const enOrden = [asc(precioProducto.fecha), asc(precioProducto.id)];

/** Agrupa por producto. */
function porProducto<T extends { productoId: number }>(lista: T[]) {
  const grupos = new Map<number, T[]>();
  for (const x of lista) {
    const grupo = grupos.get(x.productoId);
    if (grupo) grupo.push(x);
    else grupos.set(x.productoId, [x]);
  }
  return grupos;
}

/** Las compras (con su proveedor) y los proveedores enlazados, de un producto o de todos. */
async function comprasYEnlaces(productoId?: number) {
  const [filas, enlaces] = await Promise.all([
    db
      .select({ precio: precioProducto, proveedorId: comprobante.proveedorId })
      .from(precioProducto)
      .innerJoin(comprobante, eq(comprobante.id, precioProducto.comprobanteId))
      .where(productoId ? eq(precioProducto.productoId, productoId) : undefined)
      .orderBy(...enOrden),
    db
      .select({ productoId: productoProveedor.productoId, proveedorId: proveedor.id, proveedor: proveedor.nombre, oculto: proveedor.oculto })
      .from(productoProveedor)
      .innerJoin(proveedor, eq(proveedor.id, productoProveedor.proveedorId))
      .where(productoId ? eq(productoProveedor.productoId, productoId) : undefined)
      .orderBy(asc(proveedor.nombre)),
  ]);
  return { compras: porProducto(filas.map((f) => ({ ...f.precio, proveedorId: f.proveedorId }))), enlaces: porProducto(enlaces) };
}

const sinProducto = ({ productoId: _, ...e }: Enlace & { productoId: number }): Enlace => e;

export async function listarProductos(): Promise<ResumenProducto[]> {
  const [{ productosAlertaPct }, productos, { compras, enlaces }] = await Promise.all([obtenerConfig(), db.select().from(producto).orderBy(asc(producto.nombre)), comprasYEnlaces()]);
  return productos.map((p) => {
    const { historial: _, ...resumen } = armar(p, compras.get(p.id) ?? [], (enlaces.get(p.id) ?? []).map(sinProducto), productosAlertaPct);
    return resumen;
  });
}

export async function obtenerProducto(id: number) {
  const [p] = await db.select().from(producto).where(eq(producto.id, id));
  if (!p) throw new ErrorUsuario("No existe ese producto");
  const [{ compras, enlaces }, alias, { productosAlertaPct }] = await Promise.all([
    comprasYEnlaces(id),
    db.select().from(productoAlias).where(eq(productoAlias.productoId, id)),
    obtenerConfig(),
  ]);
  return { ...armar(p, compras.get(id) ?? [], (enlaces.get(id) ?? []).map(sinProducto), productosAlertaPct), alias };
}

/** Los productos que vende un proveedor, con cuántas veces y cuándo se le compraron por última vez (null si todavía no). */
export async function productosDeProveedor(proveedorId: number) {
  const [enlazados, filas] = await Promise.all([
    db
      .select({ producto })
      .from(productoProveedor)
      .innerJoin(producto, eq(producto.id, productoProveedor.productoId))
      .where(eq(productoProveedor.proveedorId, proveedorId))
      .orderBy(asc(producto.nombre)),
    db
      .select({ precio: precioProducto })
      .from(precioProducto)
      .innerJoin(comprobante, eq(comprobante.id, precioProducto.comprobanteId))
      .where(eq(comprobante.proveedorId, proveedorId))
      .orderBy(...enOrden),
  ]);
  const suyas = porProducto(filas.map((f) => f.precio));
  return enlazados.map(({ producto: p }) => {
    const compras = suyas.get(p.id) ?? [];
    const u = compras.at(-1);
    return {
      id: p.id,
      nombre: p.nombre,
      categoria: p.categoria,
      compras: compras.length,
      ultima: u ? { fecha: u.fecha, unidadesPorBulto: u.unidadesPorBulto, precios: preciosDe(u, p) } : null,
    };
  });
}

/** A qué producto fue cada renglón de un comprobante (cuando ya pasó a Productos). */
export async function productosDeComprobante(comprobanteId: number) {
  return db
    .select({ renglon: precioProducto.renglon, productoId: producto.id, nombre: producto.nombre })
    .from(precioProducto)
    .innerJoin(producto, eq(producto.id, precioProducto.productoId))
    .where(eq(precioProducto.comprobanteId, comprobanteId))
    .orderBy(asc(precioProducto.renglon));
}

// ───────────── Cambios a mano ─────────────

export async function actualizarProducto(id: number, c: { nombre?: string; categoria?: string; clase?: Producto["clase"]; contenido?: number | null; medida?: Producto["medida"] }) {
  const cambios: Partial<typeof producto.$inferInsert> = { ...c, actualizadoEn: new Date() };
  if (c.nombre !== undefined) {
    const clave = claveProducto(c.nombre);
    const [otro] = await db.select({ id: producto.id }).from(producto).where(eq(producto.clave, clave));
    if (otro && otro.id !== id) throw new ErrorUsuario("Ya hay un producto con ese nombre: usá “Juntar con…”.");
    Object.assign(cambios, { nombre: c.nombre.trim(), clave });
  }
  if (c.contenido !== undefined && (!c.contenido || !c.medida)) Object.assign(cambios, { contenido: null, medida: null });
  const filas = await db.update(producto).set(cambios).where(eq(producto.id, id)).returning({ id: producto.id });
  if (!filas.length) throw new ErrorUsuario("No existe ese producto");
  bus.avisar("compras");
}

/** Junta dos productos que son el mismo: las compras, los alias y los proveedores pasan al otro. */
export async function juntarProductos(id: number, conId: number) {
  if (id === conId) throw new ErrorUsuario("Elegí otro producto.");
  await db.transaction(async (tx) => {
    await tx.update(precioProducto).set({ productoId: conId }).where(eq(precioProducto.productoId, id));
    await tx.update(productoAlias).set({ productoId: conId }).where(eq(productoAlias.productoId, id));
    await tx.execute(sql`
      insert into producto_proveedor (producto_id, proveedor_id)
      select ${conId}::int, proveedor_id from producto_proveedor where producto_id = ${id}
      on conflict do nothing`);
    await tx.delete(producto).where(eq(producto.id, id));
  });
  bus.avisar("compras");
}

/** Separa lo que se compró con un alias (proveedor + código o descripción) en un producto aparte. */
export async function separarAlias(id: number, aliasClave: string): Promise<number> {
  const { alias, ...p } = await obtenerProducto(id);
  const a = alias.find((x) => x.clave === aliasClave);
  if (!a) throw new ErrorUsuario("Ese proveedor no está en este producto.");
  if (alias.length === 1) throw new ErrorUsuario("Es el único proveedor de este producto: no hay nada para separar.");
  const nombre = `${p.nombre} (${a.proveedor})`;
  return db.transaction(async (tx) => {
    const [nuevo] = await tx
      .insert(producto)
      .values({ nombre, clave: claveProducto(nombre), categoria: p.categoria, clase: p.clase, contenido: p.contenido, medida: p.medida })
      .returning({ id: producto.id });
    await tx.update(productoAlias).set({ productoId: nuevo.id }).where(eq(productoAlias.clave, aliasClave));
    await tx.update(precioProducto).set({ productoId: nuevo.id }).where(eq(precioProducto.aliasClave, aliasClave));
    await enlazarSegunCompras(tx, sql`p.producto_id = ${nuevo.id}`);
    bus.avisar("compras");
    return nuevo.id;
  });
}

/**
 * Corrige a qué producto fue un renglón de una factura. Vale también para las otras compras con el mismo código o
 * descripción de ese proveedor, y para las que vengan. El producto anterior deja de estar enlazado al proveedor si
 * ya no se le compró, y se borra si quedó sin compras.
 */
export async function reasignarRenglon(comprobanteId: number, renglon: number, productoId: number) {
  const [fila] = await db
    .select({ precio: precioProducto, proveedorId: comprobante.proveedorId })
    .from(precioProducto)
    .innerJoin(comprobante, eq(comprobante.id, precioProducto.comprobanteId))
    .where(and(eq(precioProducto.comprobanteId, comprobanteId), eq(precioProducto.renglon, renglon)));
  if (!fila) throw new ErrorUsuario("Ese renglón todavía no pasó a Productos.");
  const [destino] = await db.select({ id: producto.id }).from(producto).where(eq(producto.id, productoId));
  if (!destino) throw new ErrorUsuario("No existe ese producto");
  const { aliasClave, productoId: anterior } = fila.precio;
  if (anterior === productoId) return;
  await db.transaction(async (tx) => {
    await tx.update(productoAlias).set({ productoId }).where(eq(productoAlias.clave, aliasClave));
    await tx.update(precioProducto).set({ productoId }).where(eq(precioProducto.aliasClave, aliasClave));
    await enlazarSegunCompras(tx, sql`p.alias_clave = ${aliasClave}`);
    if (fila.proveedorId)
      await tx.execute(sql`
        delete from producto_proveedor pp
        where pp.producto_id = ${anterior} and pp.proveedor_id = ${fila.proveedorId}
          and not exists (
            select 1 from precio_producto p join comprobante c on c.id = p.comprobante_id
            where p.producto_id = ${anterior} and c.proveedor_id = ${fila.proveedorId})`);
    await borrarHuerfanos(tx, [anterior]);
  });
  bus.avisar("compras");
}

/** Corrige cómo vino una compra (ej. la caja trae 12 y no 15). */
export async function actualizarCompra(id: number, c: { unidadCompra?: PrecioProducto["unidadCompra"]; unidadesPorBulto?: number }) {
  await db.update(precioProducto).set(c).where(eq(precioProducto.id, id));
  bus.avisar("compras");
}

// ───────────── Excel ─────────────

/** CSV para Excel con la lista de productos y su último precio. */
export async function productosCsv(): Promise<string> {
  const filas = (await listarProductos()).map((p) => {
    const u = p.ultima;
    return [
      celda(p.nombre),
      celda(p.categoria),
      p.clase === "gasto" ? "Gasto" : "Mercadería",
      celda(u?.proveedor ?? ""),
      u?.fecha ?? "",
      numero(u?.precios.bulto),
      numero(u?.precios.unidad),
      numero(u?.precios.porMedida?.valor),
      u?.precios.porMedida?.medida ?? "",
      numero(p.variacion),
    ].join(";");
  });
  const titulos = "Producto;Categoría;Clase;Último proveedor;Fecha;Precio bulto;Precio unidad;Precio kg/l;Medida;Variación %";
  return csv([titulos, ...filas]);
}
