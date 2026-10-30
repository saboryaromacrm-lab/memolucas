import crypto from "node:crypto";
import { z } from "zod";

// El formato es el del instructivo de compras: la otra IA lo carga en el ERP tal cual.
// Sin campos nulables (la API los limita): "" en textos y 0 en números cuando no hay dato.

const Renglon = z.object({
  clase: z.enum(["mercaderia", "gasto"]),
  codigo: z.string(),
  descripcion: z.string(),
  cantidad: z.number(),
  unidad: z.string(),
  unidadesPorBulto: z.number(),
  precioUnitario: z.number(),
  descuentos: z.array(z.number()),
  importe: z.number(),
  alicuotaIva: z.number(),
  cierra: z.boolean(),
});

export const EsquemaComprobante = z.object({
  archivo: z.string(),
  clase: z.enum(["mercaderia", "gasto", "mixta", "dudoso"]),
  motivoClase: z.string(),
  encabezado: z.object({
    tipo: z.enum(["factura", "nota_credito", "nota_debito", "remito", "liquidacion", "ticket", "otro"]),
    letra: z.enum(["A", "B", "C", "M", "X", ""]),
    codigoArca: z.number(),
    puntoVenta: z.string(),
    numero: z.string(),
    fecha: z.string(),
    cae: z.string(),
    cuitEmisor: z.string(),
    razonSocialEmisor: z.string(),
    domicilioEmisor: z.string(),
    condicionIvaEmisor: z.enum(["responsable_inscripto", "monotributo", "exento", "otro", ""]),
    cuitReceptor: z.string(),
    razonSocialReceptor: z.string(),
    moneda: z.enum(["PES", "DOL", ""]),
    condicionVentaImpresa: z.string(),
    vencimientoPago: z.string(),
    comprobanteQueAjusta: z.string(),
  }),
  renglones: z.array(Renglon),
  pie: z.object({
    subtotal: z.number(),
    bonificacionPct: z.number(),
    bonificacionImporte: z.number(),
    ivas: z.array(z.object({ alicuota: z.number(), importe: z.number() })),
    percepciones: z.array(z.object({ nombre: z.string(), tipo: z.enum(["iva", "iibb", "otro"]), alicuota: z.number(), importe: z.number() })),
    impuestosInternos: z.number(),
    otrosImpuestos: z.number(),
    total: z.number(),
  }),
  pagoQueFigura: z.object({
    figura: z.boolean(),
    medio: z.enum(["efectivo", "transferencia", "tarjeta_debito", "tarjeta_credito", "cheque", "qr", "otro", ""]),
    fecha: z.string(),
    importe: z.number(),
    referencia: z.string(),
  }),
  controles: z.object({
    sumaRenglones: z.number(),
    cierraSubtotal: z.boolean(),
    cierraTotal: z.boolean(),
    diferencias: z.string(),
  }),
  dudas: z.array(z.string()),
});
export type Comprobante = z.infer<typeof EsquemaComprobante>;

export const EsquemaComprobantes = z.object({ comprobantes: z.array(EsquemaComprobante) });

const TOLERANCIA = 1;
const r2 = (n: number) => Math.round(n * 100) / 100;
const suma = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

