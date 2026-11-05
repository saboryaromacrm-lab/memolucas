import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { comprobante, formaPago, proveedor, type FormaPago } from "../db/schema.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { ErrorUsuario } from "./recordatorios.js";

export type ResumenFormaPago = FormaPago & { compras: number };

/** Las formas de pago en su orden, con en cuántas compras se usó cada una (sin contar lo descartado). */
export async function listarFormasPago(incluirOcultas = false): Promise<ResumenFormaPago[]> {
  const usos = db
    .select({ formaPagoId: comprobante.formaPagoId, compras: sql<number>`count(*)::int`.as("compras") })
    .from(comprobante)
    .where(ne(comprobante.estado, "descartado"))
    .groupBy(comprobante.formaPagoId)
    .as("usos");
  const filas = await db
    .select({ forma: formaPago, compras: usos.compras })
    .from(formaPago)
    .leftJoin(usos, eq(usos.formaPagoId, formaPago.id))
    .where(incluirOcultas ? undefined : eq(formaPago.oculta, false))
    .orderBy(asc(formaPago.orden), asc(formaPago.id));
  return filas.map((f) => ({ ...f.forma, compras: f.compras ?? 0 }));
}

/** Para guardar una compra o un proveedor: la forma elegida tiene que existir (null = sin forma). */
export async function exigirFormaPago(id: number | null | undefined) {
  if (!id) return;
  const [f] = await db.select({ id: formaPago.id }).from(formaPago).where(eq(formaPago.id, id));
  if (!f) throw new ErrorUsuario("Esa forma de pago ya no existe.");
}

/** La forma a preelegir: la que dice la factura y, si no dice, la habitual del proveedor. Nunca una oculta. */
export async function sugerirFormaPago(medio: string, proveedorId: number | null): Promise<number | null> {
  const [porMedio] = medio ? await db.select({ id: formaPago.id }).from(formaPago).where(and(eq(formaPago.medio, medio), eq(formaPago.oculta, false))) : [];
  if (porMedio) return porMedio.id;
  if (!proveedorId) return null;
  const [habitual] = await db
    .select({ id: formaPago.id })
    .from(proveedor)
    .innerJoin(formaPago, eq(formaPago.id, proveedor.formaPagoId))
    .where(and(eq(proveedor.id, proveedorId), eq(formaPago.oculta, false)));
  return habitual?.id ?? null;
}

async function exigirNombreLibre(nombre: string, salvoId?: number) {
  const [otra] = await db.select({ id: formaPago.id }).from(formaPago).where(eq(formaPago.clave, normalizar(nombre)));
  if (otra && otra.id !== salvoId) throw new ErrorUsuario("Ya hay una forma de pago con ese nombre.");
}

async function obtenerFormaPago(id: number): Promise<ResumenFormaPago> {
  const f = (await listarFormasPago(true)).find((x) => x.id === id);
  if (!f) throw new ErrorUsuario("No existe esa forma de pago");
  return f;
}

/** Las nuevas van al final de la lista. */
export async function crearFormaPago(nombre: string): Promise<FormaPago> {
  await exigirNombreLibre(nombre);
  const [nueva] = await db
    .insert(formaPago)
    .values({ nombre: nombre.trim(), clave: normalizar(nombre), orden: sql`(select coalesce(max(${formaPago.orden}), 0) + 1 from ${formaPago})` })
    .returning();
  bus.avisar("compras");
  return nueva;
}

export async function actualizarFormaPago(id: number, c: { nombre?: string; oculta?: boolean }) {
  await obtenerFormaPago(id);
  const cambios: Partial<typeof formaPago.$inferInsert> = {};
  if (c.oculta !== undefined) cambios.oculta = c.oculta;
  if (c.nombre) {
    await exigirNombreLibre(c.nombre, id);
    Object.assign(cambios, { nombre: c.nombre.trim(), clave: normalizar(c.nombre) });
  }
  if (Object.keys(cambios).length) await db.update(formaPago).set(cambios).where(eq(formaPago.id, id));
  bus.avisar("compras");
}

/** Sube (-1) o baja (1) un lugar en la lista; de paso, deja el orden numerado 1, 2, 3… */
export async function moverFormaPago(id: number, paso: -1 | 1) {
  const lista = await listarFormasPago(true);
  const i = lista.findIndex((f) => f.id === id);
  if (i < 0) throw new ErrorUsuario("No existe esa forma de pago");
  const j = i + paso;
  if (j < 0 || j >= lista.length) return;
  [lista[i], lista[j]] = [lista[j], lista[i]];
  await db.transaction(async (tx) => {
    for (const [n, f] of lista.entries()) if (f.orden !== n + 1) await tx.update(formaPago).set({ orden: n + 1 }).where(eq(formaPago.id, f.id));
  });
  bus.avisar("compras");
}

/** Solo se borra si no se usó; si se usó, se oculta. */
export async function borrarFormaPago(id: number) {
  const f = await obtenerFormaPago(id);
  if (f.compras) throw new ErrorUsuario("Se usó en compras: no se puede borrar. Si no la usás más, ocultala.");
  await db.delete(formaPago).where(eq(formaPago.id, id));
  bus.avisar("compras");
}
