import { DateTime } from "luxon";
import { ahora, zona } from "./fechas";

/** Días que faltan para el vencimiento: 0 = hoy, negativo = venció. */
export const diasParaVencer = (fecha: string) => Math.round(DateTime.fromISO(fecha, { zone: zona() }).diff(ahora().startOf("day"), "days").days);

/** Color del vencimiento: rojo si venció o vence hoy, amarillo si vence pronto. */
export function colorVencimiento(dias: number, diasAviso: number) {
  if (dias <= 0) return "bg-red-50 text-red-700";
  if (dias <= diasAviso) return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

/** "Venció hace 2 días", "Vence hoy", "Vence mañana", "En 12 días". */
export function textoDias(dias: number) {
  if (dias < 0) return `Venció hace ${-dias} ${dias === -1 ? "día" : "días"}`;
  if (dias === 0) return "Vence hoy";
  if (dias === 1) return "Vence mañana";
  return `En ${dias} días`;
}
