import { DateTime } from "luxon";

let ZONA = "America/Argentina/Buenos_Aires";

export function fijarZona(zona: string) {
  if (DateTime.now().setZone(zona).isValid) ZONA = zona;
}
export const zona = () => ZONA;

export const ahora = () => DateTime.now().setZone(ZONA);
export const aLocal = (d: Date | string) =>
  (typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d)).setZone(ZONA);

/** "09:30" → { hour: 9, minute: 30 } */
export function parseHora(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return { hour: 9, minute: 0 };
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) };
}

const DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
export const nombreDia = (weekday: number) => DIAS[weekday - 1];

export const formatearHora = (d: DateTime) => d.toFormat("H:mm");
export const formatearFechaCorta = (d: DateTime) => d.toFormat("dd/MM");

/** "hoy a las 9:00", "mañana a las 9:00", "el viernes 24/10 a las 9:00". */
export function formatearCuando(fecha: Date, referencia: DateTime = ahora()): string {
  const d = aLocal(fecha);
  const dias = Math.round(d.startOf("day").diff(referencia.startOf("day"), "days").days);
  const hora = `a las ${formatearHora(d)}`;
  if (dias === 0) return `hoy ${hora}`;
  if (dias === 1) return `mañana ${hora}`;
  if (dias === -1) return `ayer ${hora}`;
  const anio = d.year !== referencia.year ? `/${d.year}` : "";
  return `el ${nombreDia(d.weekday)} ${formatearFechaCorta(d)}${anio} ${hora}`;
}

export type VentanaSilencio = { activo: boolean; desde: string; hasta: string; dias: number[] };

/** Si la fecha cae en el horario de silencio, devuelve cuándo termina; si no, null. */
export function finDeSilencio(fecha: Date, v: VentanaSilencio): Date | null {
  if (!v.activo) return null;
  const t = aLocal(fecha);
  const desde = parseHora(v.desde);
  const hasta = parseHora(v.hasta);
  const minDesde = desde.hour * 60 + desde.minute;
  const minHasta = hasta.hour * 60 + hasta.minute;
  if (minDesde === minHasta) return null;
  const duracion = minHasta > minDesde ? minHasta - minDesde : 24 * 60 - minDesde + minHasta;
  // La ventana pertenece al día en que empieza: revisar la de hoy y la de ayer (cruza medianoche).
  for (const offset of [0, -1]) {
    const dia = t.plus({ days: offset }).startOf("day");
    if (!v.dias.includes(dia.weekday)) continue;
    const inicio = dia.set(desde);
    const fin = inicio.plus({ minutes: duracion });
    if (t >= inicio && t < fin) return fin.toJSDate();
  }
  return null;
}

/** Fecha local "hoy" en formato ISO (yyyy-MM-dd). */
export const hoyIso = () => ahora().toISODate()!;
