import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { comprobante, precioProducto, producto, productoAlias, type FilaComprobante, type PrecioProducto, type Producto } from "../db/schema.js";
import { normalizarRenglones, type ProductoNormalizado } from "../bot/ia-productos.js";
import type { Comprobante } from "../lib/comprobantes.js";
import { bus } from "../lib/eventos.js";
import { registrar } from "../lib/log.js";
import { costosFinales, preciosDe, variacion, type Precios } from "../lib/precios.js";
import { normalizar } from "../lib/textos.js";
import { leerDatos } from "./compras.js";
import { obtenerConfig } from "./configuracion.js";
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
    if (pendientes.length) bus.avisar("compras");
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
    const existentes = await db.select({ nombre: producto.nombre, categoria: producto.categoria }).from(producto).orderBy(sql`${producto.id} desc`).limit(1500);
    const lista = await normalizarRenglones(
      await obtenerConfig(),
      proveedorDe(c),
      nuevos.map(({ r, i }) => ({ renglon: i + 1, codigo: r.codigo, descripcion: r.descripcion, cantidad: r.cantidad, unidad: r.unidad, unidadesPorBulto: r.unidadesPorBulto })),
      existentes,
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
    await tx.update(comprobante).set({ productosEn: new Date() }).where(eq(comprobante.id, fila.id));
  });
}

// ───────────── Consultas ─────────────

export type Compra = PrecioProducto & { precios: Precios; variacion: number | null };
export type ResumenProducto = Producto & {
  ultima: Compra | null;
  variacion: number | null;
  alerta: boolean;
  proveedores: { proveedor: string; ultima: Compra }[];
  compras: number;
};

/** Precios y variación de cada compra (contra la anterior del mismo producto). */
function armar(p: Producto, filas: PrecioProducto[], alertaPct: number): ResumenProducto & { historial: Compra[] } {
  const historial: Compra[] = [];
  for (const f of filas) {
    const precios = preciosDe(f, p);
    const anterior = historial.at(-1);
    historial.push({ ...f, precios, variacion: anterior ? variacion(precios, anterior.precios) : null });
  }
  const ultima = historial.at(-1) ?? null;
  const porProveedor = new Map<string, Compra>();
  for (const h of historial) porProveedor.set(h.proveedor, h);
  return {
    ...p,
    ultima,
    variacion: ultima?.variacion ?? null,
    alerta: (ultima?.variacion ?? 0) >= alertaPct,
    proveedores: [...porProveedor].map(([proveedor, u]) => ({ proveedor, ultima: u })),
    compras: historial.length,
    historial,
  };
}

const enOrden = [asc(precioProducto.fecha), asc(precioProducto.id)];

export async function listarProductos(): Promise<ResumenProducto[]> {
  const { productosAlertaPct } = await obtenerConfig();
  const [productos, filas] = await Promise.all([db.select().from(producto).orderBy(asc(producto.nombre)), db.select().from(precioProducto).orderBy(...enOrden)]);
  const porProducto = new Map<number, PrecioProducto[]>();
  for (const f of filas) {
    const lista = porProducto.get(f.productoId);
    if (lista) lista.push(f);
    else porProducto.set(f.productoId, [f]);
  }
  return productos.map((p) => {
    const { historial: _, ...resumen } = armar(p, porProducto.get(p.id) ?? [], productosAlertaPct);
    return resumen;
  });
}

export async function obtenerProducto(id: number) {
  const [p] = await db.select().from(producto).where(eq(producto.id, id));
  if (!p) throw new ErrorUsuario("No existe ese producto");
  const filas = await db.select().from(precioProducto).where(eq(precioProducto.productoId, id)).orderBy(...enOrden);
  const alias = await db.select().from(productoAlias).where(eq(productoAlias.productoId, id));
  return { ...armar(p, filas, (await obtenerConfig()).productosAlertaPct), alias };
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

/** Junta dos productos que son el mismo: las compras y los alias pasan al otro. */
export async function juntarProductos(id: number, conId: number) {
  if (id === conId) throw new ErrorUsuario("Elegí otro producto.");
  await db.transaction(async (tx) => {
    await tx.update(precioProducto).set({ productoId: conId }).where(eq(precioProducto.productoId, id));
    await tx.update(productoAlias).set({ productoId: conId }).where(eq(productoAlias.productoId, id));
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
    bus.avisar("compras");
    return nuevo.id;
  });
}

/** Corrige cómo vino una compra (ej. la caja trae 12 y no 15). */
export async function actualizarCompra(id: number, c: { unidadCompra?: PrecioProducto["unidadCompra"]; unidadesPorBulto?: number }) {
  await db.update(precioProducto).set(c).where(eq(precioProducto.id, id));
  bus.avisar("compras");
}

// ───────────── Excel ─────────────

const numero = (n: number | null | undefined) => (n === null || n === undefined ? "" : n.toFixed(2).replace(".", ","));
const celda = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** CSV para Excel (separado con ; y con coma decimal, como lo abre Excel en español). */
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
  return `﻿${[titulos, ...filas].join("\r\n")}`;
}
