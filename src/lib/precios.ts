import type { UnidadCompra } from "../db/schema.js";
import type { Comprobante } from "./comprobantes.js";

const suma = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/**
 * Lo que costó cada renglón: con IVA e impuestos internos, sin percepciones, con descuentos y bonificación.
 * Se reparte el total del comprobante (sin percepciones) según el importe de cada renglón. Si los renglones
 * vienen netos (factura A), cada uno pesa con su alícuota de IVA; si ya traen los impuestos (o es B o C), igual.
 */
export function costosFinales(c: Comprobante): number[] {
  const importes = c.renglones.map((r) => r.importe);
  const costoTotal = c.pie.total - suma(c.pie.percepciones.map((p) => p.importe));
  const ivas = suma(c.pie.ivas.map((i) => i.importe));
  if (costoTotal <= 0 || suma(importes) <= 0) return importes;
  const netos = ivas > 0 && suma(importes) < costoTotal - ivas / 2;
  const pesos = c.renglones.map((r) => r.importe * (netos && r.alicuotaIva > 0 ? 1 + r.alicuotaIva / 100 : 1));
  const factor = costoTotal / suma(pesos);
  return pesos.map((p) => p * factor);
}

export type DatosCompra = { costoFinal: number; cantidad: number; unidadCompra: UnidadCompra; unidadesPorBulto: number };
export type Contenido = { contenido: number | null; medida: "kg" | "l" | null };
export type Precios = { bulto: number | null; unidad: number | null; porMedida: { valor: number; medida: "kg" | "l" } | null };

/** Precio por bulto, por unidad y por kg o litro (cuando se sabe el contenido). */
export function preciosDe(c: DatosCompra, p: Contenido): Precios {
  const porCompra = c.costoFinal / c.cantidad;
  const bulto = c.unidadCompra === "bulto" ? porCompra : null;
  const unidad = c.unidadCompra === "unidad" ? porCompra : bulto !== null && c.unidadesPorBulto > 0 ? bulto / c.unidadesPorBulto : null;
  const porMedida =
    c.unidadCompra === "kg" || c.unidadCompra === "litro"
      ? { valor: porCompra, medida: c.unidadCompra === "kg" ? ("kg" as const) : ("l" as const) }
      : unidad !== null && p.contenido && p.medida
        ? { valor: unidad / p.contenido, medida: p.medida }
        : null;
  return { bulto, unidad, porMedida };
}

/** El precio con el que se comparan las compras: por kg o litro, si no por unidad, si no por bulto. */
function referencia(p: Precios): { valor: number; base: string } | null {
  if (p.porMedida) return { valor: p.porMedida.valor, base: p.porMedida.medida };
  if (p.unidad !== null) return { valor: p.unidad, base: "unidad" };
  if (p.bulto !== null) return { valor: p.bulto, base: "bulto" };
  return null;
}

/** Variación (%) entre dos compras, solo si se pueden comparar (misma base). */
export function variacion(actual: Precios, anterior: Precios): number | null {
  const a = referencia(actual);
  const b = referencia(anterior);
  if (!a || !b || a.base !== b.base || b.valor <= 0) return null;
  return ((a.valor - b.valor) / b.valor) * 100;
}