export const pesos = (n: number, moneda: Comprobante["encabezado"]["moneda"] = "PES") =>
  `${moneda === "DOL" ? "US$" : "$"} ${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Rehace las cuentas por su lado (no confía en lo que anotó la IA): cada renglón, la suma contra el
 * subtotal y el total. No corrige nada: solo marca qué cierra y explica las diferencias.
 */
export function controlar(c: Comprobante): { comprobante: Comprobante; cierra: boolean; fallas: number } {
  const diferencias: string[] = [];
  const renglones = c.renglones.map((r, i) => {
    const factor = r.descuentos.reduce((f, d) => f * (1 - d / 100), 1);
    const posibles = [r.cantidad * r.precioUnitario * factor];
    // Renglones por bulto con precio por unidad ("2 cajas x 12").
    if (r.unidadesPorBulto > 0) posibles.push(r.cantidad * r.unidadesPorBulto * r.precioUnitario * factor);
    const sinPrecios = r.precioUnitario === 0 && r.importe === 0;
    const cierra = sinPrecios || posibles.some((p) => Math.abs(p - r.importe) <= TOLERANCIA);
    if (!cierra)
      diferencias.push(
        `Renglón ${i + 1} (${r.descripcion.slice(0, 40)}): ${r.cantidad} × ${pesos(r.precioUnitario)}${r.descuentos.length ? ` − ${r.descuentos.join("+")}%` : ""} da ${pesos(r2(posibles[0]))}, pero dice ${pesos(r.importe)}`,
      );
    return { ...r, cierra };
  });

  const p = c.pie;
  const sumaRenglones = r2(suma(renglones.map((r) => r.importe)));
  const tolerancia = Math.max(TOLERANCIA, 0.01 * renglones.length);
  const ivas = suma(p.ivas.map((i) => i.importe));
  const percepciones = suma(p.percepciones.map((x) => x.importe));
  // Hay proveedores (ej. bebidas) que cobran cada renglón con el IVA y los impuestos internos incluidos.
  const impuestosEnRenglones = ivas + p.impuestosInternos;
  let cierraSubtotal = true;
  if (p.subtotal > 0) {
    // Según el comprobante, el subtotal viene antes o después de la bonificación general, o es el neto sin impuestos.
    cierraSubtotal = [sumaRenglones, sumaRenglones - p.bonificacionImporte, sumaRenglones - impuestosEnRenglones].some(
      (s) => Math.abs(s - p.subtotal) <= tolerancia,
    );
    if (!cierraSubtotal) diferencias.push(`La suma de los renglones da ${pesos(sumaRenglones)} y el subtotal dice ${pesos(p.subtotal)}`);
  }

  const base = p.subtotal > 0 ? p.subtotal : sumaRenglones;
  const agregados = impuestosEnRenglones + percepciones + p.otrosImpuestos;
  const bonificacion = p.bonificacionImporte || (p.bonificacionPct ? (base * p.bonificacionPct) / 100 : 0);
  const candidatos = [base - bonificacion + agregados, base + agregados];
  // Renglones con impuestos incluidos y sin subtotal impreso: solo se suman las percepciones.
  if (impuestosEnRenglones > 0) candidatos.push(sumaRenglones - p.bonificacionImporte + percepciones + p.otrosImpuestos);
  const sinImportes = p.total === 0 && sumaRenglones === 0;
  const cierraTotal = sinImportes || (p.total > 0 && candidatos.some((t) => Math.abs(t - p.total) <= tolerancia + 0.01 * (p.ivas.length + p.percepciones.length)));
  if (!cierraTotal)
    diferencias.push(
      p.total === 0 ? "No se leyó el total" : `El total calculado da ${pesos(r2(candidatos[0]))} y el impreso dice ${pesos(p.total)}`,
    );

  const fallas = renglones.filter((r) => !r.cierra).length + (cierraSubtotal ? 0 : 1) + (cierraTotal ? 0 : 1);
  return {
    comprobante: { ...c, renglones, controles: { sumaRenglones, cierraSubtotal, cierraTotal, diferencias: diferencias.join(". ") } },
    cierra: fallas === 0,
    fallas,
  };
}

const normal = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Identifica el comprobante para no cargarlo dos veces (null si no hay datos suficientes). */
export function claveDe(c: Comprobante): string | null {
  const e = c.encabezado;
  const emisor = e.cuitEmisor.replace(/\D/g, "") || normal(e.razonSocialEmisor);
  if (!emisor) return null;
  const partes =
    e.puntoVenta && e.numero
      ? [emisor, e.tipo, e.letra, e.puntoVenta.replace(/^0+/, ""), e.numero.replace(/^0+/, "")]
      : c.pie.total > 0 && e.fecha
        ? [emisor, e.tipo, e.fecha, c.pie.total.toFixed(2)]
        : null;
  return partes ? crypto.createHash("sha256").update(partes.join("|")).digest("hex") : null;
}

const TIPOS: Record<Comprobante["encabezado"]["tipo"], string> = {
  factura: "Factura",
  nota_credito: "Nota de crédito",
  nota_debito: "Nota de débito",
  remito: "Remito",
  liquidacion: "Liquidación",
  ticket: "Ticket",
  otro: "Comprobante",
};
const CLASES: Record<Comprobante["clase"], string> = { mercaderia: "Mercadería", gasto: "Gasto", mixta: "Mixta", dudoso: "Clase dudosa" };

/** "Factura A 0012-00004567". */
export function tituloComprobante(c: Comprobante): string {
  const e = c.encabezado;
  const numero = [e.puntoVenta, e.numero].filter(Boolean).join("-");
  return [TIPOS[e.tipo], e.letra && e.letra !== "X" ? e.letra : "", numero].filter(Boolean).join(" ");
}

const fechaCorta = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : iso);

/** Resumen para WhatsApp. */
export function textoResumen(c: Comprobante, cierra: boolean): string {
  const e = c.encabezado;
  const n = c.renglones.length;
  const lineas = [
    `🧾 *${tituloComprobante(c)}*${e.fecha ? ` · ${fechaCorta(e.fecha)}` : ""}`,
    e.razonSocialEmisor || "Proveedor sin datos",
    `${n} ${n === 1 ? "renglón" : "renglones"} · ${CLASES[c.clase]}`,
    `Total *${pesos(c.pie.total, e.moneda)}*${cierra ? " ✅ cierra" : ""}`,
  ];
  if (!cierra) {
    const difs = c.controles.diferencias.split(". ").filter(Boolean);
    lineas.push(`⚠️ *No cierra:*\n${difs.slice(0, 3).map((d) => `• ${d}`).join("\n")}${difs.length > 3 ? `\n• y ${difs.length - 3} más` : ""}`);
  }
  if (c.dudas.length) lineas.push(`❓ ${c.dudas.slice(0, 3).join(" · ")}`);
  return lineas.join("\n");
}
