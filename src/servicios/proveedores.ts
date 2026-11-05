import { and, asc, eq, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { comprobante, formaPago, producto, productoAlias, productoProveedor, proveedor, type Proveedor } from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { ahora } from "../lib/fechas.js";
import { normalizar } from "../lib/textos.js";
import { exigirFormaPago } from "./formas-pago.js";
import { ErrorUsuario } from "./recordatorios.js";

const claveProveedor = (nombre: string) => normalizar(nombre);
const soloNumeros = (cuit: string) => cuit.replace(/\D/g, "") || null;

/**
 * El proveedor de una factura: por CUIT y, si no, por nombre. Si no existe, se crea.
 * null si la factura no trae ni CUIT ni nombre.
 */
export async function proveedorPara(nombre: string, cuit: string): Promise<number | null> {
  const n = nombre.trim();
  const c = soloNumeros(cuit);
  if (!n && !c) return null;
  const buscar = async () => {
    const [porCuit] = c ? await db.select().from(proveedor).where(eq(proveedor.cuit, c)) : [];
    if (porCuit) return porCuit;
    const [porNombre] = n ? await db.select().from(proveedor).where(eq(proveedor.clave, claveProveedor(n))) : [];
    // Un proveedor cargado a mano se completa con el CUIT de su primera factura.
    if (porNombre && c && !porNombre.cuit) await db.update(proveedor).set({ cuit: c }).where(eq(proveedor.id, porNombre.id));
    return porNombre ?? null;
  };
  const existente = await buscar();
  if (existente) return existente.id;
  const nombreNuevo = n || `CUIT ${c}`;
  const [nuevo] = await db.insert(proveedor).values({ nombre: nombreNuevo, clave: claveProveedor(nombreNuevo), cuit: c }).onConflictDoNothing().returning();
  bus.avisar("compras");
  // Si otro lo creó al mismo tiempo, se usa ese.
  return nuevo?.id ?? (await buscar())?.id ?? null;
}

/**
 * Enlaza cada producto con el proveedor al que se le compró, según las compras que cumplen la condición
 * (sobre precio_producto "p" y comprobante "c"). Lo ya enlazado queda como está.
 */
export async function enlazarSegunCompras(tx: Pick<typeof db, "execute">, condicion: SQL) {
  await tx.execute(sql`
    insert into producto_proveedor (producto_id, proveedor_id)
    select distinct p.producto_id, c.proveedor_id
    from precio_producto p join comprobante c on c.id = p.comprobante_id
    where c.proveedor_id is not null and ${condicion}
    on conflict do nothing`);
}

/** Desde la ficha: el proveedor vende este producto, aunque todavía no se le haya comprado. */
export async function enlazarProducto(proveedorId: number, productoId: number) {
  await obtenerProveedor(proveedorId);
  const [p] = await db.select({ id: producto.id }).from(producto).where(eq(producto.id, productoId));
  if (!p) throw new ErrorUsuario("No existe ese producto");
  await db.insert(productoProveedor).values({ proveedorId, productoId }).onConflictDoNothing();
  bus.avisar("compras");
}

/** Ya no se lo vende: deja de sugerirse al cargar (sus compras quedan). Si se le vuelve a comprar, se enlaza solo. */
export async function desenlazarProducto(proveedorId: number, productoId: number) {
  await db.delete(productoProveedor).where(and(eq(productoProveedor.proveedorId, proveedorId), eq(productoProveedor.productoId, productoId)));
  bus.avisar("compras");
}

/** Productos guarda el nombre del proveedor de cada compra: se mantiene igual al de Proveedores. */
export async function sincronizarNombres() {
  await db.execute(sql`
    update precio_producto p set proveedor = pr.nombre
    from comprobante c join proveedor pr on pr.id = c.proveedor_id
    where p.comprobante_id = c.id and p.proveedor <> pr.nombre`);
}

export type ResumenProveedor = Proveedor & { compras: number; esteMes: number; mesAnterior: number; ultimaCompra: string | null };

/** La fecha de cada compra ("2026-11-05"): la de la factura o, si no tiene, la de la carga. */
export const fechaDeCompra = sql`coalesce(${comprobante.fecha}, to_char(${comprobante.creadoEn}, 'YYYY-MM-DD'))`;
const mesDeCompra = sql`left(${fechaDeCompra}, 7)`;
const comprada = ne(comprobante.estado, "descartado");

/** Proveedores con lo que se les compró (sin contar lo descartado). */
export async function listarProveedores(incluirOcultos = false, id?: number): Promise<ResumenProveedor[]> {
  const hoy = ahora();
  const totales = db
    .select({
      proveedorId: comprobante.proveedorId,
      compras: sql<number>`count(*)::int`.as("compras"),
      esteMes: sql<string>`coalesce(sum(${comprobante.total}) filter (where ${mesDeCompra} = ${hoy.toFormat("yyyy-MM")}), 0)`.as("este_mes"),
      mesAnterior: sql<string>`coalesce(sum(${comprobante.total}) filter (where ${mesDeCompra} = ${hoy.minus({ months: 1 }).toFormat("yyyy-MM")}), 0)`.as("mes_anterior"),
      ultimaCompra: sql<string | null>`max(coalesce(${comprobante.fecha}, to_char(${comprobante.creadoEn}, 'YYYY-MM-DD')))`.as("ultima_compra"),
    })
    .from(comprobante)
    .where(and(isNotNull(comprobante.proveedorId), comprada))
    .groupBy(comprobante.proveedorId)
    .as("totales");
  const filas = await db
    .select({ proveedor, compras: totales.compras, esteMes: totales.esteMes, mesAnterior: totales.mesAnterior, ultimaCompra: totales.ultimaCompra })
    .from(proveedor)
    .leftJoin(totales, eq(totales.proveedorId, proveedor.id))
    .where(and(incluirOcultos ? undefined : eq(proveedor.oculto, false), id ? eq(proveedor.id, id) : undefined))
    .orderBy(asc(proveedor.nombre));
  return filas.map((f) => ({
    ...f.proveedor,
    compras: f.compras ?? 0,
    esteMes: Number(f.esteMes ?? 0),
    mesAnterior: Number(f.mesAnterior ?? 0),
    ultimaCompra: f.ultimaCompra ?? null,
  }));
}

export async function obtenerProveedor(id: number): Promise<ResumenProveedor> {
  const [p] = await listarProveedores(true, id);
  if (!p) throw new ErrorUsuario("No existe ese proveedor");
  return p;
}

/** Lo que se le pagó este mes en cada forma de pago, en el orden de las formas (forma null = sin especificar, al final). */
export async function pagosDelMes(id: number): Promise<{ forma: string | null; total: number }[]> {
  const filas = await db
    .select({ forma: formaPago.nombre, total: sql<string>`sum(${comprobante.total})` })
    .from(comprobante)
    .leftJoin(formaPago, eq(formaPago.id, comprobante.formaPagoId))
    .where(and(eq(comprobante.proveedorId, id), comprada, sql`${mesDeCompra} = ${ahora().toFormat("yyyy-MM")}`))
    .groupBy(formaPago.id)
    .orderBy(sql`${formaPago.orden} nulls last`);
  return filas.map((f) => ({ forma: f.forma, total: Number(f.total ?? 0) }));
}

async function exigirNombreLibre(nombre: string, salvoId?: number) {
  const [otro] = await db.select({ id: proveedor.id }).from(proveedor).where(eq(proveedor.clave, claveProveedor(nombre)));
  if (otro && otro.id !== salvoId) throw new ErrorUsuario("Ya hay un proveedor con ese nombre.");
}

export async function crearProveedor(nombre: string, notas = "", formaPagoId: number | null = null): Promise<Proveedor> {
  await Promise.all([exigirNombreLibre(nombre), exigirFormaPago(formaPagoId)]);
  const [p] = await db.insert(proveedor).values({ nombre: nombre.trim(), clave: claveProveedor(nombre), notas: notas.trim(), formaPagoId }).returning();
  bus.avisar("compras");
  return p;
}

/** Cambiar el nombre lo cambia también en todas sus compras y en Productos. */
export async function actualizarProveedor(id: number, c: { nombre?: string; notas?: string; oculto?: boolean; formaPagoId?: number | null }) {
  const actual = await obtenerProveedor(id);
  const cambios: Partial<typeof proveedor.$inferInsert> = { actualizadoEn: new Date() };
  if (c.notas !== undefined) cambios.notas = c.notas.trim();
  if (c.oculto !== undefined) cambios.oculto = c.oculto;
  if (c.formaPagoId !== undefined) {
    await exigirFormaPago(c.formaPagoId);
    cambios.formaPagoId = c.formaPagoId;
  }
  const nombre = c.nombre?.trim();
  if (nombre && nombre !== actual.nombre) {
    await exigirNombreLibre(nombre, id);
    Object.assign(cambios, { nombre, clave: claveProveedor(nombre) });
  }
  await db.transaction(async (tx) => {
    await tx.update(proveedor).set(cambios).where(eq(proveedor.id, id));
    if (cambios.nombre) await tx.update(productoAlias).set({ proveedor: cambios.nombre }).where(eq(productoAlias.proveedor, actual.nombre));
  });
  if (cambios.nombre) await sincronizarNombres();
  bus.avisar("compras");
}

/** Solo se borra si no tiene compras; si tiene, se oculta. */
export async function borrarProveedor(id: number) {
  const p = await obtenerProveedor(id);
  if (p.compras) throw new ErrorUsuario("Tiene compras: no se puede borrar. Si no lo usás más, ocultalo.");
  await db.delete(proveedor).where(eq(proveedor.id, id));
  bus.avisar("compras");
}

/** Junta dos proveedores que son el mismo: las compras y los productos pasan al otro (y se queda con el CUIT y la forma de pago si no tenía). */
export async function juntarProveedores(id: number, conId: number) {
  if (id === conId) throw new ErrorUsuario("Elegí otro proveedor.");
  const [origen, destino] = await Promise.all([obtenerProveedor(id), obtenerProveedor(conId)]);
  await db.transaction(async (tx) => {
    await tx.update(comprobante).set({ proveedorId: conId }).where(eq(comprobante.proveedorId, id));
    await tx.execute(sql`
      insert into producto_proveedor (producto_id, proveedor_id)
      select producto_id, ${conId}::int from producto_proveedor where proveedor_id = ${id}
      on conflict do nothing`);
    await tx.update(productoAlias).set({ proveedor: destino.nombre }).where(eq(productoAlias.proveedor, origen.nombre));
    await tx.delete(proveedor).where(eq(proveedor.id, id));
    const notas = [destino.notas, origen.notas].filter(Boolean).join("\n");
    await tx
      .update(proveedor)
      .set({ notas, cuit: destino.cuit ?? origen.cuit, formaPagoId: destino.formaPagoId ?? origen.formaPagoId, actualizadoEn: new Date() }).where(eq(proveedor.id, conId));
  });
  await sincronizarNombres();
  bus.avisar("compras");
}

/** Para la compra sin factura: el nombre del proveedor elegido (debe existir). */
export async function nombreDeProveedor(id: number): Promise<string> {
  const [p] = await db.select({ nombre: proveedor.nombre }).from(proveedor).where(eq(proveedor.id, id));
  if (!p) throw new ErrorUsuario("Ese proveedor ya no existe.");
  return p.nombre;
}
