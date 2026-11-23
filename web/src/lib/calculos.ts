// Cálculos de la sección Calculadoras (sin pantalla, para poder probarlos).

export type Bavosi = { conDescuento: number; conIva: number; miCosto: number; total: number; unitario: number };

/** Precio → descuento → IVA → flete → markup → por unidad. Los % son números (21 = 21 %). */
export function bavosi(d: { precio: number; descuento: number; iva: number; flete: number; markup: number; cantidad: number }): Bavosi {
  const conDescuento = d.precio * (1 - d.descuento / 100);
  const conIva = conDescuento * (1 + d.iva / 100);
  const miCosto = conIva * (1 + d.flete / 100);
  const total = miCosto * (1 + d.markup / 100);
  return { conDescuento, conIva, miCosto, total, unitario: total / (d.cantidad > 0 ? d.cantidad : 1) };
}

/** Cuánto cambió (%) de un valor a otro (null si el anterior es 0). */
export const variacion = (anterior: number, nuevo: number) => (anterior === 0 ? null : ((nuevo - anterior) / anterior) * 100);

/** Qué % es la parte del total (null si el total es 0). */
export const proporcion = (parte: number, total: number) => (total === 0 ? null : (parte / total) * 100);

export type OperacionPct = { tipo: "+" | "-"; valor: number };
export type PasoPct = OperacionPct & { resultado: number };

/** Cada aumento o descuento se aplica sobre el resultado anterior: 100 +40 % +20 % −10 % → 140 → 168 → 151,2. */
export function encadenar(base: number, operaciones: OperacionPct[]): PasoPct[] {
  let actual = base;
  return operaciones.map((op) => {
    actual *= 1 + ((op.tipo === "+" ? 1 : -1) * op.valor) / 100;
    return { ...op, resultado: actual };
  });
}
