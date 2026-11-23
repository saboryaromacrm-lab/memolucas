import { DateTime } from "luxon";
import type { Configuracion } from "../db/schema.js";
import { ahora, parseHora, zona } from "../lib/fechas.js";
import { postergarPorSilencio } from "./disparador.js";
import { enviador } from "./enviador.js";

// Lo común a los avisos de vencimientos (suscripciones, tarjetas): fechas "AAAA-MM-DD" en la zona de la app.

export const diaDe = (fecha: string) => DateTime.fromISO(fecha, { zone: zona() }).setLocale("es");

/** Días que faltan: 0 = hoy, negativo = ya pasó. */
export const diasParaVencer = (fecha: string) => Math.round(diaDe(fecha).diff(ahora().startOf("day"), "days").days);

/** El aviso de una fecha, N días antes, a la hora por defecto. */
export const momentoAviso = (fecha: string, diasAntes: number, cfg: Configuracion) =>
  diaDe(fecha).minus({ days: diasAntes }).set({ ...parseHora(cfg.horaDefecto), second: 0, millisecond: 0 }).toJSDate();

/** Se puede avisar ahora: WhatsApp conectado y fuera del silencio (si no, se reintenta en el próximo barrido). */
export const sePuedeAvisar = (cfg: Configuracion) => enviador().conectado() && !postergarPorSilencio(new Date(), cfg);

/** "vence en 3 días (vie 28/11)", "vence hoy", "venció hace 2 días". */
export function cuandoVence(fechaVto: string): string {
  const dias = diasParaVencer(fechaVto);
  if (dias > 1) return `vence en ${dias} días (${diaDe(fechaVto).toFormat("ccc dd/MM")})`;
  if (dias === 1) return "vence mañana";
  if (dias === 0) return "vence hoy";
  return `venció hace ${-dias} ${dias === -1 ? "día" : "días"}`;
}
