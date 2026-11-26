import { DateTime } from "luxon";
import type { EstadoPago, FrecuenciaPago } from "../db/schema.js";

// Reglas de Pagos sin base de datos (se prueban solas): en qué meses toca cada pago, cuánto se espera, el estado, las
// alertas del mes y el CSV para el contador.

export type Moneda = "ARS" | "USD";
/** Cada parte que se pagó. */
export type ParteDePago = { monto: number; fecha: string };

/** Cada cuántos meses (0 = una sola vez). */
export const MESES_DE: Record<FrecuenciaPago, number> = { mensual: 1, bimestral: 2, trimestral: 3, cuatrimestral: 4, semestral: 6, anual: 12, unica: 0 };

export const CATEGORIAS = [
  "Alquiler",
  "Servicios",
  "Impuestos y tasas",
  "Sueldos y cargas",
  "Expensas",
  "Seguros",
  "Honorarios",
  "Préstamos y cuotas",
  "Tarjetas",
  "Suscripciones",
  "Otros",
];

export const MEDIOS = ["Transferencia", "Efectivo", "Débito automático", "Mercado Pago", "Tarjeta de crédito"];

/** "2026-11" de una fecha "2026-11-26". */
export const periodoDe = (fecha: string) => fecha.slice(0, 7);
export const sumarMeses = (periodo: string, n: number) => DateTime.fromISO(`${periodo}-01`).plus({ months: n }).toFormat("yyyy-MM");
const mesesEntre = (desde: string, hasta: string) => {
  const [a, m] = desde.split("-").map(Number);
  const [b, n] = hasta.split("-").map(Number);
  return (b - a) * 12 + (n - m);
};
/** "noviembre 2026". */
export const nombreMes = (periodo: string) => DateTime.fromISO(`${periodo}-01`).setLocale("es").toFormat("LLLL yyyy");

/** Si el pago fijo toca ese mes según su frecuencia (cuenta desde su primer mes). */
export function tocaEnMes(f: { frecuencia: FrecuenciaPago; desde: string }, periodo: string): boolean {
  const n = mesesEntre(f.desde, periodo);
  if (n < 0) return false;
  const cada = MESES_DE[f.frecuencia];
  return cada === 0 ? n === 0 : n % cada === 0;
}

/** La fecha de vencimiento en ese mes (si el día no existe, el último del mes: el 31 en noviembre es el 30). */
export function venceEn(dia: number, periodo: string): string {
  const inicio = DateTime.fromISO(`${periodo}-01`);
  return inicio.set({ day: Math.min(Math.max(1, dia), inicio.daysInMonth!) }).toISODate()!;
}

/** Lo que se espera pagar: el fijo; el variable, el promedio de los últimos 3 meses pagados (o el estimado). */
export function esperadoDe(f: { monto: number; variable: boolean }, anteriores: number[]): number {
  const ultimos = anteriores.filter((m) => m > 0).slice(-3);
  if (!f.variable || !ultimos.length) return f.monto;
  return Math.round(ultimos.reduce((s, m) => s + m, 0) / ultimos.length);
}

export const totalPagado = (pagos: ParteDePago[]) => pagos.reduce((s, p) => s + p.monto, 0);

/** Pagado si cubre lo esperado (o si no había monto y se pagó algo), en parte si no llega. */
export function estadoDe(esperado: number, pagos: ParteDePago[]): Exclude<EstadoPago, "omitido"> {
  const pagado = totalPagado(pagos);
  if (!pagos.length) return "pendiente";
  return pagado + 0.5 >= esperado ? "pagado" : "parcial";
}

// ───────────── Alertas del mes (sin IA: salen de los números) ─────────────

export type ItemAlerta = { nombre: string; lugar: string; moneda: Moneda; monto: number; vence: string; estado: EstadoPago; promedioAnterior: number | null };

/** Sube más que esto respecto del promedio: se avisa. */
const SUBA_MINIMA = 0.25;

export function alertasDelMes(items: ItemAlerta[], hoy: string, totalAnterior: { ARS: number; USD: number } | null): string[] {
  const alertas: string[] = [];
  const vencidos = items.filter((i) => (i.estado === "pendiente" || i.estado === "parcial") && i.vence < hoy);
  if (vencidos.length)
    alertas.push(
      `${vencidos.length === 1 ? "Venció sin pagar" : `Vencieron sin pagar ${vencidos.length}`}: ${vencidos
        .slice(0, 4)
        .map((v) => `${v.nombre} · ${v.lugar} (${DateTime.fromISO(v.vence).toFormat("dd/MM")})`)
        .join(", ")}${vencidos.length > 4 ? "…" : ""}.`,
    );
  for (const i of items) {
    if (!i.promedioAnterior || i.estado === "omitido") continue;
    const suba = (i.monto - i.promedioAnterior) / i.promedioAnterior;
    if (suba >= SUBA_MINIMA) alertas.push(`${i.nombre} · ${i.lugar} viene ${Math.round(suba * 100)} % más que el promedio de los meses anteriores.`);
  }
  if (totalAnterior?.ARS) {
    const actual = items.filter((i) => i.moneda === "ARS" && i.estado !== "omitido").reduce((s, i) => s + i.monto, 0);
    const dif = (actual - totalAnterior.ARS) / totalAnterior.ARS;
    if (Math.abs(dif) >= 0.1) alertas.push(`El mes viene ${Math.round(Math.abs(dif) * 100)} % ${dif > 0 ? "arriba" : "abajo"} del anterior.`);
  }
  return alertas;
}

// ───────────── CSV para el contador ─────────────

export type FilaCsv = { periodo: string; vence: string; lugar: string; tipo: string; categoria: string; nombre: string; moneda: Moneda; esperado: number; pagado: number; estado: EstadoPago; pagadoEn: string | null; medio: string; nota: string };

const ESTADOS: Record<EstadoPago, string> = { pendiente: "Pendiente", parcial: "Pagado en parte", pagado: "Pagado", omitido: "No se pagó este mes" };

/** CSV que Excel abre bien en Argentina: punto y coma, coma decimal y BOM (para las tildes). */
export function aCsv(filas: FilaCsv[]): string {
  const celda = (v: string | number) => {
    const t = typeof v === "number" ? v.toFixed(2).replace(".", ",") : v;
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const fecha = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "");
  const encabezado = ["Mes", "Vence", "Lugar", "Tipo", "Categoría", "Pago", "Moneda", "Esperado", "Pagado", "Estado", "Pagado el", "Medio", "Nota"];
  const lineas = filas.map((f) =>
    [f.periodo, fecha(f.vence), f.lugar, f.tipo, f.categoria, f.nombre, f.moneda, f.esperado, f.pagado, ESTADOS[f.estado], fecha(f.pagadoEn), f.medio, f.nota].map(celda).join(";"),
  );
  return `﻿${[encabezado.join(";"), ...lineas].join("\r\n")}\r\n`;
}
